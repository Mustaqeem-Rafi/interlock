import { Scenario } from './types.js';
import { SCENARIOS } from './scenarios/index.js';

/**
 * The scenario catalogue, parsed and validated once.
 *
 * Scenarios live as data under packages/bench/scenarios so they can be read and
 * argued about without reading any code. Everything here does is validate them
 * and refuse to run a malformed one.
 */

export function loadScenarios(): readonly Scenario[] {
  return SCENARIOS.map((raw, index) => {
    const parsed = Scenario.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown }).id;
      throw new ScenarioCatalogueError(
        `scenario ${typeof id === 'string' ? id : `#${String(index)}`} is malformed: ` +
          parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
      );
    }
    return parsed.data;
  });
}

/** Filter by id prefix or exact id, e.g. "A" for a family or "A-12" for one. */
export function selectScenarios(
  scenarios: readonly Scenario[],
  selector: string | undefined,
): readonly Scenario[] {
  if (selector === undefined || selector === '' || selector === 'all') return scenarios;
  const wanted = selector.split(',').map((part) => part.trim().toUpperCase());
  return scenarios.filter(
    (scenario) =>
      wanted.includes(scenario.id.toUpperCase()) || wanted.includes(scenario.family.toUpperCase()),
  );
}

export class ScenarioCatalogueError extends Error {
  readonly code = 'BENCH_CATALOGUE_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioCatalogueError';
  }
}
