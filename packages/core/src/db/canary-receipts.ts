/**
 * Storage for bounded-canary receipts (contract v2).
 *
 * KEYING. A receipt is addressed by `(principal, external_run_id,
 * external_task_id, contract_digest)` — WHO asked, what they called it, and a
 * digest of the exact contract. All four, because external ids belong to the
 * caller's own namespace: two unrelated callers using `run-1/task-1` is
 * ordinary, and v1's principal-free key made them collide into a single row.
 *
 * That quadruple is what makes submission idempotent per principal:
 * re-submitting the same contract returns the existing receipt instead of
 * starting a second billed run, a CHANGED contract for the same task cannot
 * silently reuse an older run's numbers, and a DIFFERENT principal gets its own
 * independent record.
 *
 * The principal is also folded into `contract_digest` itself, so the two
 * defences are independent: even a digest collision could not cross principals,
 * and even a mis-specified index could not either.
 *
 * PRINCIPAL SCOPING ON READ. Every read filters on the principal, so a caller
 * cannot read a receipt belonging to another — not even one whose run/task ids
 * they guess.
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
  CanaryTerminalStatus,
  CanaryUsage,
} from '../canary/contract';
import {
  CANARY_CONTRACT_VERSION,
  CANARY_OUTPUT_CONTENT_TYPE,
  findReceiptOutputViolations,
  terminalStatusForReason,
} from '../canary/contract';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.canary-receipts');
  return cachedLog;
}

/** Raw row shape. JSON columns arrive as TEXT on both dialects. */
interface CanaryReceiptRow {
  id: string;
  contract_version: string;
  external_run_id: string;
  external_task_id: string;
  contract_digest: string;
  principal: string;
  session_id: string | null;
  state: string;
  terminal_status: string | null;
  reason: string | null;
  terminal_at: string | Date | null;
  requested_model: string;
  resolved_model: string | null;
  declared_max_turns: number;
  actual_turns: number | null;
  usage: string | null;
  model_usage: string | null;
  total_cost_usd: number | null;
  output_available: number | boolean | null;
  output_text: string | null;
  output_bytes: number | null;
  output_sha256: string | null;
  output_content_type: string | null;
  sdk_subtype: string | null;
  stop_reason: string | null;
  errors: string | null;
  reservation: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Natural key of a receipt.
 *
 * The PRINCIPAL is part of it (v2). External run/task ids live in the caller's
 * own namespace, so two callers using `run-1/task-1` is ordinary — a key that
 * omitted the principal made those two collide into one row, which is the
 * defect v2 exists to close. Every lookup requires all four parts.
 */
export interface CanaryReceiptKey {
  principal: string;
  externalRunId: string;
  externalTaskId: string;
  contractDigest: string;
}

/** Terminal aggregate to settle a receipt with. */
export interface CanaryTerminalWrite {
  reason: CanaryTerminalReason;
  /** Model the SDK reported it RAN. */
  resolvedModel?: string;
  /** Provider conversation identity. */
  sessionId?: string;
  usage?: CanaryUsage;
  modelUsage?: Record<string, unknown>;
  /** Turns the SDK reported it USED (the declared ceiling is on the row already). */
  actualTurns?: number;
  /**
   * The governed deliverable, already validated and hashed by the runner.
   * Absent on every non-success path — the store never derives it, so there is
   * exactly one place (the runner) that can decide output exists.
   */
  output?: { text: string; bytes: number; sha256: string; contentType: string };
  totalCostUsd?: number;
  sdkSubtype?: string;
  stopReason?: string;
  errors?: string[];
}

/**
 * Log-safe view of a key. The principal NAME is not a secret (the token is, and
 * never reaches here), but the digest is long and noisy — trim it so log lines
 * stay readable while still distinguishing two contracts.
 */
function redactKey(key: CanaryReceiptKey): Record<string, string> {
  return {
    principal: key.principal,
    externalRunId: key.externalRunId,
    externalTaskId: key.externalTaskId,
    contractDigest: `${key.contractDigest.slice(0, 12)}…`,
  };
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

  const receipt: CanaryReceipt = {
    contract_version: CANARY_CONTRACT_VERSION,
    principal: row.principal,
    external_run_id: row.external_run_id,
    external_task_id: row.external_task_id,
    contract_digest: row.contract_digest,
    request_id: row.id,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    state: row.state as CanaryReceiptState,
    ...(row.terminal_status
      ? { terminal_status: row.terminal_status as CanaryTerminalStatus }
      : {}),
    ...(row.reason ? { reason: row.reason as CanaryTerminalReason } : {}),
    ...(row.terminal_at ? { terminal_at: toIso(row.terminal_at) } : {}),
    requested_model: row.requested_model,
    ...(row.resolved_model ? { resolved_model: row.resolved_model } : {}),
    declared_max_turns: row.declared_max_turns,
    ...(row.actual_turns !== null ? { actual_turns: row.actual_turns } : {}),
    ...(usage ? { usage } : {}),
    ...(modelUsage ? { model_usage: modelUsage } : {}),
    ...(row.total_cost_usd !== null ? { total_cost_usd: row.total_cost_usd } : {}),
    // SQLite has no boolean type, so the column round-trips as 0/1. NULL means
    // "pending" (no output block at all), which is distinct from 0.
    ...(row.output_available === null || row.output_available === undefined
      ? {}
      : { output_available: Boolean(row.output_available) }),
    ...(row.output_text !== null ? { output_text: row.output_text } : {}),
    ...(row.output_bytes !== null ? { output_bytes: row.output_bytes } : {}),
    ...(row.output_sha256 ? { output_sha256: row.output_sha256 } : {}),
    ...(row.output_content_type
      ? { output_content_type: row.output_content_type as typeof CANARY_OUTPUT_CONTENT_TYPE }
      : {}),
    ...(row.sdk_subtype ? { sdk_subtype: row.sdk_subtype } : {}),
    ...(row.stop_reason ? { stop_reason: row.stop_reason } : {}),
    ...(errors?.length ? { errors } : {}),
    reservation,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  // Fail closed on READ as well as on write. A row that claims success while
  // carrying no deliverable (or whose hash does not match its text) is corrupt,
  // and returning it would let a caller settle against an unverifiable outcome.
  // Mirrors the existing unreadable-reservation behaviour above.
  const violations = findReceiptOutputViolations(receipt);
  if (violations.length > 0) {
    getLog().error({ key, violations }, 'db.canary_receipt_output_invariant_violated');
    throw new Error(`Canary receipt ${key} violates its output contract: ${violations.join('; ')}`);
  }
  return receipt;
}

const SELECT_COLUMNS = `id, contract_version, external_run_id, external_task_id, contract_digest,
   principal, session_id, state, terminal_status, reason, terminal_at, requested_model,
   resolved_model, declared_max_turns, actual_turns, usage, model_usage, total_cost_usd,
   output_available, output_text, output_bytes, output_sha256, output_content_type,
   sdk_subtype, stop_reason, errors, reservation, created_at, updated_at`;

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
  requestedModel: string;
  declaredMaxTurns: number;
  reservation: CanaryReservation;
}): Promise<{ created: boolean; receipt: CanaryReceipt }> {
  const { key, requestedModel, declaredMaxTurns, reservation } = params;
  const dialect = getDialect();
  const id = dialect.generateUuid();

  let inserted: { rowCount?: number | null };
  try {
    inserted = await pool.query(
      `INSERT INTO remote_agent_canary_receipts
         (id, contract_version, external_run_id, external_task_id, contract_digest,
          principal, state, requested_model, declared_max_turns, reservation)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
       ON CONFLICT (principal, external_run_id, external_task_id, contract_digest) DO NOTHING`,
      [
        id,
        CANARY_CONTRACT_VERSION,
        key.externalRunId,
        key.externalTaskId,
        key.contractDigest,
        key.principal,
        requestedModel,
        declaredMaxTurns,
        JSON.stringify(reservation),
      ]
    );
  } catch (err) {
    getLog().error({ err: err as Error, key: redactKey(key) }, 'db.canary_receipt_insert_failed');
    throw err;
  }

  // Read back unconditionally: the row exists either way, and re-reading is the
  // only way to return the WINNER's receipt rather than the loser's local view.
  // Under v2 the conflict target and this read are scoped to the SAME principal,
  // so a suppressed insert always has a readable row behind it. Under v1 they
  // disagreed, and a second principal's submit hit the throw below.
  const existing = await getCanaryReceiptForPrincipal(key);
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
  key: CanaryReceiptKey
): Promise<CanaryReceipt | undefined> {
  const result = await pool.query<CanaryReceiptRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM remote_agent_canary_receipts
      WHERE external_run_id = $1 AND external_task_id = $2
        AND contract_digest = $3 AND principal = $4`,
    [key.externalRunId, key.externalTaskId, key.contractDigest, key.principal]
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
  terminal: CanaryTerminalWrite,
  /** Settlement instant. Injectable so golden vectors are reproducible. */
  terminalAt: Date = new Date()
): Promise<boolean> {
  const dialect = getDialect();
  // Derived in one place (contract.ts) so `terminal_status` and `reason` can
  // never disagree about whether a run worked.
  const terminalStatus = terminalStatusForReason(terminal.reason);
  let result: { rowCount?: number | null };
  try {
    result = await pool.query(
      `UPDATE remote_agent_canary_receipts
          SET state = 'terminal',
              terminal_status = $1,
              reason = $2,
              terminal_at = $3,
              resolved_model = $4,
              session_id = $5,
              usage = $6,
              model_usage = $7,
              actual_turns = $8,
              total_cost_usd = $9,
              output_available = $10,
              output_text = $11,
              output_bytes = $12,
              output_sha256 = $13,
              output_content_type = $14,
              sdk_subtype = $15,
              stop_reason = $16,
              errors = $17,
              updated_at = ${dialect.now()}
        WHERE principal = $18 AND external_run_id = $19 AND external_task_id = $20
          AND contract_digest = $21 AND state = 'pending'`,
      [
        terminalStatus,
        terminal.reason,
        terminalAt.toISOString(),
        terminal.resolvedModel ?? null,
        terminal.sessionId ?? null,
        terminal.usage ? JSON.stringify(terminal.usage) : null,
        terminal.modelUsage ? JSON.stringify(terminal.modelUsage) : null,
        terminal.actualTurns ?? null,
        terminal.totalCostUsd ?? null,
        // Every terminal receipt states availability; only a success carries
        // the payload. Booleans are written as 0/1 so the two dialects agree.
        terminal.output ? 1 : 0,
        terminal.output?.text ?? null,
        terminal.output?.bytes ?? null,
        terminal.output?.sha256 ?? null,
        terminal.output?.contentType ?? null,
        terminal.sdkSubtype ?? null,
        terminal.stopReason ?? null,
        terminal.errors?.length ? JSON.stringify(terminal.errors) : null,
        key.principal,
        key.externalRunId,
        key.externalTaskId,
        key.contractDigest,
      ]
    );
  } catch (err) {
    getLog().error({ err: err as Error, key: redactKey(key) }, 'db.canary_receipt_settle_failed');
    throw err;
  }

  const settled = (result.rowCount ?? 0) > 0;
  if (!settled) {
    getLog().warn(
      { key: redactKey(key), reason: terminal.reason },
      'db.canary_receipt_settle_skipped_already_terminal'
    );
  } else {
    getLog().info(
      { key: redactKey(key), reason: terminal.reason, terminalStatus },
      'db.canary_receipt_settle_completed'
    );
  }
  return settled;
}
