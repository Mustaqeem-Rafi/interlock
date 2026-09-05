import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256Hex } from '@interlock/core';
import type { CacheStats, ModelRequest, ModelResponse, ModelToolCall } from './types.js';

/**
 * A filesystem-backed cache of model responses, keyed by the request.
 *
 * The property it buys is the one the bench claim rests on: a fork with no API
 * credentials runs the whole suite, gets byte-identical transcripts, and pays
 * nothing. A number in RESULTS.md is therefore reproducible by a reviewer who
 * has only the repo, which is the difference between a benchmark and a
 * screenshot.
 *
 * Entries are committed, so the on-disk form is written for review: pretty
 * JSON, one file per key, sharded two hex characters deep so no directory ever
 * holds thousands of entries.
 */

/** What lands on disk. Stable across versions — readers tolerate extra fields. */
export interface CacheEntry {
  readonly key: string;
  readonly model_id: string;
  /** Abbreviated key. `put` never sees the request, so this is all it can be. */
  readonly request_digest: string;
  readonly response: ModelResponse;
  /** Epoch ms. */
  readonly recorded_at: number;
}

export interface PromptCache {
  /**
   * `expectedModelId` is not part of the key — the key is the request — but an
   * entry recorded by a different model is a MISS, never a hit. Without that
   * check a re-run under `--model gpt-4o` would silently replay transcripts
   * produced by gpt-4o-mini while RunProvenance stamped the new name, which is
   * a fabricated number of exactly the kind this suite exists to rule out.
   * Omit it only where the recording model genuinely does not matter.
   */
  get(key: string, expectedModelId?: string): ModelResponse | null;
  put(key: string, modelId: string, response: ModelResponse): void;
  stats(): CacheStats;
}

const DIGEST_CHARS = 16;
const SHARD_CHARS = 2;

/**
 * The request, reduced to strings.
 *
 * `canonicalJson` rejects any number that is not a safe integer, and a JSON
 * Schema legitimately contains floats (`multipleOf: 0.01`, `minimum: 1.5`).
 * Feeding a tool catalogue to it straight would throw on a perfectly valid
 * schema, so the schema is flattened to its own JSON text first and only the
 * text is canonicalised. Everything below is a string; nothing here can trip
 * the integer rule.
 */
interface StableMessage {
  readonly role: string;
  readonly content: string;
  /** '' when absent. Real ids are never empty, so the collision is theoretical. */
  readonly tool_call_id: string;
  readonly name: string;
}

interface StableTool {
  readonly name: string;
  readonly description: string;
  readonly schema: string;
}

interface StableRequest {
  /** Bumping this invalidates every entry at once, which is the intent. */
  readonly v: string;
  readonly messages: readonly StableMessage[];
  readonly tools: readonly StableTool[];
}

const KEY_VERSION = '1';

/**
 * JSON.stringify with object keys sorted at every level. The replacer runs on
 * each nested value, so rebuilding the object with sorted keys is enough — two
 * tool descriptors that differ only in property order must not produce two
 * cache entries.
 */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const name of Object.keys(record).sort()) {
    sorted[name] = record[name];
  }
  return sorted;
}

function stableSchemaText(schema: unknown): string {
  // JSON.stringify returns undefined for undefined/function/symbol roots.
  const text = JSON.stringify(schema, sortedKeys);
  return text ?? 'null';
}

function stableKeyInput(request: ModelRequest): StableRequest {
  return {
    v: KEY_VERSION,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id ?? '',
      name: message.name ?? '',
    })),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: stableSchemaText(tool.inputSchema),
    })),
  };
}

export function cacheKey(request: ModelRequest): string {
  return sha256Hex(canonicalJson(stableKeyInput(request)));
}

function parseToolCalls(value: unknown): readonly ModelToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: ModelToolCall[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const id = record['id'];
    const name = record['name'];
    const args = record['arguments'];
    if (typeof id !== 'string' || typeof name !== 'string') return null;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
    calls.push({ id, name, arguments: args as Record<string, unknown> });
  }
  return calls;
}

/**
 * Validate a parsed cache file. Returns null for anything we would have to
 * guess about — a truncated write, a bad hand-edit, a key that does not match
 * its filename. Every such case is a miss, never a throw: a corrupt cache must
 * degrade to "record it again", not take the suite down.
 */
function parseEntry(value: unknown, key: string): ModelResponse | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (entry['key'] !== key) return null;
  const response = entry['response'];
  if (response === null || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const text = record['text'];
  if (typeof text !== 'string') return null;
  const toolCalls = parseToolCalls(record['tool_calls']);
  if (toolCalls === null) return null;
  return { text, tool_calls: toolCalls };
}

export function createPromptCache(dir: string): PromptCache {
  let hits = 0;
  let misses = 0;
  let writes = 0;
  // Only unique within this process; the pid keeps concurrent runners apart.
  let tempCounter = 0;

  const pathFor = (key: string): string => join(dir, key.slice(0, SHARD_CHARS), `${key}.json`);

  return {
    get(key: string): ModelResponse | null {
      let raw: string;
      try {
        raw = readFileSync(pathFor(key), 'utf8');
      } catch {
        misses += 1;
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        misses += 1;
        return null;
      }
      const response = parseEntry(parsed, key);
      if (response === null) {
        misses += 1;
        return null;
      }
      hits += 1;
      return response;
    },

    put(key: string, modelId: string, response: ModelResponse): void {
      const target = pathFor(key);
      // Lazily, so merely constructing a cache over a path creates nothing.
      mkdirSync(dirname(target), { recursive: true });
      const entry: CacheEntry = {
        key,
        model_id: modelId,
        request_digest: key.slice(0, DIGEST_CHARS),
        response: { text: response.text, tool_calls: response.tool_calls },
        recorded_at: Date.now(),
      };
      // Write-then-rename: a killed recorder leaves no half-file for a later
      // replay to read as a miss it cannot explain.
      tempCounter += 1;
      const temp = `${target}.${String(process.pid)}.${String(tempCounter)}.tmp`;
      writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      renameSync(temp, target);
      writes += 1;
    },

    stats(): CacheStats {
      return { hits, misses, writes };
    },
  };
}
