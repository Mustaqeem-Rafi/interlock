import { InvariantViolation } from '@interlock/core';
import { cacheKey, type PromptCache } from './cache.js';
import type {
  CacheMode,
  ModelClient,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ToolDescriptor,
} from './types.js';

/**
 * The three model clients the bench runs against, and the wrapper that decides
 * which one a run is allowed to reach.
 *
 * `InterlockErrorCode` is a closed union owned by @interlock/core and this
 * package may not extend it, so every failure below is an InvariantViolation
 * carrying a namespaced invariant string. Callers switch on the invariant, not
 * on the code.
 */

export const CACHE_MISS_INVARIANT = 'bench.cache_miss';
const NO_LIVE_MODEL_INVARIANT = 'bench.no_live_model';
const MODEL_PROTOCOL_INVARIANT = 'bench.model_protocol';
const MODEL_HTTP_INVARIANT = 'bench.model_http';

/**
 * Replay was asked for a prompt that has never been recorded.
 *
 * Carries the key so an operator sees exactly which entry is missing instead of
 * being told to re-record the whole suite.
 */
export class BenchCacheMissError extends InvariantViolation {
  readonly key: string;

  constructor(key: string, modelId: string) {
    super(
      CACHE_MISS_INVARIANT,
      `no cached response for ${key} (model ${modelId}); re-run with --record to record it`,
    );
    this.key = key;
  }
}

/**
 * The one failure a runner is expected to survive: a cache miss is a missing
 * recording, not a broken system, and the scenario is reported `unavailable`
 * rather than failed.
 */
export function isCacheMiss(error: unknown): boolean {
  return error instanceof InvariantViolation && error.invariant === CACHE_MISS_INVARIANT;
}

// ---------------------------------------------------------------------------
// Cache-fronted client
// ---------------------------------------------------------------------------

export interface CachedModelOptions {
  readonly cache: PromptCache;
  readonly mode: CacheMode;
  /** Required for 'record' and 'live'. Never consulted in 'replay'. */
  readonly live?: ModelClient;
  /** Stamped into cache entries and into RunProvenance.model_id. */
  readonly id: string;
}

export function createCachedModel(options: CachedModelOptions): ModelClient {
  const { cache, mode, live, id } = options;

  // Checked at construction, not on the first miss. An operator who asked to
  // record without credentials has misconfigured the run, and discovering that
  // forty scenarios in costs more than the tokens already spent.
  if (mode !== 'replay' && live === undefined) {
    throw new InvariantViolation(
      NO_LIVE_MODEL_INVARIANT,
      `cache mode '${mode}' needs a live model; none was supplied for ${id}`,
    );
  }

  const callLive = async (request: ModelRequest, key: string): Promise<ModelResponse> => {
    if (live === undefined) {
      throw new InvariantViolation(NO_LIVE_MODEL_INVARIANT, `no live model for ${id}`);
    }
    const response = await live.complete(request);
    cache.put(key, id, response);
    return response;
  };

  return {
    id,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const key = cacheKey(request);

      if (mode === 'live') return callLive(request, key);

      const cached = cache.get(key);
      if (cached !== null) return cached;

      if (mode === 'replay') throw new BenchCacheMissError(key, id);
      return callLive(request, key);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI chat completions
// ---------------------------------------------------------------------------

export interface OpenAiModelOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Defaults to the OpenAI v1 endpoint. Any compatible gateway works. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 120_000;

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * ModelMessage has no field for the tool_calls an assistant turn made, so a
 * literal `role: 'tool'` message would be rejected outright: the API requires
 * it to answer a preceding assistant tool_call that this type cannot express.
 * The result is replayed as a user-role observation instead, correlation id
 * intact. Only recording reaches this code; replay never does.
 */
function toChatMessage(message: ModelMessage): ChatMessage {
  if (message.role === 'tool') {
    const label = message.name ?? 'tool';
    const correlation = message.tool_call_id === undefined ? '' : ` (${message.tool_call_id})`;
    return { role: 'user', content: `Result of ${label}${correlation}:\n${message.content}` };
  }
  return { role: message.role, content: message.content };
}

function toFunctionTool(tool: ToolDescriptor): Record<string, unknown> {
  const parameters =
    tool.inputSchema === undefined || tool.inputSchema === null
      ? { type: 'object', properties: {} }
      : tool.inputSchema;
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Tool arguments arrive as a JSON string. Coercing an unparsable one to `{}`
 * would bake a different action than the model asked for into a cache entry
 * that is then replayed forever, so this fails loudly. Recording is always
 * interactive; there is someone there to see it.
 */
function parseArguments(raw: string, model: string, tool: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvariantViolation(
      MODEL_PROTOCOL_INVARIANT,
      `${model} sent unparsable arguments for ${tool}: ${raw.slice(0, 200)}`,
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new InvariantViolation(
      MODEL_PROTOCOL_INVARIANT,
      `${model} sent non-object arguments for ${tool}: ${raw.slice(0, 200)}`,
    );
  }
  return record;
}

function parseChatCompletion(payload: unknown, model: string): ModelResponse {
  const root = asRecord(payload);
  const choices = root === null ? undefined : root['choices'];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = asRecord(asRecord(first)?.['message']);
  if (message === null) {
    throw new InvariantViolation(MODEL_PROTOCOL_INVARIANT, `${model} returned no message`);
  }

  const calls: ModelToolCall[] = [];
  const rawCalls = message['tool_calls'];
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      const call = asRecord(raw);
      const fn = asRecord(call?.['function']);
      const id = call?.['id'];
      const name = fn?.['name'];
      const args = fn?.['arguments'];
      if (typeof id !== 'string' || typeof name !== 'string' || typeof args !== 'string') {
        throw new InvariantViolation(
          MODEL_PROTOCOL_INVARIANT,
          `${model} returned a malformed tool_call`,
        );
      }
      calls.push({ id, name, arguments: parseArguments(args, model, name) });
    }
  }

  const content = message['content'];
  return { text: typeof content === 'string' ? content : '', tool_calls: calls };
}

/** Deliberately minimal: this path runs only while recording a cache. */
export function createOpenAiModel(options: OpenAiModelOptions): ModelClient {
  const base = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${base}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: `openai/${options.model}`,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body: Record<string, unknown> = {
        model: options.model,
        // Not a determinism guarantee — that is what the cache is for — but it
        // makes the diff of a re-record readable.
        temperature: 0,
        messages: request.messages.map(toChatMessage),
        ...(request.tools.length === 0
          ? {}
          : { tools: request.tools.map(toFunctionTool), tool_choice: 'auto' }),
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new InvariantViolation(
          MODEL_HTTP_INVARIANT,
          `${options.model} HTTP ${String(response.status)}: ${detail.slice(0, 500)}`,
        );
      }

      return parseChatCompletion(await response.json(), options.model);
    },
  };
}

