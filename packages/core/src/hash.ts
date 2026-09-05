import { createHash } from 'node:crypto';

/** RFC 4648 base32 alphabet. Uppercase, no padding, no ambiguous 0/1/8. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * RFC 4648 base32, unpadded.
 *
 * Base32 rather than hex or base64url because the SIK ends up in a Razorpay
 * `receipt`, which is case-insensitive and length-limited: base32 survives a
 * round trip through a system that upper-cases it, and 32 chars plus the "ilk_"
 * prefix fits the 40-character receipt budget.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET.charAt((buffer >>> bits) & 0b11111);
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 0b11111);
  }
  return out;
}
