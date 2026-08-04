/**
 * Storage for bounded-canary receipts.
 *
 * KEYING. A receipt is addressed by `(external_run_id, external_task_id,
 * contract_digest)` — the caller's own identifiers plus a digest of the exact
 * contract they submitted. That triple is what makes submission idempotent:
 * re-submitting the same contract returns the existing receipt instead of
 * starting a second billed run, while a CHANGED contract for the same task
 * cannot silently reuse an older run's numbers.
 *
 * PRINCIPAL. Every row records the authenticated client that created it, and
 * every read is filtered on it. A caller therefore cannot read a receipt
 * belonging to another principal — not even one whose run/task ids they guess.
 *
 * NULLS ARE MEANINGFUL. Aggregate columns stay NULL when a dispatch produced no
 * terminal aggregate. Writing 0 would read as "this run cost nothing", which is
 * the exact misreport the contract exists to prevent.
 *
 * NON-encrypted: nothing here is a secret. `errors` carries SDK error strings
 * and refusal reasons, which the runner is responsible for keeping free of
 * credentials (see `redactForReceipt`).
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import type {
  CanaryReceipt,
  CanaryReceiptState,
  CanaryReservation,
  CanaryTerminalReason,
  CanaryUsage,
} from '../canary/contract';
import { CANARY_CONTRACT_VERSION } from '../canary/contract';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.canary-receipts');
  return cachedLog;
}

/** Raw row shape. JSON columns arrive as TEXT on both dialects. */
interface CanaryReceiptRow {
  contract_version: string;
  external_run_id: string;
  external_task_id: string;
  contract_digest: string;
  principal: string;
  state: string;
  reason: string | null;
  requested_model: string;
  model: string | null;
  usage: string | null;
  model_usage: string | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  sdk_subtype: string | null;
  stop_reason: string | null;
  errors: string | null;
  reservation: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Natural key of a receipt. All three parts are required for any lookup. */
export interface CanaryReceiptKey {
  externalRunId: string;
  externalTaskId: string;
  contractDigest: string;
}

/** Terminal aggregate to settle a receipt with. */
export interface CanaryTerminalWrite {
  reason: CanaryTerminalReason;
  model?: string;
  usage?: CanaryUsage;
  modelUsage?: Record<string, unknown>;
  numTurns?: number;
  totalCostUsd?: number;
  sdkSubtype?: string;
  stopReason?: string;
  errors?: string[];
}

function parseJsonColumn(key: string, column: string, raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A corrupt column must not make the receipt unreadable — the caller still
    // needs its state and reason to settle. Log loudly and treat as absent.
    getLog().error({ err: err as Error, key, column }, 'db.canary_receipt_parse_failed');
    return undefined;
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToReceipt(row: CanaryReceiptRow): CanaryReceipt {
  const key = `${row.external_run_id}/${row.external_task_id}`;
  const usage = parseJsonColumn(key, 'usage', row.usage) as CanaryUsage | undefined;
  const modelUsage = parseJsonColumn(key, 'model_usage', row.model_usage) as
    | Record<string, unknown>
    | undefined;
  const errors = parseJsonColumn(key, 'errors', row.errors) as string[] | undefined;
  const reservation = parseJsonColumn(key, 'reservation', row.reservation) as
    | CanaryReservation
    | undefined;

  if (!reservation) {
    // The reservation column is NOT NULL and is written at insert time, so an
    // unparseable one means the row is corrupt. Throwing beats returning a
    // receipt with no reservation, which a caller might settle against.
    throw new Error(`Canary receipt ${key} has an unreadable reservation column`);
  }

  return {
    contract_version: CANARY_CONTRACT_VERSION,
    external_run_id: row.external_run_id,
    external_task_id: row.external_task_id,
    contract_digest: row.contract_digest,
    state: row.state as CanaryReceiptState,
    ...(row.reason ? { reason: row.reason as CanaryTerminalReason } : {}),
    requested_model: row.requested_model,
    ...(row.model ? { model: row.model } : {}),
    ...(usage ? { usage } : {}),
    ...(modelUsage ? { model_usage: modelUsage } : {}),
    ...(row.num_turns !== null ? { num_turns: row.num_turns } : {}),
    ...(row.total_cost_usd !== null ? { total_cost_usd: row.total_cost_usd } : {}),
    ...(row.sdk_subtype ? { sdk_subtype: row.sdk_subtype } : {}),
    ...(row.stop_reason ? { stop_reason: row.stop_reason } : {}),
    ...(errors?.length ? { errors } : {}),
    reservation,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

const SELECT_COLUMNS = `contract_version, external_run_id, external_task_id, contract_digest,
   principal, state, reason, requested_model, model, usage, model_usage, num_turns,
   total_cost_usd, sdk_subtype, stop_reason, errors, reservation, created_at, updated_at`;

/**
 * Create the `pending` row for a submission, or return the existing receipt if
 * this exact contract was already submitted.
 *
 * `created` distinguishes the two so the caller knows whether to start a run.
 * The insert is a single `ON CONFLICT DO NOTHING` statement rather than a
 * check-then-insert, so two concurrent submissions of the same contract cannot
 * both start a run — exactly one wins the insert and the other reads the row.
 */
export async function createPendingCanaryReceipt(params: {
  key: CanaryReceiptKey;
  principal: string;
  requestedModel: string;
  reservation: CanaryReservation;
}): Promise<{ created: boolean; receipt: CanaryReceipt }> {
  const { key, principal, requestedModel, reservation } = params;
  const dialect = getDialect();
  const id = dialect.generateUuid();

  let inserted: { rowCount?: number | null };
  try {
    inserted = await pool.query(
      `INSERT INTO remote_agent_canary_receipts
         (id, contract_version, external_run_id, external_task_id, contract_digest,
          principal, state, requested_model, reservation)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       ON CONFLICT (external_run_id, external_task_id, contract_digest) DO NOTHING`,
      [
        id,
        CANARY_CONTRACT_VERSION,
        key.externalRunId,
        key.externalTaskId,
        key.contractDigest,
        principal,
        requestedModel,
        JSON.stringify(reservation),
      ]
    );
  } catch (err) {
    getLog().error({ err: err as Error, key }, 'db.canary_receipt_insert_failed');
    throw err;
  }

  // Read back unconditionally: the row exists either way, and re-reading is the
  // only way to return the WINNER's receipt rather than the loser's local view.
  const existing = await getCanaryReceiptForPrincipal(key, principal);
  if (!existing) {
    throw new Error(
      `Canary receipt ${key.externalRunId}/${key.externalTaskId} vanished immediately after insert`
    );
  }

  // `rowCount` is 0 exactly when ON CONFLICT suppressed the insert. Both
  // adapters report it for writes (Postgres natively; the SQLite adapter maps
  // `result.changes`), so this is the authoritative did-I-create-it signal.
  const created = (inserted.rowCount ?? 0) > 0;
  return { created, receipt: existing };
}

/**
 * Read a receipt by its full key, scoped to a principal.
 *
 * Returns undefined both when no such receipt exists AND when it belongs to a
 * different principal — the caller cannot distinguish the two, so a wrong
 * principal cannot be used to probe for the existence of another's task.
 */
export async function getCanaryReceiptForPrincipal(
  key: CanaryReceiptKey,
  principal: string
): Promise<CanaryReceipt | undefined> {
  const result = await pool.query<CanaryReceiptRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM remote_agent_canary_receipts
      WHERE external_run_id = $1 AND external_task_id = $2
        AND contract_digest = $3 AND principal = $4`,
    [key.externalRunId, key.externalTaskId, key.contractDigest, principal]
  );
  const row = result.rows[0];
  return row ? rowToReceipt(row) : undefined;
}

/**
 * Digests already recorded for a (run, task) under this principal.
 *
 * Used to refuse a second, DIFFERENT contract for a task that already has one:
 * silently running it would give the task two receipts and two charges under
 * one identifier, and the caller settling on either would be settling on half
 * the spend.
 */
export async function listCanaryDigestsForTask(
  externalRunId: string,
  externalTaskId: string,
  principal: string
): Promise<string[]> {
  const result = await pool.query<{ contract_digest: string }>(
    `SELECT contract_digest FROM remote_agent_canary_receipts
      WHERE external_run_id = $1 AND external_task_id = $2 AND principal = $3`,
    [externalRunId, externalTaskId, principal]
  );
  return result.rows.map(r => r.contract_digest);
}

/**
 * Settle a receipt with its terminal aggregate.
 *
 * Guarded on `state = 'pending'` so a terminal receipt is written exactly once:
 * a late deadline-abort racing a real SDK result cannot overwrite the aggregate
 * that actually arrived. Returns whether this call performed the write.
 */
export async function settleCanaryReceipt(
  key: CanaryReceiptKey,
  terminal: CanaryTerminalWrite
): Promise<boolean> {
  const dialect = getDialect();
  let result: { rowCount?: number | null };
  try {
    result = await pool.query(
      `UPDATE remote_agent_canary_receipts
          SET state = 'terminal',
              reason = $1,
              model = $2,
              usage = $3,
              model_usage = $4,
              num_turns = $5,
              total_cost_usd = $6,
              sdk_subtype = $7,
              stop_reason = $8,
              errors = $9,
              updated_at = ${dialect.now()}
        WHERE external_run_id = $10 AND external_task_id = $11
          AND contract_digest = $12 AND state = 'pending'`,
      [
        terminal.reason,
        terminal.model ?? null,
        terminal.usage ? JSON.stringify(terminal.usage) : null,
        terminal.modelUsage ? JSON.stringify(terminal.modelUsage) : null,
        terminal.numTurns ?? null,
        terminal.totalCostUsd ?? null,
        terminal.sdkSubtype ?? null,
        terminal.stopReason ?? null,
        terminal.errors?.length ? JSON.stringify(terminal.errors) : null,
        key.externalRunId,
        key.externalTaskId,
        key.contractDigest,
      ]
    );
  } catch (err) {
    getLog().error({ err: err as Error, key }, 'db.canary_receipt_settle_failed');
    throw err;
  }

  const settled = (result.rowCount ?? 0) > 0;
  if (!settled) {
    getLog().warn(
      { key, reason: terminal.reason },
      'db.canary_receipt_settle_skipped_already_terminal'
    );
  } else {
    getLog().info({ key, reason: terminal.reason }, 'db.canary_receipt_settle_completed');
  }
  return settled;
}
