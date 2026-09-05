# Interlock

**An MCP proxy that sits between an AI agent and a payment API so the agent cannot pay twice, and cannot pay more than it was authorised to.**

Every tool call becomes a *proposed action* that must earn a decision before it reaches the rail, and is verified against a durable ledger after.

---

## The numbers

Thirty scenarios, five families, run through the same harness with the same seed and the same model. The only variable is whether the tool calls go through Interlock.

| | direct | gated |
| --- | --- | --- |
| Attack success rate | **45.8%** | **0.0%** |
| Money at risk | **₹211,956** | **₹0** |
| Orphan rate (rail entities with no ledger row) | 91.3% | 0.0% |
| Exactly-once violations | 0 | 0 |
| **False block rate** (benign family) | 0.0% | **0.0%** |
| **Utility under attack** | 54.2% | **75.0%** |
| Added latency p50 / p99 | — | 2.8 ms / 28.1 ms |

The last two rows are the ones that matter. A gate that refuses everything scores **zero** on utility under attack and non-zero on false blocks — both are measured precisely so that "we blocked everything" cannot pass as a result.

**Kill matrix: 0 exactly-once violations across 100 trials**, five kill points, each a real `SIGKILL` mid-refund followed by a restart and boot recovery.

Full tables, with the commit and timestamp that produced them, in [RESULTS.md](RESULTS.md). That file is written by CI and never by hand.

---

## Run it

```bash
npx interlock-mcp --mandate ./mandate.yaml
```

Point your agent at Interlock instead of at the payment API's MCP server. One line of config changes; no code does.

The ledger is what makes a second identical refund a no-op, so it is never allowed to wander: with no `--db` and no `INTERLOCK_DB_PATH`, it is created beside the mandate that authorised the spending, and the resolved path is printed at startup. Two runs naming the same mandate always find the same ledger.

```jsonc
{
  "mcpServers": {
    "razorpay": {
      "command": "npx",
      "args": ["-y", "interlock-mcp", "--mandate", "./mandate.yaml"]
    }
  }
}
```

Generate the mandate first — this is the one command that uses a model:

```bash
interlock init --upstream-command "docker run -i --rm razorpay/mcp"
```

From a clone:

```bash
pnpm install && pnpm build
cp .env.example .env          # INTERLOCK_DB_PATH, INTERLOCK_CONSOLE_TOKEN
pnpm test                     # 275 tests
pnpm chaos:matrix --trials 20 # the kill matrix
pnpm bench --rail mock        # the scenario suite
```

---

## The guarantee

> **The only edge into a rail call is `AUTHORIZED → IN_FLIGHT`, and after the first attempt the only edge into `AUTHORIZED` is from `CONFIRMED_NOT_APPLIED`.**

The state machine is one literal switch over eleven states, so you can lay the code beside that sentence and check it. A test derives every edge in the table by brute force and asserts that exactly one of them has `IN_FLIGHT` on the right-hand side.

The chaos matrix asserts **"never two, and never unknown"** — deliberately not "always one". Killing the gate before it writes anything, or inside the request before the rail acts, correctly ends with no refund at all.

---

## The gates

```
  agent
    │
    ▼
┌───────────────────────────────────────────────────────────┐
│  G1  scope          tool granted, mandate live, agent ok   │  deterministic
│  G2  value          resolves every referent ITSELF         │  deterministic
│  G3  limits         windows + fee budget from rail fees    │  deterministic
│  G4  exactly-once   the ledger, the SIK, the reconciler    │  deterministic
│  G5  purpose        ◀── the model would go here, and only  │  NOT IN v0.1
│                         here, and it is off by default     │
│  G6  provenance     manifest pin, serves the pinned copy   │  deterministic
└───────────────────────────────────────────────────────────┘
    │
    ▼
  rail
```

**The model writes the policy. It never enforces it.** `interlock init` turns four plain-English answers into a mandate YAML; a person reads it and approves it; after that only deterministic code reads the file. There is no `--yes`.

Gate 5 is not implemented in v0.1 — a purpose judge cannot be honestly measured in a weekend, and a false *allow* moves money. What *is* implemented is the type that would make it safe:

