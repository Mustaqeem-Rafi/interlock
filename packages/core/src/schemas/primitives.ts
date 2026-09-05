import { z } from 'zod';

/**
 * Money is an integer in minor units, always.
 *
 * `z.number().int()` rejects `1000.5`; it does not round it. That is the whole
 * point — a float reaching this boundary means an upstream layer did arithmetic
 * on rupees, and silently coercing it would hide the bug inside a hash.
 */
export const MinorAmount = z.number().int();
export type MinorAmount = z.infer<typeof MinorAmount>;

export const NonNegativeMinorAmount = MinorAmount.nonnegative();
export const PositiveMinorAmount = MinorAmount.positive();

/** Epoch milliseconds. Never a Date, never an ISO string. */
export const EpochMs = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;

export const DurationMs = z.number().int().positive();

export const Currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 alphabetic code');
export type Currency = z.infer<typeof Currency>;

export const MerchantId = z.string().min(1);
export type MerchantId = z.infer<typeof MerchantId>;

export const ToolName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected a snake_case tool name');
export type ToolName = z.infer<typeof ToolName>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex characters');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const Sik = z.string().regex(/^[A-Z2-7]{32}$/, 'expected a 32-character base32 SIK');
export type Sik = z.infer<typeof Sik>;

/**
 * How much of a mistake survives the mistake.
 *
 *  - `reversible`   — we can undo it ourselves with an inverse call.
 *  - `compensable`  — cannot be undone, but a compensating action exists.
 *  - `irreversible` — the money is gone. create_refund, create_instant_settlement.
 */
export const ReversibilityClass = z.enum(['reversible', 'compensable', 'irreversible']);
export type ReversibilityClass = z.infer<typeof ReversibilityClass>;

/** How far a tool manifest is trusted. Gate 6 reads this. */
export const TrustTier = z.enum(['pinned', 'known', 'untrusted']);
export type TrustTier = z.infer<typeof TrustTier>;
