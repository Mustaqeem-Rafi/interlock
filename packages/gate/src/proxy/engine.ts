import {
  ProposedAction,
  computeSik,
  mandateHash as hashMandate,
  railSubjectId,
  timeWindow,
  type GateResult,
  type Mandate,
} from '@interlock/core';
import type { IntentRow, Store } from '@interlock/store';
import { createG2Value } from '../gates/g2_value.js';
import { G1_SCOPE } from '../gates/g1_scope.js';
import { runLadder, type ModelGate } from '../gates/ladder.js';
import { createReferentResolver, type ReferentResolver } from '../gates/resolver.js';
import { nextState } from '../exactly-once/machine.js';
import { propose } from '../exactly-once/propose.js';
import { matchesSik, type Reconciler } from '../exactly-once/reconciler.js';
import type { Wal } from '../exactly-once/wal.js';
import type { Rail, Refund } from '../rail/rail.js';
import type { Upstream } from './upstream.js';
import {
  alreadyApplied,
  applied,
  blocked,
  held,
  toDecision,
  type CallToolResult,
  type OutcomeInput,
} from './responses.js';

/**
 * The decision path for one tool call.
 *
 * Order is fixed and each step earns the next: the ladder decides whether the
 * action is permitted at all, the exactly-once engine decides whether it has
 * already happened, and only then does anything reach the rail. The subject id
 * that keys the whole thing is resolved by Gate 2 off our own client, which is
 * why the intent row cannot be created any earlier than this.
 */

/** Money-out tools go through the full pipeline; everything else is forwarded. */
const MONEY_TOOLS = new Set(['create_refund', 'create_instant_settlement']);

/** One automatic retry, and only ever from CONFIRMED_NOT_APPLIED (I3). */
const MAX_ATTEMPTS = 2;

export interface EngineOptions {
  readonly store: Store;
  readonly rail: Rail;
  readonly wal: Wal;
  readonly reconciler: Reconciler;
  readonly mandate: Mandate;
  readonly upstream: Upstream;
  readonly agentId: string;
  readonly resolver?: ReferentResolver;
  readonly modelGates?: readonly ModelGate[];
  readonly now?: () => number;
  readonly requestId?: () => string;
}

export interface Engine {
  listTools(): Promise<readonly { name: string; description?: string; inputSchema: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The resolved payment Gate 2 put on its evidence, if it got that far. */
function resolvedSubject(results: readonly GateResult[]): string | null {
  for (const result of results) {
    const payment = (result.evidence as { payment?: { id?: unknown } }).payment;
    const id = asString(payment?.id);
    if (id !== null) return id;
  }
  return null;
}

export function createEngine(options: EngineOptions): Engine {
  const now = options.now ?? ((): number => Date.now());
  const resolver = options.resolver ?? createReferentResolver({ rail: options.rail, now });
  const mandateHash = hashMandate(options.mandate);
  const { store, mandate } = options;
  let counter = 0;
  const nextRequestId = options.requestId ?? ((): string => `req_${String(++counter)}`);

  const g2 = createG2Value(resolver);

  /** Look the applied refund up by its stamp, so a replay returns the real one. */
  async function findBySik(paymentId: string, sik: string): Promise<Refund | null> {
    let cursor: string | null = null;
    try {
      do {
        const page = await options.rail.listRefundsForPayment(paymentId, cursor);
        const hit = page.items.find((refund) => matchesSik(refund, sik));
        if (hit !== undefined) return hit;
        cursor = page.next_cursor;
      } while (cursor !== null);
    } catch {
      return null;
    }
    return null;
  }

  async function issue(intent: IntentRow, out: OutcomeInput): Promise<CallToolResult> {
    let current = intent;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await options.wal.issueRefund(current);

      if (outcome.kind === 'APPLIED') {
        return applied(out, outcome.refund.id, outcome.refund);
      }
      if (outcome.kind === 'FAILED_TERMINAL') {
        return blocked(out, 'RAIL_REJECTED', outcome.error.message);
      }

      // Ambiguous. Never retried; reconciled.
      const settled = await options.reconciler.settle(outcome.intent);
      if (settled.kind === 'APPLIED') {
        const refund = await findBySik(current.subject_id, current.sik);
        return alreadyApplied(out, settled.rail_entity_id, refund);
      }
      if (settled.kind === 'QUARANTINED') {
        return held(out, 'QUARANTINED', 'reconciliation could not settle this; a person must');
      }
      if (settled.kind !== 'CONFIRMED_NOT_APPLIED' || attempt === MAX_ATTEMPTS) {
        return held(out, 'UNSETTLED', 'the outcome is not yet known; a person must resolve it');
      }

      // The one legal retry edge.
      current = store.intents.transition({
        merchant_id: settled.intent.merchant_id,
        sik: settled.intent.sik,
        from: 'CONFIRMED_NOT_APPLIED',
        to: nextState('CONFIRMED_NOT_APPLIED', 'RETRY_AUTHORIZED'),
        at: now(),
        audit_kind: 'RETRY_AUTHORIZED',
      });
    }
    return held(out, 'UNSETTLED', 'the outcome is not yet known; a person must resolve it');
  }

  return {
    async listTools() {
      const manifest = await options.upstream.manifest();
      const granted = new Set(Object.keys(mandate.scope.grants));
      return manifest.tools
        .filter((tool) => granted.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        }));
    },

