import { CanonicalizationError } from './errors.js';

/**
 * Deterministic JSON. Every hash in this system — the semantic idempotency key,
 * the mandate pin, the audit chain — is taken over the output of this function,
 * so "deterministic" has to mean byte-identical, not merely equivalent.
 *
 * The rules, and why each one exists:
 *
 *  - Object keys are sorted recursively, by UTF-16 code unit, locale-independent.
 *    Two callers that build the same object in a different order must collide.
 *  - No insignificant whitespace. There is exactly one encoding of a value.
 *  - Numbers must be safe integers. Money is minor units and timestamps are
 *    epoch ms, so a float is always a bug upstream; encoding one would bake
 *    IEEE-754 formatting into a hash. Rejected, never rounded.
 *  - `null` is emitted, never omitted. An absent optional and an explicit null
 *    must not hash alike, so the caller states which one it means.
 *  - `undefined` is rejected rather than dropped, because dropping it would make
 *    `{ a: undefined }` and `{}` collide silently.
 *  - Only plain objects and arrays. A Date or a Map has more than one plausible
 *    encoding, so it must be converted deliberately before it gets here.
 */

export type CanonicalPrimitive = string | number | boolean | null;

export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const MAX_DEPTH = 64;

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : `$${path.join('')}`;
}

function encodeNumber(value: number, path: readonly string[]): string {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalizationError(
      'CANONICAL_NON_INTEGER',
      formatPath(path),
      `${String(value)} is not a safe integer; money is minor units and timestamps are epoch ms`,
    );
  }
  // Normalises -0, which String() already renders as "0".
  return String(value + 0);
}

function encodeObject(
  value: object,
  path: readonly string[],
  depth: number,
  seen: Set<object>,
): string {
  if (seen.has(value)) {
    throw new CanonicalizationError('CANONICAL_CYCLE', formatPath(path), 'circular reference');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = (value as readonly unknown[]).map((item, index) =>
        encode(item, [...path, `[${index}]`], depth + 1, seen),
      );
      return `[${items.join(',')}]`;
    }
    if (!isPlainObject(value)) {
      throw new CanonicalizationError(
        'CANONICAL_UNSUPPORTED_TYPE',
        formatPath(path),
        `${value.constructor?.name ?? 'object'} has no canonical encoding; convert it first`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalizationError(
        'CANONICAL_UNSUPPORTED_TYPE',
        formatPath(path),
        'symbol keys have no canonical encoding',
      );
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort(compareKeys)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${encode(record[key], [...path, `.${key}`], depth + 1, seen)}`,
      );
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function encode(
  value: unknown,
  path: readonly string[],
  depth: number,
  seen: Set<object>,
): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError(
      'CANONICAL_DEPTH',
      formatPath(path),
      `nested deeper than ${MAX_DEPTH}`,
    );
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return encodeNumber(value, path);
    case 'object':
      return encodeObject(value, path, depth, seen);
    case 'undefined':
      throw new CanonicalizationError(
        'CANONICAL_UNDEFINED',
        formatPath(path),
        'undefined has no canonical encoding; write an explicit null',
      );
    default:
      throw new CanonicalizationError(
        'CANONICAL_UNSUPPORTED_TYPE',
        formatPath(path),
        `${typeof value} has no canonical encoding`,
      );
  }
}

/**
 * Serialise a value to its single canonical form. Accepts `unknown` and
 * validates at runtime, because the values that reach it have usually come off
 * the wire and their static type is a claim, not a guarantee.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, [], 0, new Set<object>());
}
