/**
 * Per-task model contract — strict validation for dispatch-time model,
 * effort, profile, fallback chain, correlation IDs and tool capabilities.
 *
 * Sits in front of `resolveModelSpec`: a caller (chat orchestrator or DAG
 * executor) may attach a `ModelContract` to a task. This module validates
 * it against allowlists and produces a `ResolvedModelContract` carrying
 * BOTH the requested and the resolved model, so callers can record what
 * was asked for versus what actually ran.
 *
 * Design constraints:
 *   - Pure. No I/O, no logger, no side effects (mirrors model-validation).
 *   - Backward compatible. An absent contract resolves to the caller's
 *     existing defaults, so untouched call sites behave identically.
 *   - No prompt-only model selection. The resolved model is returned for
 *     the caller to pass to the real provider adapter; this module never
 *     "asks" a model to pretend to be another model.
 *   - Credentials are never read, stored or emitted.
 */

import {
  isEffortValidForProvider,
  isLiteralSpec,
  resolveModelSpec,
  type ResolvedAiProfile,
} from './model-validation';

/** Effort vocabulary accepted at the contract layer. */
export const CONTRACT_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type ContractEffort = (typeof CONTRACT_EFFORTS)[number];

/**
 * `max` is never selected implicitly. A profile or `auto` request may
 * reach `high`, but `max` requires `allowMaxEffort` from an explicit
 * user override.
 */
export const DEFAULT_EFFORT: ContractEffort = 'medium';
export const MAX_EFFORT: ContractEffort = 'max';

/** Named model profiles. None of them imply `max` effort. */
export const CONTRACT_PROFILES = ['premium', 'balanced', 'fast'] as const;
export type ContractProfile = (typeof CONTRACT_PROFILES)[number];

const PROFILE_EFFORT: Record<ContractProfile, ContractEffort> = {
  premium: 'high',
  balanced: 'medium',
  fast: 'low',
};

/** Longest accepted fallback chain — bounds retry amplification. */
export const MAX_FALLBACK_CHAIN = 4;

/** Correlation id shape: bounded, printable, no separators that would
 *  let an id smuggle structure into a log line. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Model reference shape accepted before profile resolution. Covers
 *  tiers (`large`), aliases (`@fast`) and literal ids
 *  (`claude-fable-5`, `claude-opus-4-8`). */
const MODEL_REF_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9./_-]{2,127}$/;

/**
 * Tool capabilities a task may be granted. Kept as an allowlist so a
 * malformed or hostile contract cannot widen a task's tool surface.
 */
export const TOOL_CAPABILITIES = [
  'filesystem.read',
  'filesystem.write',
  'shell.read',
  'shell.mutate',
  'browser.read',
  'network.read',
  'git.read',
  'git.write',
  'external.read',
  'external.write',
] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** Capabilities that can never be granted by a contract alone. */
export const APPROVAL_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
  'shell.mutate',
  'git.write',
  'external.write',
]);

/** The contract as supplied by a caller. Every field is optional; an
 *  empty contract is valid and means "use existing defaults". */
export interface ModelContract {
  requestedModel?: string;
  effort?: ContractEffort;
  profile?: ContractProfile;
  fallbackChain?: string[];
  runId?: string;
  taskId?: string;
  allowedToolCapabilities?: ToolCapability[];
  /** Explicit user override required to reach `max` effort. */
  allowMaxEffort?: boolean;
  /** Explicit approval required to grant mutating capabilities. */
  approvalReceiptId?: string;
}

/** The validated, resolved contract handed to the provider adapter. */
export interface ResolvedModelContract {
  requestedModel: string | null;
  resolvedModel: string | null;
  provider: string | null;
  profile: ContractProfile | null;
  effort: ContractEffort;
  fallbackChain: string[];
  runId: string | null;
  taskId: string | null;
  allowedToolCapabilities: ToolCapability[];
  notes: string[];
}

export class ModelContractError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ModelContractError';
    this.field = field;
  }
}

