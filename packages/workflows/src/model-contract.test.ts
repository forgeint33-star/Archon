import { describe, test, expect } from 'bun:test';
import {
  APPROVAL_ONLY_CAPABILITIES,
  MAX_FALLBACK_CHAIN,
  ModelContractError,
  modelContractMetadata,
  resolveModelContract,
  validateModelContract,
} from './model-contract';
import type { ResolvedAiProfile } from './model-validation';

const profile: ResolvedAiProfile = {
  defaultProvider: 'claude',
  aliases: {
    large: { provider: 'claude', model: 'claude-opus-4-8' },
    medium: { provider: 'claude', model: 'claude-sonnet-5' },
    small: { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
    '@fable': { provider: 'claude', model: 'claude-fable-5' },
    '@codex': { provider: 'codex', model: 'gpt-5' },
  },
};

describe('validateModelContract', () => {
  test('an absent contract is valid and empty', () => {
    expect(validateModelContract(undefined)).toEqual({});
    expect(validateModelContract(null)).toEqual({});
  });

  test('rejects a non-object contract', () => {
    expect(() => validateModelContract([])).toThrow(ModelContractError);
    expect(() => validateModelContract('large')).toThrow(ModelContractError);
  });

  test('accepts a full valid contract', () => {
    const contract = validateModelContract({
      requestedModel: 'claude-fable-5',
      effort: 'high',
      profile: 'premium',
      fallbackChain: ['large', 'medium'],
      runId: 'run-123',
      taskId: 'task-456',
      allowedToolCapabilities: ['filesystem.read'],
    });
    expect(contract.requestedModel).toBe('claude-fable-5');
    expect(contract.effort).toBe('high');
    expect(contract.profile).toBe('premium');
    expect(contract.fallbackChain).toEqual(['large', 'medium']);
  });

  test('rejects an unsupported model id clearly', () => {
    try {
      validateModelContract({ requestedModel: 'not a model!!' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelContractError);
      expect((error as ModelContractError).field).toBe('requestedModel');
      expect((error as Error).message).toContain('Unsupported model id');
    }
  });

  test('rejects an unknown profile', () => {
    expect(() => validateModelContract({ profile: 'ultra' })).toThrow(
      /Unknown profile/
    );
  });

  test('rejects an unknown effort', () => {
    expect(() => validateModelContract({ effort: 'extreme' })).toThrow(
      /Unknown effort/
    );
  });

  test('max effort requires an explicit override', () => {
    expect(() => validateModelContract({ effort: 'max' })).toThrow(
      /requires an explicit override/
    );
    const contract = validateModelContract({
      effort: 'max',
      allowMaxEffort: true,
    });
    expect(contract.effort).toBe('max');
  });

  test('bounds the fallback chain', () => {
    const chain = Array.from({ length: MAX_FALLBACK_CHAIN + 1 }, (_, i) => `model-${i}`);
    expect(() => validateModelContract({ fallbackChain: chain })).toThrow(
      /at most/
    );
  });

  test('deduplicates the fallback chain', () => {
    const contract = validateModelContract({
      fallbackChain: ['large', 'large', 'medium'],
    });
    expect(contract.fallbackChain).toEqual(['large', 'medium']);
  });

  test('rejects malformed correlation ids', () => {
    expect(() => validateModelContract({ runId: '../etc/passwd' })).toThrow(
      ModelContractError
    );
    expect(() => validateModelContract({ taskId: '' })).toThrow(ModelContractError);
  });

  test('rejects unknown tool capabilities', () => {
    expect(() =>
      validateModelContract({ allowedToolCapabilities: ['launch.rockets'] })
    ).toThrow(/Unknown tool capability/);
  });

  test('mutating capabilities require an approval receipt', () => {
    for (const capability of APPROVAL_ONLY_CAPABILITIES) {
      expect(() =>
        validateModelContract({ allowedToolCapabilities: [capability] })
      ).toThrow(/requires an approvalReceiptId/);
    }
    const contract = validateModelContract({
      allowedToolCapabilities: ['external.write'],
      approvalReceiptId: 'appr-1',
    });
    expect(contract.allowedToolCapabilities).toEqual(['external.write']);
  });
});

describe('resolveModelContract', () => {
  test('an empty contract preserves existing behaviour', () => {
    const resolved = resolveModelContract(profile, undefined);
    expect(resolved.requestedModel).toBeNull();
    expect(resolved.resolvedModel).toBeNull();
    expect(resolved.effort).toBe('medium');
  });

  test('falls back to the caller default model', () => {
    const resolved = resolveModelContract(profile, {}, { defaultModel: 'large' });
    expect(resolved.requestedModel).toBe('large');
    expect(resolved.resolvedModel).toBe('claude-opus-4-8');
  });

  test('returns both requested and resolved model for a tier', () => {
    const resolved = resolveModelContract(profile, { requestedModel: 'large' });
    expect(resolved.requestedModel).toBe('large');
    expect(resolved.resolvedModel).toBe('claude-opus-4-8');
    expect(resolved.provider).toBe('claude');
    expect(resolved.notes.join(' ')).toContain('resolved to');
  });

  test('resolves the fable alias', () => {
    const resolved = resolveModelContract(profile, { requestedModel: '@fable' });
    expect(resolved.resolvedModel).toBe('claude-fable-5');
  });

  test('passes a literal full model id straight through', () => {
    const resolved = resolveModelContract(profile, {
      requestedModel: 'claude-fable-5',
    });
    expect(resolved.requestedModel).toBe('claude-fable-5');
    expect(resolved.resolvedModel).toBe('claude-fable-5');
    expect(resolved.provider).toBe('claude');
  });

  test('opus id is configurable through the profile', () => {
    const custom: ResolvedAiProfile = {
      defaultProvider: 'claude',
      aliases: {
        ...profile.aliases,
        large: { provider: 'claude', model: 'claude-opus-4-9' },
      },
    };
    const resolved = resolveModelContract(custom, { requestedModel: 'large' });
    expect(resolved.resolvedModel).toBe('claude-opus-4-9');
  });

  test('rejects an unknown alias with a clear message', () => {
    expect(() =>
      resolveModelContract(profile, { requestedModel: '@nope' })
    ).toThrow(/Unknown alias/);
  });

  test('profile derives effort and never reaches max', () => {
    expect(resolveModelContract(profile, { profile: 'premium' }).effort).toBe('high');
    expect(resolveModelContract(profile, { profile: 'balanced' }).effort).toBe(
      'medium'
    );
    expect(resolveModelContract(profile, { profile: 'fast' }).effort).toBe('low');
  });

  test('rejects effort invalid for the resolved provider', () => {
    // 'max' is a Claude effort; codex uses a different vocabulary.
    expect(() =>
      resolveModelContract(profile, {
        requestedModel: '@codex',
        effort: 'max',
        allowMaxEffort: true,
      })
    ).toThrow(/not valid for provider/);
  });

  test('carries correlation ids and capabilities through', () => {
    const resolved = resolveModelContract(profile, {
      requestedModel: 'medium',
      runId: 'run-1',
      taskId: 'task-1',
      allowedToolCapabilities: ['filesystem.read', 'git.read'],
    });
    expect(resolved.runId).toBe('run-1');
    expect(resolved.taskId).toBe('task-1');
    expect(resolved.allowedToolCapabilities).toEqual([
      'filesystem.read',
      'git.read',
    ]);
  });
});

describe('modelContractMetadata', () => {
  test('emits snake_case metadata without secrets', () => {
    const resolved = resolveModelContract(profile, {
      requestedModel: 'large',
      runId: 'run-9',
    });
    const metadata = modelContractMetadata(resolved);
    expect(metadata.requested_model).toBe('large');
    expect(metadata.resolved_model).toBe('claude-opus-4-8');
    expect(metadata.run_id).toBe('run-9');
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('ANTHROPIC');
    expect(serialized).not.toContain('api_key');
  });
});
