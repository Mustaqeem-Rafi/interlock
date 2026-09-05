import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { CanonicalizationError } from './errors.js';

/** Rebuild an object with its keys in the opposite order, recursively. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) out[key] = reverseKeyOrder(nested);
  return out;
}

describe('canonicalJson: key ordering', () => {
  it('is byte-identical under key reordering', () => {
    const a = {
      merchant_id: 'acc_1',
      amount_minor: 250_000,
      nested: { z: 1, a: 2, m: { y: 3, b: 4 } },
      list: [{ b: 1, a: 2 }],
    };
    const b = {
      list: [{ a: 2, b: 1 }],
      nested: { m: { b: 4, y: 3 }, a: 2, z: 1 },
      amount_minor: 250_000,
      merchant_id: 'acc_1',
    };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe(canonicalJson(reverseKeyOrder(a)));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: [1, 2] })).toBe('{"a":[1,2],"b":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('sorts by code unit, not by locale', () => {
    expect(canonicalJson({ b: 0, A: 0, a: 0, B: 0 })).toBe('{"A":0,"B":0,"a":0,"b":0}');
  });
});

describe('canonicalJson: numbers', () => {
  it('rejects a float rather than rounding it', () => {
    expect(() => canonicalJson({ amount_minor: 1000.5 })).toThrow(CanonicalizationError);
    try {
      canonicalJson({ amount_minor: 1000.5 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CanonicalizationError).code).toBe('CANONICAL_NON_INTEGER');
      expect((error as CanonicalizationError).path).toBe('$.amount_minor');
    }
  });

  it('rejects NaN, Infinity and unsafe integers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 2)).toThrow(CanonicalizationError);
  });

  it('accepts integers, including negatives, and normalises -0', () => {
    expect(canonicalJson({ a: -250, b: 0, c: -0 })).toBe('{"a":-250,"b":0,"c":0}');
  });
});

describe('canonicalJson: null and undefined', () => {
  it('emits null, never omits it', () => {
    expect(canonicalJson({ window: null, distinct: null })).toBe('{"distinct":null,"window":null}');
  });

  it('distinguishes an explicit null from an absent key', () => {
    expect(canonicalJson({ window: null })).not.toBe(canonicalJson({}));
  });

  it('rejects undefined rather than dropping it', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalizationError);
  });
});

describe('canonicalJson: unsupported values', () => {
  it('rejects values with more than one plausible encoding', () => {
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalizationError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalizationError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalizationError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalizationError);
  });

  it('accepts a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['b'] = 1;
    bare['a'] = 2;
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });

  it('rejects a cycle instead of hanging', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalizationError);
  });

  it('allows the same object to appear twice side by side', () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});

describe('canonicalJson: strings', () => {
  it('escapes consistently and survives a JSON round trip', () => {
    const value = { s: 'a"b\\c\nd\tef' };
    expect(canonicalJson(value)).toBe(canonicalJson(JSON.parse(canonicalJson(value))));
  });

  it('does not normalise unicode, so distinct code points stay distinct', () => {
    // Precomposed U+00E9 against decomposed "e" + U+0301.
    expect(canonicalJson({ s: 'é' })).not.toBe(canonicalJson({ s: 'é' }));
  });
});
