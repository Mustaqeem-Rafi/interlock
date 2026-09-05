import type { Decision, GateResult } from '@interlock/core';

/**
 * What the agent gets back.
 *
 * The rule that shapes every one of these: **never a bare error**. A protocol
 * error, or a result the agent reads as a transient failure, is an instruction
 * to try again — and an agent trying again is the exact failure this system
 * exists to prevent. So a refusal comes back as a *successful* tool result
 * whose content says, unmistakably and in a machine-readable field, that the
 * operation was refused and must not be repeated.
 *
 * That is a deliberate trade. `isError: true` would be more idiomatic MCP for a
 * refusal, but a large share of agent frameworks treat isError as retryable,
 * and we would rather be unidiomatic than be retried. The text content leads
 * with a plain sentence for the model and the JSON carries `retryable: false`
 * for anything parsing it.
 */

export type ProxyOutcome = 'APPLIED' | 'ALREADY_APPLIED' | 'HELD' | 'BLOCKED';

export interface InterlockEnvelope {
  readonly outcome: ProxyOutcome;
  readonly retryable: false;
  readonly reason_code: string;
  readonly message: string;
  readonly sik: string | null;
  readonly request_id: string;
  readonly mandate_hash: string | null;
  readonly gates: readonly { gate: string; verdict: string; reason_code: string }[];
  /** Present when the effect exists on the rail. */
  readonly rail_entity_id?: string | null;
  /** True when this call returned an earlier effect rather than making a new one. */
  readonly idempotent_replay?: boolean;
}

export interface CallToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

function gateSummary(results: readonly GateResult[]): InterlockEnvelope['gates'] {
  return results.map((result) => ({
    gate: result.gate,
    verdict: result.verdict,
    reason_code: result.reason_code,
  }));
}

function render(lead: string, envelope: InterlockEnvelope, body?: unknown): CallToolResult {
  const payload = { interlock: envelope, ...(body === undefined ? {} : { result: body }) };
  return {
    content: [{ type: 'text', text: `${lead}\n\n${JSON.stringify(payload, null, 2)}` }],
    // Deliberately not an error. See the note at the top of this file.
    isError: false,
    structuredContent: payload as Record<string, unknown>,
  };
}

export interface OutcomeInput {
  readonly requestId: string;
  readonly sik: string | null;
  readonly mandateHash: string | null;
  readonly results: readonly GateResult[];
}

export function applied(input: OutcomeInput, railEntityId: string, body: unknown): CallToolResult {
  return render(
    `Refund applied. Rail entity ${railEntityId}.`,
    {
      outcome: 'APPLIED',
      retryable: false,
      reason_code: 'APPLIED',
      message: `applied as ${railEntityId}`,
      sik: input.sik,
      request_id: input.requestId,
      mandate_hash: input.mandateHash,
      gates: gateSummary(input.results),
      rail_entity_id: railEntityId,
      idempotent_replay: false,
    },
    body,
  );
}

/**
 * The drop-in promise. An agent that repeats a request gets the original effect
 * back as a success, so retrying is harmless rather than expensive.
 */
export function alreadyApplied(
  input: OutcomeInput,
  railEntityId: string | null,
  body: unknown,
): CallToolResult {
  return render(
    `Already applied. This exact refund was made earlier and is being returned ` +
      `unchanged; no new money moved. Rail entity ${railEntityId ?? 'unknown'}.`,
    {
      outcome: 'ALREADY_APPLIED',
      retryable: false,
      reason_code: 'ALREADY_APPLIED',
      message: 'this refund was already made; returning the original',
      sik: input.sik,
      request_id: input.requestId,
      mandate_hash: input.mandateHash,
      gates: gateSummary(input.results),
      rail_entity_id: railEntityId,
      idempotent_replay: true,
    },
    body,
  );
}

export function held(input: OutcomeInput, reasonCode: string, message: string): CallToolResult {
  return render(
    `Held for review: ${message}\n` +
      `Do not retry this call. A person has to release it, and repeating the ` +
      `request will not change the answer.`,
    {
      outcome: 'HELD',
      retryable: false,
      reason_code: reasonCode,
      message,
      sik: input.sik,
      request_id: input.requestId,
      mandate_hash: input.mandateHash,
      gates: gateSummary(input.results),
    },
  );
}

export function blocked(input: OutcomeInput, reasonCode: string, message: string): CallToolResult {
  return render(
    `Refused: ${message}\n` +
      `This is a final answer from the payment mandate, not a transient failure. ` +
      `Do not retry. If this refund is legitimate, the mandate has to be changed ` +
      `by a person first.`,
    {
      outcome: 'BLOCKED',
      retryable: false,
      reason_code: reasonCode,
      message,
      sik: input.sik,
      request_id: input.requestId,
      mandate_hash: input.mandateHash,
      gates: gateSummary(input.results),
    },
  );
}

/** The decision as recorded, for the store. */
export function toDecision(
  input: OutcomeInput,
  verdict: Decision['verdict'],
  decidedAt: number,
): Decision {
  return {
    request_id: input.requestId,
    sik: input.sik ?? '',
    mandate_hash: input.mandateHash ?? '',
    verdict,
    results: [...input.results],
    decided_at: decidedAt,
  };
}
