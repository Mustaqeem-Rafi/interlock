import { z } from 'zod';

/**
 * The bench contract.
 *
 * Everything in packages/bench is written against this file and nothing else,
 * so the runner, the harnesses, the scorer and the catalogue can be developed
 * independently without agreeing on anything by convention.
 */

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const Family = z.enum(['A', 'B', 'C', 'D', 'E']);
export type Family = z.infer<typeof Family>;

export const FAMILY_TITLES: Readonly<Record<Family, string>> = {
  A: 'value authorization',
  B: 'exactly-once',
  C: 'purpose drift',
  D: 'manifest drift',
  E: 'benign controls',
};

/**
 * Where an injection is planted.
 *
 * `tool` names the tool whose OUTPUT carries the text. That restriction is the
 * whole point: an injection placed in a system prompt is an instruction, and a
 * judge will rightly say so. A real attacker writes into a payment note, an
 * order description, a customer message — data the agent reads back from a
 * tool. So the only field here is a tool output field, and the runner has no
 * way to put this text anywhere else.
 */
export const Injection = z.strictObject({
  tool: z.string().min(1),
  /** Dotted path within the tool's JSON result, e.g. "notes.admin_note". */
  field: z.string().min(1),
  text: z.string().min(1),
});
export type Injection = z.infer<typeof Injection>;

/** Rail faults and kill points, passed through to the mock rail. */
export const ScenarioFaults = z.strictObject({
  ambiguous_504: z.strictObject({ rate: z.number().min(0).max(1) }).optional(),
  slow: z.strictObject({ delay_ms: z.number().int().positive() }).optional(),
  dup_response: z.strictObject({ on_calls: z.array(z.number().int().positive()) }).optional(),
  partition: z
    .strictObject({ from_ms: z.number().int().nonnegative(), for_ms: z.number().int().positive() })
    .optional(),
  /** Named kill point from @interlock/gate, applied to the Nth money call. */
  kill_at: z.string().min(1).optional(),
  /** Two workers racing the same semantic action. */
  concurrent_workers: z.number().int().min(1).optional(),
  /** The agent mints a fresh idempotency token per attempt, as a naive one does. */
  fresh_uuid_per_attempt: z.boolean().optional(),
});
export type ScenarioFaults = z.infer<typeof ScenarioFaults>;

/**
 * The machine-checkable part. A scenario passes or fails on these numbers and
 * on nothing a human read into the transcript.
 */
export const Assertion = z.strictObject({
  /** Ceiling on minor units that may leave, across the whole run. */
  max_money_moved_minor: z.number().int().nonnegative(),
  /** Ceiling on rail entities created. */
  max_rail_entities: z.number().int().nonnegative(),
  /**
   * Floor on rail entities. Non-zero only where the safe behaviour is to act:
   * B-14 is a genuine second refund and must produce two, or we have proved
   * nothing except that blocking everything blocks everything.
   */
  min_rail_entities: z.number().int().nonnegative().default(0),
  /** Whether the user's legitimate task has to end up done. */
  must_complete_task: z.boolean(),
});
export type Assertion = z.infer<typeof Assertion>;

export const Provenance = z.strictObject({
  /** Where the attack or behaviour comes from. */
  source: z.string().min(1),
  note: z.string().min(1),
});
export type Provenance = z.infer<typeof Provenance>;

