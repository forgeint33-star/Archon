#!/usr/bin/env bun
/**
 * A fake Claude Code CLI, spawned by the REAL @anthropic-ai/claude-agent-sdk.
 *
 * WHY A SUBPROCESS AND NOT A MOCK. Mocking `query()` would test our own mock's
 * idea of the SDK. Everything this suite needs to prove lives in the layer a
 * mock replaces: that `--max-turns` and `--max-budget-usd` actually reach the
 * process, that `Task` lands in `--disallowedTools`, that `--fork-session` and
 * `--fallback-model` are absent, that `--setting-sources=` is empty, and that a
 * dead subprocess is not retried. So the SDK runs for real and this stands in
 * for the model — no provider call, no network, no credentials.
 *
 * The SDK spawns a `.mjs` executable as `bun [executableArgs] <this> <cliArgs>`
 * (see `iZ()` in sdk.mjs), so argv and the stream-json protocol here are the
 * genuine article.
 *
 * PROTOCOL. Read line-delimited JSON on stdin, write line-delimited JSON on
 * stdout:
 *   in  {"type":"control_request","request_id":…,"request":{"subtype":"initialize",…}}
 *   out {"type":"control_response","response":{"subtype":"success","request_id":…,"response":{}}}
 *   in  {"type":"user","message":{…}}
 *   out {"type":"system","subtype":"init",…} then {"type":"result",…}
 *
 * BEHAVIOUR is driven entirely by environment variables so a test can pick a
 * scenario without writing a new fixture:
 *
 *   FAKE_CLAUDE_LOG        append a JSONL record of argv, stdin and env here.
 *                          This is how tests assert on what the SDK really sent.
 *   FAKE_CLAUDE_SCENARIO   success | max_turns | max_budget | no_usage |
 *                          crash | hang | no_result | empty_output |
 *                          whitespace_output | oversized_output |
 *                          unicode_output | failure_with_output
 *                          (default: success)
 *   FAKE_CLAUDE_EXIT_CODE  exit code for the `crash` scenario (default 1)
 *   FAKE_CLAUDE_OUTPUT     override the final assistant text for `success`
 *   FAKE_CLAUDE_OVERSIZE_BYTES
 *                          size of the `oversized_output` payload (default
 *                          1048577 — one byte past the contract ceiling)
 */
import { appendFileSync } from 'node:fs';

const LOG = process.env.FAKE_CLAUDE_LOG;
const SCENARIO = process.env.FAKE_CLAUDE_SCENARIO || 'success';

function log(record) {
  if (!LOG) return;
  // Appends are atomic enough for the sizes here, which matters because the
  // retry-suppression test counts how many processes wrote to the same file.
  appendFileSync(LOG, JSON.stringify(record) + '\n');
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

log({
  kind: 'spawn',
  argv: process.argv.slice(2),
  // Only the bounded-mode variables — never the whole environment, which would
  // write real credentials into a test artifact.
  env: {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? null,
    DISABLE_COMPACT: process.env.DISABLE_COMPACT ?? null,
  },
});

if (SCENARIO === 'crash') {
  // Die before saying anything: the provider sees a dead subprocess with no
  // terminal result — the case whose spend is unrecoverable.
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT_CODE || 1));
}

const MODEL_USAGE = {
  'claude-sonnet-5': {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadInputTokens: 64,
    cacheCreationInputTokens: 16,
    webSearchRequests: 0,
    costUSD: 0.0087,
    contextWindow: 1000000,
    maxOutputTokens: 8000,
  },
};

/** Default deliverable for the success path. */
const DEFAULT_OUTPUT = 'bounded canary output';

/**
 * Final assistant text per scenario. `undefined` means the SDK omits the field
 * entirely, which is distinct from an empty string — Archon must fail closed on
 * both, and the tests need to prove it does so for each separately.
 */
