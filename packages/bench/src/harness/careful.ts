import { InterlockError, sha256Hex } from '@interlock/core';
import type {
  Harness,
  HarnessContext,
  HarnessResult,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
  ToolInvocation,
} from '../types.js';
import { NAIVE_RETRY_LIMIT, NAIVE_SYSTEM_PROMPT } from './naive.js';

/**
 * The honest opponent: a competently written agent that does not have Interlock.
 *
 * This is the stand-in for "I'd just pass an idempotency key", and for roughly
 * what a well-built native gateway feature would give a merchant. It is NOT a
 * strawman, and nothing in this file is allowed to make it lose. If it loses,
 * it loses on the one thing it structurally cannot do.
 *
 * What it does, all of it ordinary:
 *
 *   1. Every time the model DECIDES to call a money tool, it mints one
 *      idempotency key for that decision and sends it as the refund `receipt`,
 *      which is the field the rail treats as a per-payment key.
 *   2. On a transport-level failure (timeout, 5xx, connection reset), or a
 *      response stamped with a receipt that is not its own, it retries the SAME
 *      call with the SAME key, up to the same limit as the naive loop so the two
 *      are comparable. A call that succeeded is never retried for what its body
 *      happens to say.
 *   3. A retry rejected as a duplicate receipt is read for what it is: proof the
 *      earlier attempt landed. It is reported to the model as already applied,
 *      not as a failure. Without this the model would read an error and decide
 *      again, which is a bug in the harness and not in the agent being modelled.
 *   4. It does NOT retry a rejection that is not a transport failure.
 *
 * What it cannot do, and the whole reason the gap to `gated` is worth measuring:
 *
 *   - When the model reads a tool result and DECIDES again, that is a new
 *     decision and it mints a new key. The key protects against the network
 *     retrying; it does not protect against the caller deciding twice. Nothing
 *     here forces that to happen. It occurs only where the scripted policy would
 *     naturally decide again.
 *   - It has no mandate. An injected instruction to refund more, or to settle, is
 *     a perfectly well-formed new decision with a perfectly good key.
 *   - The rail has no idempotency field on `create_instant_settlement`, so there
 *     is no key to send and a retried settlement is unprotected. That is a fact
 *     about the rail, not a choice made to disadvantage this harness.
 */

/** Razorpay caps `receipt` at 40 characters; a longer one is rejected, not truncated. */
export const CAREFUL_RECEIPT_MAX = 40;

/** Tools whose rail request has a field a caller-supplied key can travel in. */
const KEYED_TOOLS: ReadonlySet<string> = new Set(['create_refund']);

const MONEY_TOOLS: ReadonlySet<string> = new Set([
  'create_refund',
  'create_instant_settlement',
  'create_payout',
]);

/**
 * One key per decision, deterministic so a rerun produces the same transcript.
 *
 * A hash rather than a counter so the key looks like what an agent really mints
 * and cannot collide across scenarios by accident; truncated well inside the
 * limit rather than clipped at it.
 */
export function mintReceipt(scenarioId: string, decision: number): string {
  return `cr_${sha256Hex(`${scenarioId}:${String(decision)}`).slice(0, 32)}`;
}

/**
 * Words that mean "the response did not arrive or the server fell over".
 *
 * Narrower than the naive list on purpose, and that is the whole competence:
 * `error` and `failed` are not here, so a business rejection ("payment not
 * found", "amount exceeds ...") is not mistaken for a blip and hammered. Bare
 * numbers are never matched, only labelled status codes, for the reason given in
 * naive.ts: a Rs 5,000 refund is `500000` in minor units.
 */
const TRANSPORT_MARKERS: readonly string[] = [
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'gateway timeout',
  'gateway time-out',
  'bad gateway',
  'service unavailable',
  'temporarily unavailable',
  'internal server error',
  'rail_timeout',
  'rail_unavailable',
  ...['http ', 'status ', 'status: ', 'status": ', 'code: '].flatMap((label) =>
    ['500', '502', '503', '504'].map((code) => `${label}${code}`),
  ),
];

/** An explicit "do not retry" from the far side is honoured, as in naive.ts. */
const NON_RETRYABLE_MARKERS: readonly string[] = [
  'do not retry',
  'retryable": false',
  "retryable': false",
];

/**
 * The mock rail's duplicate-receipt rejection: by its code when the error is
 * thrown at us, by its words when the bench world has flattened it to a message.
 */
const DUPLICATE_RECEIPT_MARKERS: readonly string[] = [
  'rail_duplicate_receipt',
  'has already been used on payment',
];

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

type ModelStep =
  | { readonly ok: true; readonly response: ModelResponse }
  | { readonly ok: false; readonly error: string };

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** A refund body whose top-level receipt is a string other than `key`. */
function carriesForeignReceipt(text: string, key: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  const receipt =
    typeof body === 'object' && body !== null ? (body as { receipt?: unknown }).receipt : undefined;
  return typeof receipt === 'string' && receipt !== key;
}

/**
 * Whether to send the same call again with the same key. Two triggers, no more.
 *
 * A call that FAILED in transport. `isError` is checked before any words are
 * read, so a successful body that merely mentions a timeout is never retried:
 * for a settlement, which has no key, that retry would be a second settlement.
 *
 * And, for a call that carried our key, a response that is not ours: a refund
 * body stamped with someone else's receipt, which is what the dup_response fault
 * produces. Our refund may well have landed and that body cannot say; the same
 * key settles it either way.
 */
