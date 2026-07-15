import { open, stat } from 'node:fs/promises';
import type { OpenAPIHono } from '@hono/zod-openapi';

const CONTROL_COMMAND = '/usr/local/bin/goviral-control-action';
const AUDIT_PATH = '/var/lib/goviral-archon/.archon/goviral-control-audit.jsonl';
const BRAIN_ROOT = '/var/lib/goviral-archon/workspaces/goviral-brain';
const MAX_AUDIT_BYTES = 128 * 1024;
const MAX_AUDIT_ROWS = 80;
const ACTION_TIMEOUT_MS = 180_000;

const ACTIONS = ['approve', 'reject', 'execute', 'retry-unit', 'start-unit', 'stop-unit'] as const;

type ControlAction = (typeof ACTIONS)[number];
type JsonRecord = Record<string, unknown>;

interface AuditItem {
  timestamp: string | null;
  actor: string | null;
  action: string;
  target: string;
  status: string;
  detail: string | null;
}

interface ActionMetadata {
  generated_at: string;
  enabled: boolean;
  role: 'viewer' | 'operator';
  csrf: string;
  confirmation_templates: Record<ControlAction, string>;
  audit: AuditItem[];
}

interface CommandResult {
  ok: boolean;
  exit_code: number;
  output: string;
}

const csrfToken = crypto.randomUUID();
const requestHistory = new Map<string, number[]>();

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function safeText(value: unknown, maxLength = 400): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function isControlAction(value: unknown): value is ControlAction {
  return typeof value === 'string' && ACTIONS.includes(value as ControlAction);
}

function actionTargetValid(action: ControlAction, target: string): boolean {
  if (['approve', 'reject', 'execute'].includes(action)) {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(target);
  }

  return /^goviral-[a-z0-9-]+\.service$/.test(target);
}

function confirmationFor(action: ControlAction, target: string): string {
  const verb: Record<ControlAction, string> = {
    approve: 'APPROVE',
    reject: 'REJECT',
    execute: 'EXECUTE',
    'retry-unit': 'RETRY',
    'start-unit': 'START',
    'stop-unit': 'STOP',
  };

  return `${verb[action]} ${target}`;
}