```ts
export interface ModelGate {
  evaluate(context: GateContext): Promise<{
    verdict: AdvisoryVerdict;   // 'HOLD' | 'BLOCK'  — ALLOW is not in the union
    reason_code: string;
  }>;
}
```

A model gate cannot express an upgrade. Not "must not" — **cannot**, because there is no value it could return that means one. The ladder throws `InvariantViolation` on an attempted upgrade anyway, since a type only binds callers compiled against it. A property test over 10,000 random gate sequences asserts the final verdict is never higher-ranked than any individual result.

---

## Why exactly-once, on this rail

The money-out surface of Razorpay's MCP server is essentially `create_refund` and `create_instant_settlement`. Payouts are read-only there. So **duplicate refunds are not an edge case on this rail — they are the loss mechanism.**

Three traps sit in the reconciler, and each one silently double-refunds if missed:

1. **Absence on page one is not absence.** `CONFIRMED_NOT_APPLIED` is reachable only after pagination runs to exhaustion in that pass. The mock's page size is 3 so the loop is genuinely exercised.
2. **The rail is not read-your-writes.** The first query waits 2000 ms after the attempt, or an applied refund reads back absent.
3. **Amount is not an identity.** Two ₹3,400 refunds on one payment are indistinguishable by amount, so matching is on `receipt` and `notes.interlock_sik` — which is why every outbound refund is stamped on the way out.

---

## Prior art, and what is different

ScopeGate, AgentDojo, InjecAgent, ASB, AgentDyn, ToolEmu, FinToolBench; Nekuda, Skyfire KYAPay, Visa Trusted Agent Protocol, Lithic ASA; and the governance platforms — Fiddler, Arthur, IBM watsonx.governance, Microsoft Purview, Zenity.

**All of them are simulated. None model payment semantics — idempotency, reversibility class, partial refunds, settlement effects, mandate purpose. None report money.**

---

## Safety posture

Test mode only, own keys, own sandbox. Every scenario is drawn from **already-published** failure patterns; no new attack technique is invented here. Scenarios ship as fixtures against our own mock rail, not as generic attack tooling, and the defence ships in the same repository as the benchmark.

Findings are framed as *agent harnesses lack value-level authorization* — never as a vulnerability in any vendor's product. Razorpay's MCP server is the substrate this is built against, never the subject.

Responsible disclosure: nothing here targets a third party. If you believe something in this repository does, open an issue and it will be removed.

---

## Documented vs. constructed

| Documented, verified against public sources | Constructed for this benchmark |
| --- | --- |
| `create_refund` takes `amount`, `speed`, `notes`, `receipt` — and has **no destination field** | The scenario prose, the injected admin notes, the ticket text |
| Razorpay treats `receipt` as a per-payment idempotency key | The mock rail's fee model (configurable, arbitrary, and never read by a gate) |
| The MCP server's money-out surface is refunds and instant settlements | Blast-radius figures, which are dimensioned estimates of what each attack would have cost |
| Fees and tax come back on the response — no rate is hardcoded anywhere | The naive harness's scripted policy |

---

## Operating envelope

Single-tenant, single-process. SQLite with no HA. The console sits behind a shared bearer token rather than real auth. **Validated against the mock rail only** — the live Razorpay adapter is not in v0.1, and `--rail razorpay` refuses rather than pretending. Purpose-checking is opt-in, advisory, and not implemented.

The benchmark's headline delta currently comes from our own scripted strawman harness, which is labelled as such in every table. The stock LangGraph harness is wired and reports `did not run` until model responses are recorded into `packages/bench/.cache` — it is never allowed to invent one.

Naming the envelope precisely is the point. An unqualified claim would be the demo signal.

---

## Layout

```
packages/
  core/    canonical JSON, hashing, the semantic idempotency key, schemas
  store/   SQLite ledger, hash-chained audit log       (better-sqlite3, synchronous by design)
  gate/    bin/ proxy/ gates/ exactly-once/ rail/ init/
  chaos/   five-point kill matrix
  bench/   30 scenarios, two harnesses, scoring
scripts/check-thin.mjs   CI fails if any gate file exceeds 120 lines
```

Licensed MIT. Built for the Razorpay AI Buildathon.
