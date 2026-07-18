/**
 * Runtime projection of a resolved model contract.
 *
 * `model-contract.ts` is a pure validator/resolver: it decides *what* a
 * task is allowed to run as. This module turns that decision into the
 * concrete provider inputs Archon already understands —
 * `AgentRequestOptions.model` / `.fallbackModel` and `NodeConfig.effort` /
 * `.allowed_tools` — so a contract reaches the SDK through the same fields
 * a YAML node would use. Nothing here is advisory and nothing is phrased
 * into a prompt; the provider adapter consumes these fields directly.
 */
import type { NodeConfig } from '@archon/providers/types';
import type { ResolvedModelContract, ToolCapability } from './model-contract';

/**
 * Concrete tool names granted by each abstract capability.
 *
 * Deliberately narrow: a capability the contract does not name grants no
 * tools at all. `shell.mutate`, `git.write` and `external.write` still
 * require an approval receipt before `resolveModelContract` will place
 * them on the resolved contract, so reaching this map already implies
 * governance said yes.
 */
export const CAPABILITY_TOOLS: Readonly<Record<ToolCapability, readonly string[]>> = {
  'filesystem.read': ['Read', 'Glob', 'Grep'],
  'filesystem.write': ['Write', 'Edit', 'NotebookEdit'],
  'shell.read': ['Bash', 'TaskOutput'],
  'shell.mutate': ['Bash', 'TaskCreate', 'TaskStop', 'TaskUpdate'],
  'browser.read': ['WebFetch'],
  'network.read': ['WebFetch', 'WebSearch'],
  'git.read': ['Bash'],
  'git.write': ['Bash'],
  'external.read': ['WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
  'external.write': ['Bash', 'Write'],
};

/**
 * Tools every contracted task keeps regardless of capability grants.
 * Without these the agent cannot plan, ask, or use a skill, and a contract
 * naming only (say) `filesystem.read` would produce a task that cannot
 * report back. None of them touch the filesystem, shell or network.
 */
const ALWAYS_ALLOWED_TOOLS: readonly string[] = ['TodoWrite', 'AskUserQuestion', 'Skill'];

/**
 * Concrete `allowed_tools` for a resolved contract, or `undefined` when the
 * contract named no capabilities.
 *
 * `undefined` deliberately means "do not restrict" rather than "allow
 * nothing": an empty array reaches the SDK as a total tool ban, which would
 * silently break every existing call site that sends no contract.
 */
export function contractAllowedTools(resolved: ResolvedModelContract): string[] | undefined {
  if (resolved.allowedToolCapabilities.length === 0) return undefined;

  const tools = new Set<string>(ALWAYS_ALLOWED_TOOLS);
  for (const capability of resolved.allowedToolCapabilities) {
    for (const tool of CAPABILITY_TOOLS[capability] ?? []) {
      tools.add(tool);
    }
  }
  return [...tools].sort();
}

/** Options a resolved contract contributes to a provider request. */
export interface ContractRequestOverrides {
  model?: string;
  fallbackModel?: string;
  nodeConfig?: NodeConfig;
}

/**
 * Project a resolved contract onto provider request fields.
 *
 * Returns only the fields the contract actually determines, so a caller can
 * spread it over existing options without clobbering defaults that an empty
 * contract should leave alone.
 */
export function contractRequestOverrides(
  resolved: ResolvedModelContract
): ContractRequestOverrides {
  const overrides: ContractRequestOverrides = {};

  if (resolved.resolvedModel !== null) {
    overrides.model = resolved.resolvedModel;
  }
  // The provider takes a single fallback model; the remainder of the chain
  // stays on the contract metadata for operators and event consumers.
  if (resolved.fallbackChain.length > 0) {
    overrides.fallbackModel = resolved.fallbackChain[0];
  }

  const allowedTools = contractAllowedTools(resolved);
  const nodeConfig: NodeConfig = { effort: resolved.effort };
  if (allowedTools !== undefined) {
    nodeConfig.allowed_tools = allowedTools;
  }
  if (resolved.taskId !== null) {
    // Reuse the field Archon already carries for per-node correlation
    // rather than inventing a parallel identifier.
    nodeConfig.nodeId = resolved.taskId;
  }
  overrides.nodeConfig = nodeConfig;

  return overrides;
}
