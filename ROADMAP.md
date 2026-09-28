# Interlock — roadmap

**Status:** v0.2.0 on npm, built for the Razorpay AI Buildathon (Sep 2026).
This document plans the road from that submission to a product someone other
than the author runs in front of real money. Where it says "decide", the
decision is open and should end as an ADR.

---

## 0. Vision and the bar

> **Interlock is the open-source safety layer for AI agents that move a
> merchant's money. It works with any agent, in front of any payment gateway,
> and keeps a record the merchant owns, so the guarantee does not depend on who
> built the agent or which rail it calls.**

The reasoning, and what it commits the code to, is
[ADR-0006](docs/adr/0006-the-merchants-layer-not-the-rails.md).

A vision needs a bar it can fail:

> **v1.0 is reached when a team that is not the author has run Interlock in
> front of live payment traffic for 30 continuous days, the audit chain
> verifies end to end across that window, the drift sweep reports zero
> `DUPLICATE` findings, and at least one real incident was caught and resolved
> through the console.**

Everything below is on the path to that sentence. Stars, downloads and talks
follow the bar; they do not substitute for it.

---

## 1. Position: what survives the gateways shipping their own

Gateways are already building agent products — Razorpay's Agent Studio and
Agentic Payments, Cashfree's MCP server. Assume they eventually ship native
agent-safety features, possibly paid. A gateway sees every transaction and
enforces inside its own database, so anything Interlock does on the same axis
is obsoleted the day theirs ships.

Interlock's value is what a single gateway structurally cannot offer:

| | Why a gateway can't |
|---|---|
| Works with **any agent** | Its platform protects agents built on its platform |
| One limit across **any gateway** | It will not count refunds issued through a competitor |
| A **record the merchant owns** | A check run by the party being checked is not independent |
| **Free and self-hosted** | Its version is bundled with its stack and priced accordingly |

And one principle keeps Interlock useful as the rails improve: **when a gateway
ships a native guarantee, Interlock uses it and verifies it, never competes
with it.**

The generalised version — exactly-once for any irreversible agent action — is
a separate project, started after this one, reusing the engine.

---

## 2. The `careful` baseline — first, because it can change the plan

The benchmark runs `naive` (self-labelled a strawman) and stock LangGraph. A
payments engineer's first objection: *"I'd just pass an idempotency key."*

The answer — a retrying agent believes each attempt is a new decision and mints
a fresh key, while the SIK derives from meaning — is asserted, not measured.

Add a third harness, **`careful`**: a competently written agent that supplies
its own idempotency key, retries on 5xx, and reuses the key on retry where its
author remembered to. Run it in `direct` mode.

This matters more under the vision than before. `careful` is roughly what a
well-built native gateway feature looks like, so **the gap between `careful`
and `gated` is the part of Interlock that survives Razorpay shipping theirs.**
If that gap is small, the honest pitch shifts to cross-gateway limits and the
independent record, and you want to know that in week one.

One weekend.

---

## P0 — Make what is already claimed be true

*2–3 weeks. Nothing new is built. Ships as v0.3.0.*

### P0.1 Three defects from the clean-clone audit

| | |
|---|---|
| `pnpm test` fails on a fresh clone | `bin.test.ts` shells out to `packages/gate/dist/bin/interlock-mcp.js`, which exists only after `pnpm build`. Fix: `"test": "pnpm run build && vitest run"`. |
| `RESULTS.chaos.md` documents a command that does not reproduce it | Footer says `--trials 4` without `--full`; that command prints 5 rows, not 25, and a different kill count. Echo the real argv. |
| `nightly-live` red every night | `exit 78` is a failure for a `run:` step, not a skip. Gate later steps on a step output so a secretless run ends green. |

### P0.2 The README contradicts the source

The Operating Envelope says the console is not in v0.1 and the proxy serves no
HTTP. `packages/gate/src/api/*` and `interlock-console.ts` say otherwise. Audit
the whole section: it is the README's most valuable part *because* it is
honest, so a stale line there costs most.

### P0.3 Observe the rail

`docs/rail-notes.md` does not exist; the reconciler's traps are built on
Razorpay's documentation, not its observed behaviour. Run
`scripts/rail-probe.mjs` against test mode and record, with sample sizes:

- What a duplicate `receipt` returns — status, code, body — and whether a
  different amount under the same `receipt` rejects differently.
- The delay until a created refund appears in the list endpoint.
  `RECONCILE_MIN_DELAY_MS = 2000` is a guess; measure a distribution.
- Whether `fees` and `tax` arrive on creation or only later.
- Whether `notes` are echoed reliably; the reconciler matches on them.
- Whether the list cursor is stable while refunds are being created.

Change any code whose assumption was wrong. A contradiction between docs and
behaviour is publishable and belongs in the README.

### Exit

Clean clone green with no prior build. Both workflows green. `rail-notes.md`
committed with dated observations. Every Operating Envelope claim traces to a
test, a measurement or an ADR.

