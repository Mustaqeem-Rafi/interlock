# Interlock — repo context for Claude Code

## What this is

An MCP proxy that sits between an AI agent and a payment API so the agent **cannot pay twice, and cannot pay more than it was authorised to**. Every tool call becomes a *proposed action* that must earn a decision before it reaches the rail.

Submission for the Razorpay AI Buildathon, Track 01. **Hard deadline Saturday 5 Sep 23:59 IST; submit target 21:00.** Assume severe time pressure on every decision: prefer the smaller correct thing over the larger complete thing.

## The one guarantee everything serves

> **The only edge into a rail call is `AUTHORIZED → IN_FLIGHT`, and after the first attempt the only edge into `AUTHORIZED` is from `CONFIRMED_NOT_APPLIED`.**

If a change makes that sentence untrue, the change is wrong.

## Non-negotiable invariants — assert these in code, test each one

- **I1** At most one intent per `(merchant_id, sik)`. Enforced by a PRIMARY KEY, not by a lock.
- **I2** No rail call is issued unless a durable `IN_FLIGHT` row exists on disk first. `PRAGMA synchronous = FULL`.
- **I3** A retry is issued **only** from `CONFIRMED_NOT_APPLIED`. A timeout or 5xx never retries — it reconciles.
- **I4** `APPLIED` and `BLOCKED` are absorbing.
- **I5** `attempt_seq` strictly monotone per intent.
- **I6** Every state change appends exactly one audit record; `seq` is gapless.

Three reconciler traps that must be handled, each of which silently double-refunds if missed:

1. **Absence on page one is not absence.** `CONFIRMED_NOT_APPLIED` is reachable only after pagination runs to exhaustion in that pass. Anything else is `STILL_UNKNOWN`.
2. **No read-your-writes.** Wait `RECONCILE_MIN_DELAY_MS` (2000) before the first reconcile query.
3. **Amount is not an identity.** Match on `receipt` / `notes.interlock_sik`, which is why we stamp them on the way out.

## Semantic idempotency key

```
sik = base32(sha256(canonicalJson({
  v: 1, merchant_id, tool, subject,     // subject = the RAIL entity id, resolved by us
  amount_minor, currency, extra, window, distinct
}))).slice(0, 32)
```

- `subject` is never the model's phrasing — it is the id we resolved ourselves from the rail.
- `create_refund` uses **no time window**. Two refunds of the same amount on the same payment are indistinguishable by meaning; refusing the second is correct. The escape hatch is an explicit `interlock_distinct_reason` from the agent, which enters the key and is recorded verbatim.
- Stamp `receipt = "ilk_" + sik` and `notes.interlock_sik = sik` on every refund. Razorpay treats `receipt` as a per-payment idempotency key, and the stamp is what makes reconciliation possible at all.

## Razorpay facts, verified — do not re-derive

- `create_refund` takes exactly `amount`, `speed`, `notes`, `receipt`. **No destination field.** A refund cannot be redirected.
- Money-out surface of the Razorpay MCP server is essentially `create_refund` and `create_instant_settlement`. Payouts are read-only there (`fetch_all_payouts`, `fetch_payout_by_id`; no `create_payout`).
- Reconciliation query for refunds: `fetch_multiple_refunds_for_payment`, paginated.
- Never hardcode a fee rate. Read `fees` / `tax` from the response.

## Stack and conventions

Node 22, TypeScript, pnpm workspaces, Zod at every boundary, `better-sqlite3` (synchronous — that is why it was chosen; the write must provably precede the network call), `@modelcontextprotocol/sdk` on both MCP directions.

- Money is always an **integer in minor units**. Floats are rejected at the boundary. No `number` for rupees anywhere.
- Timestamps are epoch ms integers.
- Layered: transport → gate/service → store. No SQL in the gate logic, no policy in the transport.
- Typed errors, never bare `Error`. Client shape is always `{success:false, error:{code, message, requestId}}`.
- Named exports. No default exports.
- Conventional commits.

## Layout

```
packages/
  core/         canonical.ts, hash.ts, sik.ts, types + Zod schemas
  store/        schema.sql, intents.ts, audit.ts  (better-sqlite3)
  gate/
    proxy/      MCP server (in) + MCP client (out)
    gates/      g1_scope.ts, g2_value.ts, ladder.ts
    exactly-once/  wal.ts, machine.ts, reconciler.ts, recovery.ts
    rail/       rail.ts (interface), mock.ts, razorpay.ts
    api/        http surface + SSE
  chaos/        fault-injecting rail + kill-point matrix runner
  bench/        scenario runner, naive harness
```

## The model's place — say this in the video, enforce it in the type system

The money path is **100% deterministic**. There is no model in the decision path at all in v0.1. The mandate is a machine-checkable file a human approves.

If a model gate is ever added, its return type must be `verdict: 'HOLD' | 'BLOCK'` — the union does not contain `ALLOW`, so it *cannot* express an upgrade. That is a type, not a prompt. The ladder additionally throws `InvariantViolation` on any attempted upgrade.

## Scope of v0.1 — build in this order

**In scope, in priority order:** the exactly-once engine (Gate 4) and its chaos matrix, the MCP proxy, Gate 1 (scope) and Gate 2 (value authorization), the scenario suite, Gate 3 (ceilings, velocity and the fee budget), Gate 6 (provenance and manifest pinning), `interlock init`, the operator console, deploy and npm publish.

**Gate 5 (the LLM purpose judge) is opt-in and OFF by default**, behind `--purpose-check`, advisory, and typed so its verdict union cannot contain `ALLOW`. That is a design decision recorded in ADR-0005, not a time cut: with it off, the money path is provably deterministic end to end, which is the claim.

**Out of scope entirely:** Postgres, multi-tenancy, auth beyond a shared bearer token, retry tuning / circuit breakers / dead-letter queues (`QUARANTINED` plus a human is the correct answer at this scale), a landing page beyond a README.

If a checkpoint goes red, cut in this order: console polish → `init` → Gate 6 → Gate 3 → the LangGraph harness → scenarios 30 → 20. **Never cut Gate 4 or the scenario suite.**

## Testing

Every invariant above gets a test. The chaos matrix (5 kill points × N trials, asserting the rail entity count) is the headline result and must run from one command: `pnpm chaos:matrix`.

The mock rail's `ambiguous_504` must **apply the effect upstream and then drop the response**. A mock that 504s without applying has reproduced a failure, not the bug.
