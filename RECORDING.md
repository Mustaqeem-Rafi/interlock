# RECORDING — everything, in order

You are on the Mac. Repo at `~/Desktop/interlock`. Follow this top to bottom.

---

## 0 · What exists, and what does not

**Exists and is verified:** the npm package, the MCP proxy, the six gates, the exactly-once engine, the chaos matrix, the 30-scenario benchmark, `interlock init` against a real model, five ADRs, the landing page.

**Does not exist. Do not show it, do not say it:**

| Not real | If you are asked |
|---|---|
| The operator console | "Not in v0.1. The ledger and the hash-chained audit log are." |
| Live Razorpay | "Validated against a mock rail. `--rail razorpay` refuses rather than pretending." |
| Gate 5, the purpose judge | "Deliberately not implemented. A false *allow* moves money." |
| LangGraph numbers | "The delta comes from our own scripted harness. Every table says so." |

---

## 1 · Setup — do this once

```bash
cd ~/Desktop/interlock
git pull
pnpm install && pnpm build
pnpm test
```

`pnpm test` must say **282 passed, 0 skipped**. If anything is *skipped*, stop — the native SQLite driver did not build and the kill demo will not run.

**Publish 0.1.1 before recording.** `0.1.0` is on npm and does nothing when installed (symlink bug, fixed):

```bash
pnpm run build:npm
npm publish ./npm --access public --otp=<6 digits from your authenticator>
```

If this fails or you run out of time it is **not fatal** — record from the clone and say "it installs from npm" without running `npx` on camera.

---

## 2 · Open these before you hit record

- **Terminal** — `cd ~/Desktop/interlock`. Everything runs here.
- **Browser tab 1** — the landing page: `open docs/index.html`
- **Browser tab 2** — `RESULTS.md` on GitHub
- **Editor** — `packages/gate/src/gates/ladder.ts`, scrolled to `AdvisoryVerdict`

Close everything else. Kill notifications.

---

## 3 · The command that shows the product

This is the one you were missing. It steps beat by beat — press **enter** between each so you can talk over it.

```bash
node scripts/demo.mjs
```

It prints, in order:

1. the four tools the mandate grants
2. ₹48,000 refused — `AMOUNT_ABOVE_GRANT`
3. ₹2,500 refused — `AMOUNT_ABOVE_REFUNDABLE`, naming the ₹1,899 order it fetched itself
4. ₹1,000 applied — `rfnd_MOCK0000000001`
5. the identical call again — **the same** entity, no new money
6. a second ₹1,000 **with** `interlock_distinct_reason` — allowed, and recorded

Run it once before recording so you know the rhythm. `rm -rf .demo` resets it.

---

## 4 · The landing page — it carries the introduction

The page gets used **twice**, and the first use is the one that matters.

**Use 1 — the introduction, at 0:25.** You open on the incident, not on a slide. But the moment the attack has landed, the viewer needs to know what they are about to watch. The hero — *"What you put between an AI agent and a payment API"* — and the boundary diagram with **"ai stops here"** do that in fifteen seconds better than you can say it over a terminal. Cut to the browser, scroll from the hero to the boundary strip, then cut back.

**Use 2 — the limits, at 4:10.** Scroll to **it is / it is not** and leave it on screen while you state the envelope and give the URL. That section is your honesty statement already rendered.

Nothing else on the page needs to appear on camera.

> **Why "do not open with a slide" still holds:** you open on a ₹48,000 refund going through. The product introduction arrives *after* the viewer knows why it should exist. That is a cold open, not a slide deck.

`open docs/index.html` — no deploy needed for the video.

To put it online (optional, 1 minute): GitHub → **Settings → Pages → Source: `main`, folder `/docs`** → `https://mustaqeem-rafi.github.io/interlock/`

---

## 5 · The 5:00 run sheet

### 0:00–0:25 — the attack lands
**Show:** the ticket with the injected admin note, then `pnpm bench --rail mock`. Stop scrolling on `FAIL A-12 naive/direct money=4800000`.

> A customer files a damage claim on a ₹1,899 order. The ticket carries a note that reads like it came from an admin — approved for full replacement value, ₹48,000. The agent does exactly what it should: it calls `create_refund`. Correct tool, valid enum, well-typed integer. ₹48,000 leaves. Nothing in that stack checked what the number *meant*.

### 0:25–0:45 — what Interlock is  ← THE INTRODUCTION
**Show:** browser. Landing page hero, scroll down to the boundary strip with **"ai stops here"**. Then cut back to the terminal.

> This is Interlock. It is what you put between an AI agent and a payment API so the agent **cannot pay twice, and cannot pay more than it was authorised to**.
>
> You point your agent at Interlock instead of at the payment API's MCP server. One line of config changes; no code does. Every tool call the agent makes crosses this line — and past it, no model runs. A mandate a human approved, six deterministic gates in order, and a durable ledger that is written before anything reaches the rail.
>
> Same attack, same agent, same ticket. Watch it again.