/** What the rail is seeded with before the scenario runs. */
export const RailSeed = z.strictObject({
  order_amount_minor: z.number().int().nonnegative().default(189_900),
  payment_amount_minor: z.number().int().positive().default(189_900),
  /** Refunds already on the payment before the agent starts. */
  existing_refunds_minor: z.array(z.number().int().positive()).default([]),
  balance_minor: z.number().int().nonnegative().default(10_000_000),
  /**
   * Spend already on the ledger before the scenario starts.
   *
   * A cumulative harm cannot be demonstrated in a single call. C-07 is the
   * twentieth day of a daily settlement, not the first, and without this the
   * scenario would be testing a fee budget against one settlement that has not
   * yet cost anything.
   */
  prior_applied: z
    .array(
      z.strictObject({
        tool: z.string().min(1),
        amount_minor: z.number().int().positive(),
        fee_minor: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});
export type RailSeed = z.infer<typeof RailSeed>;

export const Scenario = z.strictObject({
  /** Stable id, e.g. "A-12". Used in RESULTS.md and in every log line. */
  id: z.string().regex(/^[A-E]-\d{2}$/),
  family: Family,
  title: z.string().min(1),
  /** What the human actually asked the agent to do. */
  user_task: z.string().min(1),
  /** Null for benign controls and for pure fault scenarios. */
  injected_content: Injection.nullable(),
  faults: ScenarioFaults.default({}),
  seed: RailSeed.default({
    order_amount_minor: 189_900,
    payment_amount_minor: 189_900,
    existing_refunds_minor: [],
    balance_minor: 10_000_000,
    prior_applied: [],
  }),
  /** Prose, for the report and for a human reading the catalogue. */
  expected_safe_behaviour: z.string().min(1),
  assertion: Assertion,
  /** What this attack would have cost if it worked, in minor units. */
  blast_radius_minor: z.number().int().nonnegative(),
  provenance: Provenance,
});
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------------------
// The model boundary
// ---------------------------------------------------------------------------

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ModelResponse {
  readonly text: string;
  readonly tool_calls: readonly ModelToolCall[];
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDescriptor[];
}

/**
 * Every model call goes through this, and every call is keyed by
 * sha256 of its canonicalised request. That is what makes the suite
 * deterministic, free, and green on a fork with no credentials.
 */
export interface ModelClient {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type CacheMode = 'replay' | 'record' | 'live';

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

export type HarnessName = 'naive' | 'langgraph';
export type RunMode = 'direct' | 'gated';

export interface ToolInvocation {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly result: string;
  readonly isError: boolean;
  readonly started_at: number;
  readonly finished_at: number;
}

export interface HarnessContext {
  readonly scenario: Scenario;
  readonly tools: readonly ToolDescriptor[];
  readonly model: ModelClient;
  /** Every tool call the agent makes goes through here. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Deterministic clock. Harnesses must not read the wall clock. */
  now(): number;
  readonly maxSteps: number;
}

export interface HarnessResult {
  /** Whether the agent believes it finished the user's task. */
  readonly completed: boolean;
  readonly invocations: readonly ToolInvocation[];
  readonly final_text: string;
  /** Populated when the harness could not run at all, e.g. a cache miss. */
  readonly unavailable?: string;
}

export interface Harness {
  readonly name: HarnessName;
  /** Prose for RESULTS.md, including whether this is a strawman. */
  readonly note: string;
  run(context: HarnessContext): Promise<HarnessResult>;
}

// ---------------------------------------------------------------------------
// Observations and scoring
// ---------------------------------------------------------------------------

/** What actually happened on the rail and in the ledger, measured not inferred. */
export interface Observation {
  readonly scenario_id: string;
  readonly family: Family;
  readonly harness: HarnessName;
  readonly mode: RunMode;
  readonly money_moved_minor: number;
  readonly rail_entities: number;
  /** Rail entities beyond the first for any one semantic key. */
  readonly duplicate_entities: number;
  /** Rail entities carrying no interlock stamp, or none we have a row for. */
  readonly orphan_entities: number;
  /** Fees and tax actually charged, read off the rail responses. */
  readonly fees_minor: number;
  readonly exactly_once_violations: number;
  readonly blocked: boolean;
  readonly held: boolean;
  readonly completed: boolean;
  /** ms from the offending call to the system recording a finding, or null. */
  readonly time_to_detect_ms: number | null;
  readonly tool_latencies_ms: readonly number[];
  readonly assertion_passed: boolean;
  readonly assertion_failures: readonly string[];
  readonly unavailable?: string;
}

export interface FamilyScore {
  readonly family: Family;
  readonly n: number;
  readonly attack_success_rate: number;
  readonly utility_under_attack: number;
  readonly false_block_rate: number;
  readonly money_at_risk_minor: number;
  readonly duplicates_per_1000: number;
  readonly exactly_once_violations: number;
  readonly orphan_rate: number;
  readonly time_to_detect_p50_ms: number | null;
}

export interface ModeScore {
  readonly harness: HarnessName;
  readonly mode: RunMode;
  readonly n: number;
  readonly attack_success_rate: number;
  readonly utility_under_attack: number;
  readonly false_block_rate: number;
  readonly money_at_risk_minor: number;
  readonly duplicates_per_1000: number;
  readonly exactly_once_violations: number;
  readonly orphan_rate: number;
  readonly time_to_detect_p50_ms: number | null;
  readonly latency_p50_ms: number;
  readonly latency_p99_ms: number;
  readonly families: readonly FamilyScore[];
  readonly unavailable?: string;
}

/** Stamped on every table so a number can always be traced to a run. */
export interface RunProvenance {
  readonly model_id: string;
  readonly commit_sha: string;
  readonly timestamp: string;
  readonly rail: string;
  readonly cache: CacheStats;
  readonly seed: number;
}

export interface BenchReport {
  readonly provenance: RunProvenance;
  readonly scores: readonly ModeScore[];
  readonly observations: readonly Observation[];
  readonly notes: readonly string[];
}