// ---------------------------------------------------------------------------
// Scripted client
// ---------------------------------------------------------------------------

/**
 * THIS IS NOT A LANGUAGE MODEL.
 *
 * `createScriptedModel` runs a hand-written policy: no network, no weights, no
 * sampling. It exists so the naive strawman harness can demonstrate the
 * mechanism — a credulous agent that mints a fresh idempotency token per
 * attempt and double-pays — on a clone with zero credentials.
 *
 * Every number produced through it is a fact about our harness, not a fact
 * about model behaviour. Nothing measured this way may be reported as an LLM
 * attack success rate, a refusal rate, or any other claim about a real model.
 * The client id is forced to carry the `scripted/` prefix for that reason: a
 * provenance line copied into RESULTS.md cannot accidentally read as a model.
 */
export const SCRIPTED_MODEL_ID = 'scripted/deterministic-v1';

const SCRIPTED_PREFIX = 'scripted/';

export interface ScriptedPolicy {
  readonly id: string;
  decide(request: ModelRequest): ModelResponse;
}

export function createScriptedModel(policy: ScriptedPolicy): ModelClient {
  return {
    // A policy that already declares itself scripted keeps its own id; anything
    // else gets prefixed rather than trusted.
    id: policy.id.startsWith(SCRIPTED_PREFIX)
      ? policy.id
      : `${SCRIPTED_MODEL_ID}/${policy.id}`,
    complete(request: ModelRequest): Promise<ModelResponse> {
      // Synchronous by construction; wrapped only to satisfy ModelClient.
      return Promise.resolve(policy.decide(request));
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BenchModelOptions {
  readonly cache: PromptCache;
  readonly mode: CacheMode;
  /** The id the run is stamped with, e.g. 'gpt-4o-mini'. */
  readonly modelId: string;
  /** The live model name to call. Defaults to the tail of `modelId`. */
  readonly model?: string;
  /** Absent under 'replay', which is the default posture on a fork. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * Assemble the client a run should use. `replay` never constructs a live
 * client, so a clone with no OPENAI_API_KEY still gets a fully working bench.
 */
export function createBenchModel(options: BenchModelOptions): ModelClient {
  const { cache, mode, modelId, apiKey, baseUrl } = options;

  if (mode === 'replay') {
    return createCachedModel({ cache, mode, id: modelId });
  }

  if (apiKey === undefined || apiKey === '') {
    throw new InvariantViolation(
      NO_LIVE_MODEL_INVARIANT,
      `cache mode '${mode}' needs an API key; set OPENAI_API_KEY or drop --record/--live`,
    );
  }

  const model = options.model ?? modelId.slice(modelId.lastIndexOf('/') + 1);
  const live = createOpenAiModel({
    apiKey,
    model,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });

  return createCachedModel({ cache, mode, live, id: modelId });
}