function hostname(value: string): string {
  try {
    const candidate = value.includes('://') ? value : `http://${value}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function allowedHostname(value: string): boolean {
  const name = hostname(value);

  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name.endsWith('.ts.net');
}

function requestIdentity(headers: Headers): string {
  return (
    safeText(headers.get('tailscale-user-login'), 160) ??
    safeText(headers.get('x-forwarded-for'), 160) ??
    'tailnet-client'
  );
}

function requestAllowed(headers: Headers): boolean {
  const host = headers.get('host') ?? '';
  const origin = headers.get('origin');

  if (!allowedHostname(host)) {
    return false;
  }

  return origin === null || allowedHostname(origin);
}

function withinRateLimit(identity: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const previous = requestHistory.get(identity) ?? [];
  const recent = previous.filter((timestamp): boolean => timestamp >= cutoff);

  if (recent.length >= 6) {
    requestHistory.set(identity, recent);
    return false;
  }

  recent.push(now);
  requestHistory.set(identity, recent);
  return true;
}

async function readAuditTail(): Promise<AuditItem[]> {
  try {
    const fileStat = await stat(AUDIT_PATH);

    if (!fileStat.isFile() || fileStat.size === 0) {
      return [];
    }

    const bytes = Math.min(fileStat.size, MAX_AUDIT_BYTES);
    const offset = Math.max(0, fileStat.size - bytes);
    const handle = await open(AUDIT_PATH, 'r');

    try {
      const buffer = Buffer.alloc(bytes);
      const result = await handle.read(buffer, 0, bytes, offset);
      const text = buffer.subarray(0, result.bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/);

      if (offset > 0) {
        lines.shift();
      }

      return lines
        .filter((line): boolean => line.trim().length > 0)
        .slice(-MAX_AUDIT_ROWS)
        .reverse()
        .map((line): AuditItem | null => {
          try {
            const record = asRecord(JSON.parse(line) as unknown);
            const action = safeText(record.action, 80);
            const target = safeText(record.target, 180);
            const status = safeText(record.status, 80);

            if (!action || !target || !status) {
              return null;
            }

            return {
              timestamp: safeText(record.timestamp, 80),
              actor: safeText(record.actor, 160),
              action,
              target,
              status,
              detail: safeText(record.detail, 400),
            };
          } catch {
            return null;
          }
        })
        .filter((item): item is AuditItem => item !== null);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function actionMetadata(audit: AuditItem[]): ActionMetadata {
  const enabled = process.env.GOVIRAL_ACTIONS_ENABLED === '1';

  return {
    generated_at: new Date().toISOString(),
    enabled,
    role: enabled ? 'operator' : 'viewer',
    csrf: csrfToken,
    confirmation_templates: {
      approve: 'APPROVE <approval-id>',
      reject: 'REJECT <approval-id>',
      execute: 'EXECUTE <approval-id>',
      'retry-unit': 'RETRY <unit-name>',
      'start-unit': 'START <unit-name>',
      'stop-unit': 'STOP <unit-name>',
    },
    audit,
  };
}

function sanitizeOutput(value: string): string {
  return value.replaceAll(BRAIN_ROOT, '[brain]').replace(/\s+/g, ' ').trim().slice(0, 800);
}

async function runControlCommand(action: ControlAction, target: string): Promise<CommandResult> {
  const child = Bun.spawn(['/usr/bin/sudo', '-n', '--', CONTROL_COMMAND, action, target], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: '/var/lib/goviral-archon',
    },
  });

  let timedOut = false;
  const timeout = setTimeout((): void => {
    timedOut = true;
    child.kill();
  }, ACTION_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    const output = sanitizeOutput(stdout || stderr);

    return {
      ok: !timedOut && exitCode === 0,
      exit_code: timedOut ? 124 : exitCode,
      output: timedOut ? 'action timed out' : output,
    };
  } catch {
    return {
      ok: false,
      exit_code: 125,
      output: 'governed action command failed to start',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerGoviralPhase4Routes(app: OpenAPIHono): void {
  app.get('/api/goviral/actions', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    return c.json(actionMetadata(await readAuditTail()));
  });

  app.post('/api/goviral/actions', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');

    if (process.env.GOVIRAL_ACTIONS_ENABLED !== '1') {
      return c.json({ ok: false, error: 'operator actions are disabled' }, 403);
    }

    if (!requestAllowed(c.req.raw.headers)) {
      return c.json({ ok: false, error: 'request origin is not allowed' }, 403);
    }

    const identity = requestIdentity(c.req.raw.headers);

    if (!withinRateLimit(identity)) {
      return c.json({ ok: false, error: 'action rate limit exceeded' }, 429);
    }

    let body: JsonRecord;

    try {
      const parsed = (await c.req.json()) as unknown;
      body = asRecord(parsed);
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    const action = body.action;
    const target = safeText(body.target, 180) ?? '';
    const confirmation = safeText(body.confirmation, 220) ?? '';
    const csrf = safeText(body.csrf, 80) ?? '';

    if (csrf !== csrfToken) {
      return c.json({ ok: false, error: 'invalid CSRF token' }, 403);
    }

    if (!isControlAction(action) || !actionTargetValid(action, target)) {
      return c.json({ ok: false, error: 'action or target is invalid' }, 400);
    }

    if (confirmation !== confirmationFor(action, target)) {
      return c.json({ ok: false, error: 'confirmation phrase does not match' }, 400);
    }

    const result = await runControlCommand(action, target);

    if (!result.ok) {
      return c.json(
        {
          ok: false,
          action,
          target,
          error: result.output || `command returned ${result.exit_code}`,
        },
        409
      );
    }

    return c.json({
      ok: true,
      action,
      target,
      detail: result.output || 'governed action completed',
    });
  });
}