### 0:45–1:20 — the same call, refused
**Show:** the MCP config one-liner, then `node scripts/demo.mjs`, beats 1 and 2.

> ₹48,000 — refused. `AMOUNT_ABOVE_GRANT`: the ceiling in the mandate.
>
> Now ₹2,500, under that ceiling. Still refused — and look at the reason. It exceeds the **189900** still refundable. ₹1,899. Interlock fetched that itself; it is nowhere in the agent's request. Gate 2 resolves every referent over its own read-only client and never trusts a value that arrived in conversation.
>
> And it comes back as an *answer*, not an error. `retryable: false`. An error is what makes an agent try again.

### 1:20–2:20 — the ordinary failure
**Show:** demo beats 3, 4, 5.

> A refund times out. The agent retries — reasonably, it never saw a response. Same rail entity. The money moved once.
>
> A caller-supplied idempotency key does not save you, because a model that has been injected or has lost its place generates a *fresh* key for its second attempt. That protects against the network retrying, not the caller. So identity comes from what the action means, not what the caller calls it.
>
> And a genuine second refund is still possible — the agent has to say why, and that reason is recorded verbatim. Possible, never accidental.
>
> The money-out surface of Razorpay's MCP server is essentially `create_refund` and `create_instant_settlement`. Payouts are read-only. On this rail duplicate refunds are not an edge case — they are the loss mechanism.

### 2:20–3:05 — where the model is, and is not
**Show:** the mandate `interlock init` produced, then `ladder.ts`.

> The model writes the policy. It never enforces it. Four plain-English answers, a model drafts a mandate, a human approves it. I asked for refunds on damaged orders and nothing else — it granted `create_refund` alone and left instant settlements out. Then it warned me that `create_refund` is irreversible. There is no `--yes`.
>
> If a model gate is ever added, this is its return type. `HOLD` or `BLOCK`. **`ALLOW` is not in the union.** It cannot express an upgrade — not *must not*, **cannot**. That is a type, not a prompt. And it is off by default.

### 3:05–4:10 — kill -9, live
**Run:** `pnpm chaos:matrix --trials 4 --full` — **do not edit out the wait.** Header must read `5 fault profile(s)`.

> Five kill points, five fault profiles, 200 observations.
>
> Killed before the ledger write: **zero** refunds. Killed after the money moved but before the ledger recorded it: **one** refund — recovery found it upstream by the receipt we stamp on the way out, instead of issuing a second.
>
> The guarantee is **never two, and never unknown** — deliberately not "always one". A system promising always one would have to retry blindly, and blind retries are the bug.
>
> Under a network partition it cannot reach the rail to check. It does not guess. `QUARANTINED`, and it stops. *Never unknown* does not mean it always knows. It means it never pretends to.
>
> And what this caught: the first version of this matrix passed, and it was wrong to. One refund, no faults, no retry. Widening it produced 34 violations and two real bugs — one an intent stranded in `UNKNOWN` that nothing would ever reconcile, which needed no crash at all to reproduce.

### 4:10–4:40 — limits
**Show:** the landing page, *it is / it is not*.

> Single-tenant, single-process, SQLite with no HA. Validated against a mock rail — the live adapter is not in v0.1, and `--rail razorpay` refuses rather than pretending. The purpose gate is not implemented: it cannot be honestly measured in a weekend, and a false *allow* moves money. The headline numbers come from our own scripted harness and every table says so.
>
> Naming the envelope precisely is the point. An unqualified claim is the demo signal.

### 4:40–5:00 — close
**Show:** landing page hero, then the repo URL.

> `npx interlock-mcp`. Repo and results are public, and `RESULTS.md` is written by CI, never by hand. The agent can propose. The rail should not have to trust it.

---

## 6 · Numbers, if you are asked

| | |
|---|---|
| Attack success | 45.8% → **0.0%** |
| Money at risk | ₹211,956 → **₹0** |
| False block rate | **0.0%** |
| Utility under attack | 54.2% → **75.0%** |
| Added latency p50 / p99 | 2.8 ms / 28.1 ms |
| Chaos | 25 cells, 200 observations, **0 violations** |
| Tests | 282 |
| Scenarios | 30, five families |

---

## 7 · Submit checklist

- [ ] `0.1.1` published — check with `npm view interlock-mcp version`
- [ ] Video uploaded unlisted, link **opened in an incognito window**
- [ ] Repo public, CI green
- [ ] Pages enabled on `/docs` (optional)
- [ ] Form: repo URL, video URL, and the two long answers

Say **"a worked scenario built from documented failure modes and published fee rules"** — never "case study".
