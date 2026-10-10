# ADR-0006 — Interlock is the merchant's layer, not a copy of the rail's

**Status:** accepted · **Date:** 2026-10-11

## Context

Interlock was built for a deadline, against one gateway, as a proxy in front of
that gateway's MCP server. The deadline has passed. The question this record
answers is what Interlock is *for* now, because every roadmap decision after
this one depends on it.

Payment gateways are shipping agent products of their own. Razorpay launched
Agent Studio at FTX'26 — agents that manage disputes, recover failed payments
and automate post-payment operations, running on top of Razorpay's own stack —
and is piloting Agentic Payments with NPCI. Cashfree runs an MCP server whose
tools cover refunds, settlements and payouts. It is reasonable to assume the
gateways will eventually ship agent-safety features natively, and may charge
for them.

A copy of a native feature loses the day the native feature ships. The gateway
sees every transaction on the account, and can enforce a limit or an
idempotency rule atomically inside its own database. Interlock can do neither;
it reconstructs both from outside. Competing on that axis is building something
people stop needing.

What a gateway structurally cannot offer is a different list:

- **Any agent.** A gateway's agent platform protects agents built on that
  platform. A merchant's own LangGraph bot, a Claude Desktop setup or an
  agency-built support agent calling the gateway directly gets whatever the
  gateway's raw API offers.
- **Any gateway.** No gateway will enforce a merchant's daily refund limit
  across refunds issued through a competitor. Merchants running two gateways
  can only get one shared limit from something neutral.
- **A record the merchant owns.** The drift sweep checks the rail against a
  ledger the rail does not control. That is independent verification in the
  sense that internal audit is independent of the bank statement: not distrust
  of the rail, just a second party.
- **Free and self-hosted by construction.** No per-call cost, and the rail
  credential never leaves the merchant's machine.

Two facts about the current code bind Interlock to one vendor, and both have to
change if the list above is the product.

**The write and the check travel different paths.** In proxy mode a
money-moving call is forwarded to the vendor's MCP server
(`upstream.call(name, args)` in `packages/gate/src/proxy/engine.ts`), while
Gate 2 and the reconciler read over REST through the rail adapter. The action
is described by the vendor's MCP schema and verified against the vendor's REST
schema — two descriptions of one call, maintained by a third party, which can
drift apart without either side noticing.

**The SIK hashes a vendor's word.** `SikInput.tool` in
`packages/core/src/sik.ts` is the upstream tool name, and there is no gateway
field. If a vendor renames `create_refund`, an identical refund acquires a
different SIK and duplicate protection silently stops matching across the
rename. And the same subject id on two gateways is indistinguishable.

## Decision

**1. Scope stays payments.** Exactly-once for arbitrary irreversible actions
(mail, tickets, infrastructure) is a separate project that may reuse this
engine. It does not land in this repository.

**2. The position:**

> Interlock is the open-source safety layer for AI agents that move a
> merchant's money. It works with any agent, in front of any payment gateway,
> and keeps a record the merchant owns, so the guarantee does not depend on who
> built the agent or which rail it calls.

"Free" is a consequence of being neutral and self-hosted, not a price
comparison.

**3. Interlock owns its tool surface.** It serves a small, gateway-neutral set
of MCP tools of its own, each implemented over a gateway's REST API through
that gateway's rail adapter. The write and its verification go through the
same adapter. Mandates are written in Interlock's vocabulary, never a vendor's.

Proxy mode remains, for one purpose: passing through a vendor's *read-only*
tools, filtered by the mandate as today. In no mode does a vendor's
money-moving tool reach the agent. Money moves only through a tool Interlock
implements.

**4. SIK v2.** `tool` becomes Interlock's own action name, and `rail` joins the
hashed payload. `SIK_VERSION` goes to 2.

**5. Native guarantees are used and verified, never competed with.** When a
gateway offers a guarantee — `receipt` today, server-side spend limits
tomorrow — Interlock configures it and then checks it held. Interlock's value
is the part that survives the rails improving.

**6. Rail order:** Razorpay, then an Indian gateway, then Stripe. The merchant
who needs a cross-gateway limit is an Indian merchant running two Indian
gateways, not Razorpay plus Stripe. Cashfree is the first candidate: it is
widely used alongside Razorpay, and its API moves money beyond refunds, which
stresses the money-out surface early.

**7. Limits span gateways.** A mandate's velocity windows and fee budgets count
across every rail it names, still one currency per window as today.

## Consequences

Interlock now implements tool schemas for every gateway it supports, instead of
inheriting them. That is more code and an ongoing maintenance burden: each
adapter tracks a REST API that changes on the vendor's schedule. Every adapter
therefore ships with its own `rail-notes` and must pass the shared rail
conformance suite before it is released.

The one-line install goes away for money. Today an agent keeps its vendor tool
names and Interlock slots in front of them. Under this decision the agent sees
`refund_payment`, not `create_refund`, and a prompt or agent written against a
vendor's tool names has to be re-pointed. This is a real adoption cost, paid
deliberately: a mandate written in a vendor's vocabulary cannot be neutral.

The SIK change is a breaking change to the ledger. There are no known
production ledgers, so in 0.x it is shipped as a documented break with a
migration that recomputes SIKs, rather than a dual-version transition window.
After 1.0 a change of this kind would need one.

Owning the surface does not make traffic that bypasses Interlock visible. A
refund issued from a gateway dashboard is still invisible to Gate 3 until the
sweep reconciles it into the ledger. That problem is unchanged by this record
and is tracked separately.

If a second gateway's API can move money in a way outside today's two calls
(`createRefund`, `createInstantSettlement`) — payouts, most obviously — widening
`rail.ts` is the design conversation its header comment asks for, and gets its
own record. Nothing here decides it.