---

## P1 — One neutral path to the rail

*3–4 weeks. The architectural consequence of ADR-0006. Comes before the
correctness work because it changes the write path, and correctness work done
first would have to be redone.*

### P1.1 Interlock serves its own money tools

A small, gateway-neutral tool set — `refund_payment`, `get_payment`,
`list_refunds` to start — implemented over each gateway's REST API through
its rail adapter. Today a money call is forwarded to the vendor's MCP server
while verification reads go over REST; after this, the write and its check
travel the same adapter.

Proxy mode stays, narrowed: vendor tools pass through only if the mandate
grants them *and* they cannot move money. Deny by default.

### P1.2 SIK v2

`tool` becomes Interlock's action name, `rail` joins the payload,
`SIK_VERSION = 2`. Ship a migration that recomputes existing SIKs. Add a test
proving an upstream tool rename leaves the SIK unchanged — that is the bug v2
exists to fix.

### P1.3 De-Razorpay the shared interface

`rail.ts` has Razorpay facts in shared schemas — `receipt: max(40)` is the
obvious one. Move every vendor constraint into its adapter. Write the rail
conformance suite as a standalone test pack any adapter must pass, so the
second gateway is held to the same bar as the first.

### P1.4 Mandates in Interlock's vocabulary

The mandate schema grants Interlock tools, optionally scoped per rail.
`interlock init` authors against it. Old mandates get a converter.

### Exit

The chaos matrix, re-run against the owned tool path, is green at `--full`.
No vendor money tool is reachable by an agent in any mode, with a test that
tries. Conformance suite exists and Razorpay passes it.

---

## P2 — Correct in a world with other actors

*~6 weeks. The phase that separates a hackathon build from a product.*

The design is correct under one assumption that fails in production:
**that Interlock is the only thing writing to the rail.**

### P2.1 The ledger is not the world

`g3_limits.ts` computes budgets from `store.intents.windowTotals(...)` — only
Interlock's own intents. A refund from the dashboard, another integration or a
second gate instance consumes none of the budget. The sweep already detects
these as `ORPHAN` and does nothing with them.

Reconcile foreign rail entities into the ledger as terminal intents with a
provenance marker, counted by Gate 3. The alternative — declaring Interlock the
sole writer — is honest but only adoptable all-at-once, and adoption only
happens incrementally.

### P2.2 Sweep findings get a lifecycle

Severity, an operator action in the console, a webhook alert, and a resolution
recorded in the audit chain. A `DUPLICATE` is a page-someone event.

### P2.3 Concurrency, proved

N gate processes, one SQLite file, M identical proposals, processes killed
mid-flight: exactly one rail entity. Then decide the multi-host story as an ADR.

### P2.4 Store interface and Postgres

One conformance suite both SQLite and Postgres must pass, including
**durability** assertions — `synchronous = FULL` is the guarantee in SQLite,
and a wrong `synchronous_commit` silently removes it in Postgres. SQLite stays
the default.

### P2.5 Clock

Record monotonic and wall time; refuse to start or quarantine when wall time
moves backwards past a threshold. Velocity windows and leases both depend on it.

### P2.6 Crash matrix past `kill -9`

SIGTERM drain, disk full, read-only filesystem, killed during recovery, two
kills in a row, database on a network mount (detect and refuse), torn WAL page.

### P2.7 Soak

24 hours, ~10k proposals with random faults: zero violations, chain verifies,
no unbounded table growth, quarantine drains to zero.

### Exit

Gate 3 counts foreign entities, proven by test. Multi-process test green.
Postgres passes the store suite. Extended matrix and soak published.

---

## P3 — The second gateway, and limits that span both

*~5 weeks. This is the moat: the thing no single gateway can give a merchant.*

### P3.1 Cashfree adapter

Chosen per ADR-0006: an Indian merchant running two gateways is the user who
needs this. Same bar as Razorpay — `rail-notes` from observation first
(sequencing rule 1), then the conformance suite.

Cashfree's API can move money beyond refunds. If the adapter needs payouts,
widening `rail.ts` beyond two money calls is its own ADR, written before the
code.

### P3.2 Cross-gateway mandates

One mandate, several rails, one set of velocity windows and fee budgets counted
across all of them. One currency per window, as today.

### P3.3 A cross-gateway scenario family

New bench family: an agent that splits a harmful sequence across two gateways
so each stays under any per-gateway limit. The number `gated` posts here is the
headline for this phase, because it is the one no native feature can match.

### Exit

Cashfree passes conformance, has observed `rail-notes`, and runs in the chaos
matrix. The cross-gateway family is in `RESULTS.md`.

---

## P4 — A stranger can run it

*~4 weeks. The Docker image and quickstart can start any time; the transport
work waits for P1.*

- **Streamable HTTP transport.** Today stdio only, so one agent on one machine.
  HTTP lets one gate serve a fleet and run as shared infrastructure. Keep stdio
  as the zero-config path.
