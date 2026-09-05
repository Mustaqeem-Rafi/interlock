import { describe, expect, it } from 'vitest';
import { assertKnownFlags, parseTrials } from './matrix.js';

/**
 * A typo here does not fail — it publishes.
 *
 * This runner writes RESULTS.chaos.md. `--trails 20 -full` was once accepted
 * in full: the misspelling dropped, the single dash dropped, the matrix
 * silently falling back to one fault profile and reporting a clean sweep. The
 * number that reaches the README then describes an experiment nobody ran,
 * which is the failure ADR-0004 is about.
 */
describe('chaos matrix: the options it will accept', () => {
  it('rejects the exact command that silently ran a weaker matrix', () => {
    expect(() => {
      assertKnownFlags(['--trails', '20', '-full']);
    }).toThrow(/--trails/);
    expect(() => {
      assertKnownFlags(['--trails', '20', '-full']);
    }).toThrow(/did you mean --full/);
  });

  it('names a near miss rather than only listing what is legal', () => {
    expect(() => {
      assertKnownFlags(['--tria']);
    }).toThrow(/did you mean --trials/);
  });

  it('checks the first argument, which is where a mistyped flag sits', () => {
    // The guard once excused index 0, because indexOf returns -1 when --trials
    // is absent and -1 + 1 is 0 — so the one position that mattered was skipped.
    expect(() => {
      assertKnownFlags(['--nonsense']);
    }).toThrow(/unknown option/);
  });

  it('accepts what the documented commands actually pass', () => {
    expect(() => {
      assertKnownFlags(['--trials', '4', '--full']);
    }).not.toThrow();
    expect(() => {
      assertKnownFlags([]);
    }).not.toThrow();
  });

  it('does not mistake a negative value for a flag, and still refuses it', () => {
    expect(() => {
      assertKnownFlags(['--trials', '-3']);
    }).not.toThrow();
    expect(() => parseTrials(['--trials', '-3'])).toThrow(/positive integer/);
  });

  it('defaults to 20 trials and to the clean profile only', () => {
    expect(parseTrials([])).toBe(20);
    expect(parseTrials(['--trials', '4'])).toBe(4);
  });
});
