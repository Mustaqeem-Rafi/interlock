import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const VALID = {
  INTERLOCK_DB_PATH: './data/interlock.db',
  INTERLOCK_CONSOLE_TOKEN: 'x'.repeat(32),
} as const;

describe('loadEnv', () => {
  it('accepts a minimal environment and defaults the rail to mock', () => {
    expect(loadEnv({ ...VALID })).toEqual({
      INTERLOCK_DB_PATH: './data/interlock.db',
      INTERLOCK_CONSOLE_TOKEN: 'x'.repeat(32),
      INTERLOCK_RAIL: 'mock',
    });
  });

  it('throws when a required variable is missing', () => {
    expect(() => loadEnv({ INTERLOCK_CONSOLE_TOKEN: 'x'.repeat(32) })).toThrow(EnvValidationError);
  });

  it('treats an empty string as missing', () => {
    expect(() => loadEnv({ ...VALID, INTERLOCK_DB_PATH: '   ' })).toThrow(EnvValidationError);
  });

  it('requires Razorpay credentials only when the razorpay rail is selected', () => {
    expect(() => loadEnv({ ...VALID, INTERLOCK_RAIL: 'razorpay' })).toThrow(EnvValidationError);
    expect(
      loadEnv({
        ...VALID,
        INTERLOCK_RAIL: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_test_abc',
        RAZORPAY_KEY_SECRET: 'secret',
      }).INTERLOCK_RAIL,
    ).toBe('razorpay');
  });
});
