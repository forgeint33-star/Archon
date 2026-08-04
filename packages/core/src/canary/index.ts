/**
 * Bounded canary execution mode — the Archon half of the canary usage contract.
 *
 * DISABLED BY DEFAULT. Nothing here runs unless `ARCHON_CANARY_MODE_ENABLED` is
 * explicitly set and a caller authenticates with a configured principal token
 * (see `./config`). No normal Archon path imports this module.
 */
export {
  CANARY_CONTRACT_VERSION,
  CANARY_MAX_OUTPUT_BYTES,
  CANARY_OUTPUT_CONTENT_TYPE,
  canaryOutputSchema,
  canaryRequestSchema,
  canaryReceiptSchema,
  canaryReceiptStateSchema,
  canaryReservationSchema,
  canaryTerminalReasonSchema,
  canaryUsageSchema,
  canaryTerminalStatusSchema,
  canonicalJson,
  canonicalRequestIdentity,
  contractDigest,
  describeCanaryOutput,
  findReceiptOutputViolations,
  terminalStatusForReason,
} from './contract';
export type {
  CanaryCanonicalIdentity,
  CanaryOutput,
  CanaryReceipt,
  CanaryReceiptState,
  CanaryRequest,
  CanaryReservation,
  CanaryTerminalReason,
  CanaryTerminalStatus,
  CanaryUsage,
} from './contract';

export {
  MODEL_BOUNDS,
  computeWorstCase,
  estimateTokens,
  getModelBounds,
  listPriceableModels,
} from './model-bounds';
export type { ModelBounds, WorstCaseInput, WorstCaseResult } from './model-bounds';

export {
  CanaryRefusedError,
  admitCanaryRequest,
  buildBoundedOptions,
  classifyTerminalReason,
  executeCanaryRun,
  governSuccessOutput,
  measureEffectivePrompt,
  redactForReceipt,
  submitCanaryRun,
} from './runner';
export type { CanaryRunnerDeps, CanarySubmitResult, EffectivePrompt } from './runner';

export { isCanaryModeEnabled, resolveCanaryPrincipal, loadCanaryPrincipals } from './config';

export {
  createPendingCanaryReceipt,
  getCanaryReceiptForPrincipal,
  listCanaryDigestsForTask,
  settleCanaryReceipt,
} from '../db/canary-receipts';
export type { CanaryReceiptKey, CanaryTerminalWrite } from '../db/canary-receipts';