function assertString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelContractError(field, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateModelRef(field: string, value: unknown): string {
  const ref = assertString(field, value);
  if (!MODEL_REF_PATTERN.test(ref)) {
    throw new ModelContractError(
      field,
      `Unsupported model id '${ref}'. Expected a tier (small/medium/large), ` +
        `an @alias, or a provider model id such as 'claude-fable-5'.`
    );
  }
  return ref;
}

function validateCorrelationId(field: string, value: unknown): string {
  const id = assertString(field, value);
  if (!CORRELATION_ID_PATTERN.test(id)) {
    throw new ModelContractError(
      field,
      `${field} must be 1-128 chars of [A-Za-z0-9._-] starting alphanumeric`
    );
  }
  return id;
}

function validateProfile(value: unknown): ContractProfile {
  const profile = assertString('profile', value);
  if (!(CONTRACT_PROFILES as readonly string[]).includes(profile)) {
    throw new ModelContractError(
      'profile',
      `Unknown profile '${profile}'. Known profiles: ${CONTRACT_PROFILES.join(', ')}`
    );
  }
  return profile as ContractProfile;
}

function validateEffort(value: unknown, allowMax: boolean): ContractEffort {
  const effort = assertString('effort', value);
  if (!(CONTRACT_EFFORTS as readonly string[]).includes(effort)) {
    throw new ModelContractError(
      'effort',
      `Unknown effort '${effort}'. Known efforts: ${CONTRACT_EFFORTS.join(', ')}`
    );
  }
  if (effort === MAX_EFFORT && !allowMax) {
    throw new ModelContractError(
      'effort',
      `effort 'max' requires an explicit override (allowMaxEffort: true)`
    );
  }
  return effort as ContractEffort;
}

function validateCapabilities(
  value: unknown,
  approvalReceiptId: string | null
): ToolCapability[] {
  if (!Array.isArray(value)) {
    throw new ModelContractError(
      'allowedToolCapabilities',
      'allowedToolCapabilities must be an array'
    );
  }
  const out: ToolCapability[] = [];
  for (const raw of value) {
    const capability = assertString('allowedToolCapabilities', raw);
    if (!(TOOL_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new ModelContractError(
        'allowedToolCapabilities',
        `Unknown tool capability '${capability}'`
      );
    }
    if (APPROVAL_ONLY_CAPABILITIES.has(capability) && approvalReceiptId === null) {
      throw new ModelContractError(
        'allowedToolCapabilities',
        `Capability '${capability}' requires an approvalReceiptId`
      );
    }
    if (!out.includes(capability as ToolCapability)) {
      out.push(capability as ToolCapability);
    }
  }
  return out;
}

function validateFallbackChain(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ModelContractError('fallbackChain', 'fallbackChain must be an array');
  }
  if (value.length > MAX_FALLBACK_CHAIN) {
    throw new ModelContractError(
      'fallbackChain',
      `fallbackChain may hold at most ${MAX_FALLBACK_CHAIN} entries`
    );
  }
  const out: string[] = [];
  for (const raw of value) {
    const ref = validateModelRef('fallbackChain', raw);
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * Validate a raw contract. Throws `ModelContractError` naming the
 * offending field; never partially applies.
 */
export function validateModelContract(input: unknown): ModelContract {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelContractError('contract', 'model contract must be an object');
  }

  const raw = input as Record<string, unknown>;
  const contract: ModelContract = {};

  if (raw.allowMaxEffort !== undefined) {
    if (typeof raw.allowMaxEffort !== 'boolean') {
      throw new ModelContractError('allowMaxEffort', 'allowMaxEffort must be a boolean');
    }
    contract.allowMaxEffort = raw.allowMaxEffort;
  }

  if (raw.approvalReceiptId !== undefined) {
    contract.approvalReceiptId = validateCorrelationId(
      'approvalReceiptId',
      raw.approvalReceiptId
    );
  }

  if (raw.requestedModel !== undefined) {
    contract.requestedModel = validateModelRef('requestedModel', raw.requestedModel);
  }
  if (raw.profile !== undefined) {
    contract.profile = validateProfile(raw.profile);
  }
  if (raw.effort !== undefined) {
    contract.effort = validateEffort(raw.effort, contract.allowMaxEffort === true);
  }
  if (raw.fallbackChain !== undefined) {
    contract.fallbackChain = validateFallbackChain(raw.fallbackChain);
  }
  if (raw.runId !== undefined) {
    contract.runId = validateCorrelationId('runId', raw.runId);
  }
  if (raw.taskId !== undefined) {
    contract.taskId = validateCorrelationId('taskId', raw.taskId);
  }
  if (raw.allowedToolCapabilities !== undefined) {
    contract.allowedToolCapabilities = validateCapabilities(
      raw.allowedToolCapabilities,
      contract.approvalReceiptId ?? null
    );
  }

  return contract;
}

export interface ResolveModelContractOptions {
  /** Model used when the contract names none — the caller's existing default. */
  defaultModel?: string;
  /** Provider used for literal model ids. */
  fallbackProvider?: string;
}

/**
 * Resolve a validated contract against the install's AI profile.
 *
 * Returns both `requestedModel` (what the caller asked for) and
 * `resolvedModel` (what the provider will actually be given). When the
 * contract is empty and no default is supplied, both are `null` and the
 * caller's pre-existing resolution path is untouched.
 */
export function resolveModelContract(
  profile: ResolvedAiProfile,
  input: unknown,
  options: ResolveModelContractOptions = {}
): ResolvedModelContract {
  const contract = validateModelContract(input);
  const notes: string[] = [];

  const contractProfile = contract.profile ?? null;

  let effort: ContractEffort;
  if (contract.effort !== undefined) {
    effort = contract.effort;
  } else if (contractProfile !== null) {
    effort = PROFILE_EFFORT[contractProfile];
    notes.push(`effort ${effort} derived from profile ${contractProfile}`);
  } else {
    effort = DEFAULT_EFFORT;
  }

  if (effort === MAX_EFFORT && contract.allowMaxEffort !== true) {
    // Defence in depth: validation already rejects this path.
    throw new ModelContractError('effort', `effort 'max' requires an explicit override`);
  }

  const requestedModel = contract.requestedModel ?? options.defaultModel ?? null;

  if (requestedModel === null) {
    return {
      requestedModel: null,
      resolvedModel: null,
      provider: null,
      profile: contractProfile,
      effort,
      fallbackChain: contract.fallbackChain ?? [],
      runId: contract.runId ?? null,
      taskId: contract.taskId ?? null,
      allowedToolCapabilities: contract.allowedToolCapabilities ?? [],
      notes,
    };
  }

  const spec = resolveModelSpec(profile, requestedModel);
  const resolvedModel = isLiteralSpec(spec) ? spec.literal : spec.model;
  const provider = isLiteralSpec(spec)
    ? (options.fallbackProvider ?? profile.defaultProvider)
    : spec.provider;

  if (!isEffortValidForProvider(provider, effort)) {
    throw new ModelContractError(
      'effort',
      `effort '${effort}' is not valid for provider '${provider}'`
    );
  }

  if (resolvedModel !== requestedModel) {
    notes.push(`requested ${requestedModel} resolved to ${resolvedModel}`);
  }

  return {
    requestedModel,
    resolvedModel,
    provider,
    profile: contractProfile,
    effort,
    fallbackChain: contract.fallbackChain ?? [],
    runId: contract.runId ?? null,
    taskId: contract.taskId ?? null,
    allowedToolCapabilities: contract.allowedToolCapabilities ?? [],
    notes,
  };
}

/**
 * Metadata safe to persist alongside a task record. Contains no
 * credentials, no prompt content and no environment values.
 */
export function modelContractMetadata(
  resolved: ResolvedModelContract
): Record<string, unknown> {
  return {
    requested_model: resolved.requestedModel,
    resolved_model: resolved.resolvedModel,
    provider: resolved.provider,
    profile: resolved.profile,
    effort: resolved.effort,
    fallback_chain: resolved.fallbackChain,
    run_id: resolved.runId,
    task_id: resolved.taskId,
    allowed_tool_capabilities: resolved.allowedToolCapabilities,
    notes: resolved.notes,
  };
}