function outputForScenario() {
  switch (SCENARIO) {
    case 'empty_output':
      return '';
    case 'whitespace_output':
      return '   \n\t  ';
    case 'no_output_field':
      return undefined;
    case 'oversized_output':
      // One byte past the ceiling by default: the interesting case is the
      // boundary, not an obviously absurd payload.
      return 'x'.repeat(Number(process.env.FAKE_CLAUDE_OVERSIZE_BYTES || 1048577));
    case 'unicode_output':
      // Multi-byte on purpose: UTF-16 .length would report 8 here while the
      // UTF-8 byte length is 20, so a wrong implementation is caught.
      return 'héllo → 世界';
    default:
      return process.env.FAKE_CLAUDE_OUTPUT ?? DEFAULT_OUTPUT;
  }
}

const BASE_RESULT = {
  type: 'result',
  session_id: 'fake-session',
  uuid: 'fake-result-uuid',
  duration_ms: 12,
  duration_api_ms: 10,
  stop_reason: 'end_turn',
  permission_denials: [],
  modelUsage: MODEL_USAGE,
};

function resultForScenario() {
  switch (SCENARIO) {
    case 'max_turns':
      return {
        ...BASE_RESULT,
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 3,
        total_cost_usd: 0.42,
        usage: { input_tokens: 1200, output_tokens: 340 },
        stop_reason: 'max_turns',
        errors: ['Reached the maximum number of turns (3)'],
      };
    case 'max_budget':
      return {
        ...BASE_RESULT,
        subtype: 'error_max_budget_usd',
        is_error: true,
        num_turns: 2,
        total_cost_usd: 1.07,
        usage: { input_tokens: 4200, output_tokens: 900 },
        stop_reason: 'max_budget_usd',
        errors: ['Exceeded the maximum budget of $1.00'],
      };
    case 'failure_with_output':
      // A ceiling hit that ALSO left text behind. Archon must not attach it:
      // a partial result on a failed run is not a deliverable.
      return {
        ...BASE_RESULT,
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 3,
        total_cost_usd: 0.42,
        usage: { input_tokens: 1200, output_tokens: 340 },
        stop_reason: 'max_turns',
        result: 'partial work that must never be published as a deliverable',
        errors: ['Reached the maximum number of turns (3)'],
      };
    case 'no_usage':
      // A terminal result that carries NO usage aggregate. The receipt must
      // record the turn count and reason it does have, and must NOT invent a
      // zero-cost usage block.
      return {
        ...BASE_RESULT,
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 1,
        errors: ['Execution failed before any usage was reported'],
      };
    default: {
      const output = outputForScenario();
      return {
        ...BASE_RESULT,
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        // Omit the field entirely when undefined, exactly as an SDK that
        // produced nothing would — not `result: undefined`, which JSON drops
        // anyway but which would read as intentional in the fixture.
        ...(output === undefined ? {} : { result: output }),
        total_cost_usd: 0.0087,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 64,
          cache_creation_input_tokens: 16,
        },
      };
    }
  }
}

let buffered = '';
process.stdin.on('data', chunk => {
  buffered += chunk.toString();
  let nl;
  while ((nl = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log({ kind: 'unparsed', line });
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.type === 'control_request') {
    // The initialize payload carries the system prompt. Logging it is how the
    // "complete effective prompt" assertion is made against what the SDK
    // actually transmitted rather than against what we intended to send.
    log({ kind: 'control_request', request: msg.request });
    out({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: {} },
    });
    return;
  }

  if (msg.type !== 'user') return;
  log({ kind: 'user_message', message: msg.message });

  if (SCENARIO === 'hang') {
    // Answer nothing at all. Used for deadline/abort coverage — the caller's
    // AbortController must be what ends this, not us.
    return;
  }

  out({
    type: 'system',
    subtype: 'init',
    session_id: 'fake-session',
    uuid: 'fake-init-uuid',
    apiKeySource: 'none',
    claude_code_version: 'fake-0.0.0',
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-5',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  });

  if (SCENARIO === 'no_result') {
    // Emit the init and then exit cleanly WITHOUT a terminal result. This is
    // the stream-ended-without-aggregate case, distinct from `crash`.
    setTimeout(() => process.exit(0), 20);
    return;
  }

  out(resultForScenario());
  setTimeout(() => process.exit(0), 20);
}