    async callTool(name, args) {
      const requestId = nextRequestId();
      const at = now();

      // Scope first, for every tool and before anything is parsed. An agent
      // that reached a tool name some other way must be told it is out of
      // scope, not that its arguments were malformed — the second is a hint to
      // try again with different arguments, which is precisely wrong.
      if (mandate.scope.grants[name] === undefined) {
        return blocked(
          { requestId, sik: null, mandateHash, results: [] },
          'TOOL_NOT_GRANTED',
          `${name} is not granted by mandate ${mandate.mandate_id}`,
        );
      }

      if (!MONEY_TOOLS.has(name)) {
        // Read-only surface. Scope already applied; nothing else needs to.
        const forwarded = await options.upstream.call(name, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(forwarded) }],
          isError: false,
        };
      }

      const manifest = await options.upstream.manifest();
      const amount = asInteger(args['amount_minor']) ?? asInteger(args['amount']);
      const subject = asString(args['payment_id']) ?? asString(args['subject']);

      if (amount === null || subject === null) {
        return blocked(
          { requestId, sik: null, mandateHash, results: [] },
          'MALFORMED_ARGUMENTS',
          'a refund needs an integer amount in minor units and a payment id',
        );
      }

      const action = ProposedAction.parse({
        request_id: requestId,
        merchant_id: mandate.merchant_id,
        agent_id: options.agentId,
        tool: name,
        subject,
        amount_minor: amount,
        currency: asString(args['currency']) ?? 'INR',
        args,
        distinct_reason: asString(args['interlock_distinct_reason']),
        observed_manifest_sha256: manifest.sha256,
        proposed_at: at,
      });

      const ladder = await runLadder({
        gates: [G1_SCOPE, g2],
        ...(options.modelGates === undefined ? {} : { modelGates: options.modelGates }),
        context: { action, mandate, now: at },
      });

      const last = ladder.results.at(-1);
      const resolved = resolvedSubject(ladder.results);

      // Nothing was resolved, so there is no key to file this under. Refuse and
      // record it in the audit chain rather than inventing an intent.
      if (resolved === null) {
        const out: OutcomeInput = { requestId, sik: null, mandateHash, results: ladder.results };
        store.audit.append({
          kind: 'DECISION_UNKEYED',
          ts: at,
          payload: {
            request_id: requestId,
            verdict: ladder.verdict,
            gates: ladder.results.map((r) => ({
              gate: r.gate,
              verdict: r.verdict,
              reason_code: r.reason_code,
            })),
          },
        });
        return ladder.verdict === 'HOLD'
          ? held(out, last?.reason_code ?? 'HELD', last?.message ?? 'held')
          : blocked(out, last?.reason_code ?? 'BLOCKED', last?.message ?? 'refused');
      }

      const rule = mandate.idempotency[name];
      const sik = computeSik({
        merchant_id: mandate.merchant_id,
        tool: name,
        subject: railSubjectId(resolved),
        amount_minor: action.amount_minor,
        currency: action.currency,
        extra: Object.fromEntries(
          (rule?.key_fields ?? []).map((field) => [field, args[field] ?? null]),
        ),
        window: timeWindow(at, rule?.window_ms ?? null),
        distinct: action.distinct_reason,
      });

      const out: OutcomeInput = { requestId, sik, mandateHash, results: ladder.results };

      const proposed = propose(store, {
        merchant_id: mandate.merchant_id,
        sik,
        tool: name,
        subject_id: resolved,
        amount_minor: action.amount_minor,
        currency: action.currency,
        reversibility: mandate.scope.grants[name]?.reversibility ?? 'irreversible',
        params_hash: mandateHash,
        mandate_hash: mandateHash,
        at,
      });

      store.decisions.record(mandate.merchant_id, toDecision(out, ladder.verdict, at));

      if (proposed.disposition.kind === 'BLOCK') {
        if (proposed.disposition.reason === 'ALREADY_APPLIED') {
          const refund = await findBySik(resolved, sik);
          return alreadyApplied(out, proposed.disposition.rail_entity_id, refund);
        }
        return blocked(out, proposed.disposition.reason, 'this intent is already closed');
      }
      if (proposed.disposition.kind === 'HOLD') {
        return held(out, proposed.disposition.reason, 'another attempt for this refund is open');
      }

      if (ladder.verdict !== 'ALLOW') {
        const event = ladder.verdict === 'HOLD' ? 'GATES_HELD' : 'GATES_BLOCKED';
        if (proposed.intent.state === 'PROPOSED') {
          store.intents.transition({
            merchant_id: mandate.merchant_id,
            sik,
            from: 'PROPOSED',
            to: nextState('PROPOSED', event),
            at,
            audit_kind: event,
            audit_payload: { verdict: ladder.verdict, reason_code: last?.reason_code ?? null },
          });
        }
        return ladder.verdict === 'HOLD'
          ? held(out, last?.reason_code ?? 'HELD', last?.message ?? 'held for review')
          : blocked(out, last?.reason_code ?? 'BLOCKED', last?.message ?? 'refused');
      }

      const authorized =
        proposed.intent.state === 'AUTHORIZED'
          ? proposed.intent
          : store.intents.transition({
              merchant_id: mandate.merchant_id,
              sik,
              from: 'PROPOSED',
              to: nextState('PROPOSED', 'GATES_PASSED'),
              at,
              audit_kind: 'GATES_PASSED',
            });

      return issue(authorized, out);
    },
  };
}
