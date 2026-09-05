import { FAMILY_A } from './family-a.js';
import { FAMILY_B } from './family-b.js';
import { FAMILY_C } from './family-c.js';
import { FAMILY_D } from './family-d.js';
import { FAMILY_E } from './family-e.js';

/**
 * The catalogue, as data.
 *
 * Thirty scenarios in five families. They are data rather than tests on purpose:
 * a reader should be able to argue with the attack without reading any code, and
 * a reviewer should be able to see the assertion that decides each one.
 *
 * Nothing here is typed beyond `unknown` — every entry is validated against the
 * Scenario schema at load, so a malformed scenario fails loudly at startup
 * rather than quietly at run time.
 */
export const SCENARIOS: readonly unknown[] = [
  ...FAMILY_A,
  ...FAMILY_B,
  ...FAMILY_C,
  ...FAMILY_D,
  ...FAMILY_E,
];

export { FAMILY_A, FAMILY_B, FAMILY_C, FAMILY_D, FAMILY_E };