function needsRetry(outcome: ToolOutcome, key: string | null): boolean {
  const text = outcome.text.toLowerCase();
  if (containsAny(text, NON_RETRYABLE_MARKERS)) return false;
  if (outcome.isError) return containsAny(text, TRANSPORT_MARKERS);
  return key !== null && carriesForeignReceipt(outcome.text, key);
}

function isDuplicateReceipt(outcome: ToolOutcome): boolean {
  return containsAny(outcome.text.toLowerCase(), DUPLICATE_RECEIPT_MARKERS);
}

function errorMessage(error: unknown): string {
  if (error instanceof InterlockError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function completeSafely(
  context: HarnessContext,
  messages: readonly ModelMessage[],
): Promise<ModelStep> {
  try {
    const response = await context.model.complete({ messages, tools: context.tools });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function assistantTurn(response: ModelResponse): ModelMessage {
  const said = response.text.trim();
  if (response.tool_calls.length === 0) {
    return { role: 'assistant', content: said };
  }
  const rendered = response.tool_calls
    .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
    .join('\n');
  return { role: 'assistant', content: said.length > 0 ? `${said}\n${rendered}` : rendered };
}

async function invokeOnce(
  context: HarnessContext,
  name: string,
  args: Record<string, unknown>,
  sink: ToolInvocation[],
): Promise<ToolOutcome> {
  const startedAt = context.now();
  let outcome: ToolOutcome;
  try {
    outcome = await context.call(name, args);
  } catch (error) {
    outcome = { text: errorMessage(error), isError: true };
  }
  sink.push({
    name,
    arguments: args,
    result: outcome.text,
    isError: outcome.isError,
    started_at: startedAt,
    finished_at: context.now(),
  });
  return outcome;
}

/**
 * The same call, the same arguments, the same key.
 *
 * Only a retry can legitimately meet its own key already on the rail, so only a
 * retry gets the duplicate-receipt reading.
 */
async function invokeWithKeyedRetry(
  context: HarnessContext,
  call: ModelToolCall,
  decision: number,
  sink: ToolInvocation[],
): Promise<ToolOutcome> {
  const key = KEYED_TOOLS.has(call.name) ? mintReceipt(context.scenario.id, decision) : null;
  const args = key === null ? call.arguments : { ...call.arguments, receipt: key };

  let outcome = await invokeOnce(context, call.name, args, sink);
  for (let retry = 1; retry <= NAIVE_RETRY_LIMIT && needsRetry(outcome, key); retry += 1) {
    outcome = await invokeOnce(context, call.name, args, sink);
    if (key !== null && isDuplicateReceipt(outcome)) {
      return {
        text: JSON.stringify({
          status: 'already_applied',
          receipt: key,
          detail:
            'An earlier attempt with this key reached the rail; the rail refused the repeat ' +
            'as a duplicate, so the original stands.',
        }),
        isError: false,
      };
    }
  }
  return outcome;
}

export function createCarefulHarness(): Harness {
  return {
    name: 'careful',
    note:
      'NOT a strawman, and it does not have Interlock. This is a competently written agent ' +
      'without a gate: the same scripted policy and the same prompt as naive, but every time it ' +
      'decides to call a money tool it mints an idempotency key and sends it as the refund ' +
      'receipt, and on a transport failure (timeout, 5xx, connection reset) or a response ' +
      'stamped with a receipt that is not its own it retries the same call with the same key, ' +
      `at most ${String(NAIVE_RETRY_LIMIT)} times, as naive does. A ` +
      'rejection that is not a transport failure is not retried, and a repeat rejected as a ' +
      'duplicate receipt is read as proof the first attempt landed. It is the stand-in for ' +
      '"I would just pass an idempotency key" and for what a native gateway feature would give a ' +
      'merchant. It still loses where a key cannot help: when the model reads a result and ' +
      'decides again it mints a new key, it has no mandate to bound what it is talked into, and ' +
      'instant settlement has no key field on this rail. The gap between these rows and the ' +
      'gated rows is the part of Interlock that does not depend on the gateway.',
    async run(context: HarnessContext): Promise<HarnessResult> {
      const messages: ModelMessage[] = [
        { role: 'system', content: NAIVE_SYSTEM_PROMPT },
        { role: 'user', content: context.scenario.user_task },
      ];
      const invocations: ToolInvocation[] = [];
      let finalText = '';
      let completed = false;
      let decisions = 0;
      for (let step = 0; step < context.maxSteps; step += 1) {
        const turn = await completeSafely(context, messages);
        if (!turn.ok) {
          // A replay-mode cache miss: a gap in the fixtures, not a result.
          return { completed: false, invocations: [], final_text: '', unavailable: turn.error };
        }
        const response = turn.response;
        finalText = response.text;
        messages.push(assistantTurn(response));
        if (response.tool_calls.length === 0) {
          completed = true;
          break;
        }
        for (const call of response.tool_calls) {
          // Each tool call the model emits is a decision. A non-money call burns
          // a number too, which costs nothing and keeps keys independent of how
          // many reads came before.
          decisions += 1;
          const outcome = MONEY_TOOLS.has(call.name)
            ? await invokeWithKeyedRetry(context, call, decisions, invocations)
            : await invokeOnce(context, call.name, call.arguments, invocations);
          messages.push({
            role: 'tool',
            content: outcome.text,
            tool_call_id: call.id,
            name: call.name,
          });
        }
      }
      return { completed, invocations, final_text: finalText };
    },
  };
}
