import { describe, expect, it } from 'vitest';
import { base32Encode, sha256Bytes, sha256Hex } from './hash.js';

describe('sha256', () => {
  it('matches the published digest for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the published digest for the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes strings as UTF-8, so bytes and text agree', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(new TextEncoder().encode('abc')));
  });

  it('returns 32 raw bytes', () => {
    const digest = sha256Bytes('abc');
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.byteLength).toBe(32);
  });
});

describe('base32Encode', () => {
  const encode = (text: string): string => base32Encode(new TextEncoder().encode(text));

  // RFC 4648 section 10, with the padding stripped.
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %o as %o', (input, expected) => {
    expect(encode(input)).toBe(expected);
  });

  it('emits only the RFC 4648 alphabet', () => {
    expect(base32Encode(sha256Bytes('interlock'))).toMatch(/^[A-Z2-7]+$/);
  });

  it('encodes a 32-byte digest as 52 unpadded characters', () => {
    expect(base32Encode(sha256Bytes('interlock'))).toHaveLength(52);
  });

  it('handles every byte value without collapsing', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(base32Encode(all)).toHaveLength(Math.ceil((256 * 8) / 5));
  });
});
