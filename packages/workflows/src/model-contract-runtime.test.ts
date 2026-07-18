import { describe, expect, test } from 'bun:test';
import { resolveModelContract, modelContractMetadata } from './model-contract';
import type { ResolvedModelContract } from './model-contract';
import type { ResolvedAiProfile } from './model-validation';
import {
  CAPABILITY_TOOLS,
  contractAllowedTools,
  contractRequestOverrides,
} from './model-contract-runtime';

/** Mirrors the profile shape used by model-contract.test.ts. */
const profile: ResolvedAiProfile = {
  defaultProvider: 'claude',
  aliases: {
    large: { provider: 'claude', model: 'claude-opus-4-8' },
    medium: { provider: 'claude', model: 'claude-sonnet-5' },
    small: { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
    '@opus': { provider: 'claude', model: 'claude-opus-4-8' },
    '@fable': { provider: 'claude', model: 'claude-fable-5' },
  },
};

function resolve(input: unknown): ResolvedModelContract {
  return resolveModelContract(profile, input);
}

describe('contractAllowedTools', () => {
  test('returns undefined when no capability is granted', () => {
    expect(contractAllowedTools(resolve({}))).toBeUndefined();
  });

  test('never returns an empty array, which the SDK reads as a total ban', () => {
    const tools = contractAllowedTools(resolve({ allowedToolCapabilities: ['filesystem.read'] }));
    expect(tools).toBeDefined();
    expect(tools!.length).toBeGreaterThan(0);
  });

  test('grants only the tools the named capabilities map to', () => {
    const tools = contractAllowedTools(resolve({ allowedToolCapabilities: ['filesystem.read'] }))!;
    expect(tools).toContain('Read');
    expect(tools).toContain('Grep');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
  });

  test('keeps the always-allowed reporting tools', () => {
    const tools = contractAllowedTools(resolve({ allowedToolCapabilities: ['filesystem.read'] }))!;
    expect(tools).toContain('TodoWrite');
    expect(tools).toContain('Skill');
  });

  test('unions multiple capabilities without duplicates', () => {
    const tools = contractAllowedTools(
      resolve({ allowedToolCapabilities: ['filesystem.read', 'network.read'] })
    )!;
    expect(tools).toContain('Read');
    expect(tools).toContain('WebSearch');
    expect(new Set(tools).size).toBe(tools.length);
  });

  test('is deterministic', () => {
    const first = contractAllowedTools(
      resolve({ allowedToolCapabilities: ['network.read', 'filesystem.read'] })
    );
    const second = contractAllowedTools(
      resolve({ allowedToolCapabilities: ['filesystem.read', 'network.read'] })
    );
    expect(first).toEqual(second);
  });

  test('a mutating capability cannot be granted without an approval receipt', () => {
    expect(() => resolve({ allowedToolCapabilities: ['external.write'] })).toThrow();
  });

  test('a mutating capability with an approval receipt maps to real tools', () => {
    const tools = contractAllowedTools(
      resolve({
        allowedToolCapabilities: ['filesystem.write'],
        approvalReceiptId: 'appr-2026-07-18-001',
      })
    )!;
    expect(tools).toContain('Write');
  });

  test('every capability in the vocabulary has a tool mapping', () => {
    for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS)) {
      expect(tools.length, `${capability} maps to no tools`).toBeGreaterThan(0);
    }
  });
});

describe('contractRequestOverrides', () => {
  test('an empty contract sets no model, leaving the caller default intact', () => {
    const overrides = contractRequestOverrides(resolve({}));
    expect(overrides.model).toBeUndefined();
    expect(overrides.fallbackModel).toBeUndefined();
  });

  test('an empty contract still carries the default effort', () => {
    const overrides = contractRequestOverrides(resolve({}));
    expect(overrides.nodeConfig?.effort).toBe('medium');
  });

  test('resolves an alias to a real provider model id', () => {
    const overrides = contractRequestOverrides(resolve({ requestedModel: '@opus' }));
    expect(overrides.model).toBe('claude-opus-4-8');
  });

  test('passes a literal model id through', () => {
    const overrides = contractRequestOverrides(resolve({ requestedModel: 'claude-fable-5' }));
    expect(overrides.model).toBe('claude-fable-5');
  });

  test('carries the requested effort', () => {
    const overrides = contractRequestOverrides(
      resolve({ requestedModel: '@opus', effort: 'high' })
    );
    expect(overrides.nodeConfig?.effort).toBe('high');
  });

  test('takes the first fallback chain entry as the provider fallback model', () => {
    const overrides = contractRequestOverrides(
      resolve({ requestedModel: '@opus', fallbackChain: ['claude-sonnet-5', '@fable'] })
    );
    expect(overrides.fallbackModel).toBe('claude-sonnet-5');
  });

  test('threads the task id as the node correlation handle', () => {
    const overrides = contractRequestOverrides(
      resolve({ requestedModel: '@opus', taskId: 'task-42' })
    );
    expect(overrides.nodeConfig?.nodeId).toBe('task-42');
  });

  test('omits allowed_tools when no capability is named', () => {
    const overrides = contractRequestOverrides(resolve({ requestedModel: '@opus' }));
    expect(overrides.nodeConfig?.allowed_tools).toBeUndefined();
  });

  test('sets allowed_tools when capabilities are named', () => {
    const overrides = contractRequestOverrides(
      resolve({ requestedModel: '@opus', allowedToolCapabilities: ['filesystem.read'] })
    );
    expect(overrides.nodeConfig?.allowed_tools).toContain('Read');
  });

  test('projects onto the exact fields the provider adapter consumes', () => {
    const overrides = contractRequestOverrides(
      resolve({
        requestedModel: '@opus',
        effort: 'high',
        fallbackChain: ['claude-sonnet-5'],
        allowedToolCapabilities: ['filesystem.read'],
        taskId: 'task-7',
      })
    );
    // model / fallbackModel land on AgentRequestOptions; effort and
    // allowed_tools land on NodeConfig. No other field is invented.
    expect(Object.keys(overrides).sort()).toEqual(['fallbackModel', 'model', 'nodeConfig']);
  });
});

describe('metadata correlation', () => {
  test('requested and resolved models are both reported', () => {
    const metadata = modelContractMetadata(resolve({ requestedModel: '@opus' }));
    expect(metadata.requested_model).toBe('@opus');
    expect(metadata.resolved_model).toBe('claude-opus-4-8');
  });

  test('correlation ids survive resolution', () => {
    const metadata = modelContractMetadata(
      resolve({ requestedModel: '@opus', runId: 'run-1', taskId: 'task-1' })
    );
    expect(metadata.run_id).toBe('run-1');
    expect(metadata.task_id).toBe('task-1');
  });

  test('metadata carries no credential-shaped keys', () => {
    const metadata = modelContractMetadata(resolve({ requestedModel: '@opus' }));
    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['token', 'secret', 'api_key', 'apikey', 'password']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