- **Config and mandate lifecycle.** `interlock.config.yaml`; hot-reload with
  re-pinning recorded in the chain; one mandate per agent identity;
  `interlock lint`; rotation with diff-and-approve.
- **Observability.** OpenTelemetry spans across propose → ladder → wal → rail
  → commit → verify, SIK as correlation id; Prometheus `/metrics`; JSON logs
  with a test proving the credential never appears; `interlock audit verify`.
- **Failure posture, documented and drillable.** Fail-closed is the right
  default and a serious operational fact: document it, alarm on it, and write
  the break-glass procedure for moving money while the gate is down without
  corrupting the ledger.
- **Credentials.** Env, file or secret-manager sources; least-privilege
  guidance per gateway; the live-key refusal generalised to the rail interface.
- **Console auth.** Per-operator tokens at minimum, every approve and deny
  attributed in the chain.
- **The ten-minute path.** Docker image, config blocks for Claude Desktop,
  Cursor and LangGraph, and a quickstart ending at a blocked refund in the
  console.

### Exit

Someone who has never seen the repo goes from `docker run` to a blocked refund
in the console in under ten minutes, following only the README, while you
watch and say nothing.

---

## P5 — Breadth

*~6 weeks, after P3.*

- **Stripe.** First-class idempotency keys make it the hardest case for the
  pitch; surviving it is proof. Also the entry point for non-Indian users.
- **More money actions,** each with its own SIK fields and scenarios: payment
  link cancellation, subscription pause and cancel, and payouts if P3's ADR
  admitted them.
- **Gate 5: implement honestly or delete.** Either a real eval with published
  false-allow and false-block rates, or delete `--purpose-check` and state that
  the money path is fully deterministic. The `'HOLD' | 'BLOCK'` type stays
  either way. Deleting is defensible and probably right.

---

## P6 — A project other people can join

*Ongoing; start the cheap parts in P0.*

- `SECURITY.md` with a real disclosure address, `CONTRIBUTING.md`, code of
  conduct, issue and PR templates.
- Release automation; npm publish with `--provenance` via OIDC.
- Renovate or Dependabot, with a stated policy for security updates.
- Ten good-first-issues that are genuinely small and genuinely useful.
- A docs site from the existing `docs/index.html` and landing source.
- Keep writing ADRs. They are why a stranger can trust this code.

**Design partners before P3 ends.** Two or three people with agents that touch
Indian gateways — ideally one running two. Find them through the MCP community
and gateway developer forums. P3 and P4 are guesswork without someone
complaining.

---

## Non-goals

- **Competing with a gateway's native guarantees.** Use them and verify them.
- **Exactly-once for non-payment actions.** A separate project, after this one.
- **A hosted SaaS custodying other people's gateway keys.** The guarantee lives
  next to the agent.
- **A model gate that can ALLOW.** The type does not permit it.
- **Generic attack tooling.** Scenarios stay fixtures against our own mock,
  drawn from published patterns.
- **Being a ledger of record.** The ledger exists to make the rail correct, not
  to replace the merchant's books.

---

## Sequencing rules

1. **No new gateway without observed `rail-notes` for it**, and none until the
   first gateway has them.
2. **No new gate until the sweep feeds Gate 3.**
3. **Every README claim traces to a test, a measurement or an ADR.**
4. **Machine-written results are never hand-edited.** Not for a typo.
5. **The SIK field set changes only with a `SIK_VERSION` bump and a migration.**
6. **A gateway's native guarantee is used and verified, never reimplemented
   around.**
7. **0.x until the store schema is stable.** 1.0 is a migration promise about
   someone else's data.

---

## Watch list

Review when each ships something, and record the outcome in `rail-notes`:

- Razorpay Agent Studio and Agentic Payments.
- Cashfree's MCP server and API changes.
- Any gateway-native agent limits, spend controls or idempotency features —
  each one is a candidate for "use and verify" under rule 6.

---

## Calendar

Evenings and weekends.

| Phase | Size | What it buys |
|---|---|---|
| `careful` baseline | 1 weekend | How much of Interlock survives native features |
| P0 — claims true | 2–3 weeks | Nothing in the repo is unverified |
| P1 — neutral path | 3–4 weeks | One vocabulary, one path, SIK v2 |
| P2 — other actors | ~6 weeks | Correct when it is not the only writer |
| P3 — second gateway | ~5 weeks | The limit no gateway can offer |
| P4 — strangers | ~4 weeks | Someone else can run it |
| P5 — breadth | ~6 weeks | Stripe, more actions, Gate 5 settled |

About six months to a 1.0 candidate, then the 30-day live window on top.

---

## The first three things

1. Accept ADR-0006, or argue with it and change it until you can.
2. Build and run the `careful` baseline.
3. Run the rail probe and commit `docs/rail-notes.md`.
