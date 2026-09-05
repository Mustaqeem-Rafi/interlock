import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenarios, selectScenarios } from './catalogue.js';
import { createPromptCache } from './cache.js';
import { createScriptedModel } from './model.js';
import { benchPolicy } from './policy.js';
import { createNaiveHarness } from './harness/naive.js';
import { createLangGraphHarness } from './harness/langgraph.js';
import { renderBenchReport } from './report.js';
import { runBench } from './runner.js';
import { scoreAll } from './scoring.js';
import type { CacheMode, Harness, HarnessName, ModelClient, RunMode } from './types.js';

/**
 * `pnpm bench --rail mock --harness naive`
 *
 * Writes RESULTS.bench.md. Nothing here edits RESULTS.md directly: that file is
 * composed from the fragments each generator writes, so no generator can clobber
 * another's section and no human is tempted to hand-edit a number into it.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function has(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function commitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function cacheMode(argv: readonly string[]): CacheMode {
  if (has(argv, 'live')) return 'live';
  if (has(argv, 'record')) return 'record';
  return 'replay';
}

export async function main(argv: readonly string[]): Promise<number> {
  const rail = flag(argv, 'rail') ?? 'mock';
  if (rail !== 'mock') {
    process.stderr.write(
      `--rail ${rail} is not available here. Live runs go through the nightly workflow, ` +
        `deliberately: calling a payment API on every push is the judgement error this ` +
        `project is about.\n`,
    );
    return 2;
  }

  const which = (flag(argv, 'harness') ?? 'naive') as HarnessName | 'both';
  const modeArg = flag(argv, 'mode') ?? 'both';
  const modes: readonly RunMode[] =
    modeArg === 'both' ? (['direct', 'gated'] as const) : ([modeArg as RunMode] as const);

  const scenarios = selectScenarios(loadScenarios(), flag(argv, 'scenarios'));
  if (scenarios.length === 0) {
    process.stderr.write('no scenarios selected\n');
    return 2;
  }

  const cacheDir = resolve(REPO_ROOT, 'packages', 'bench', '.cache');
  const cache = createPromptCache(cacheDir);
  const mode = cacheMode(argv);
  const apiKey = process.env['OPENAI_API_KEY'];
  const modelId = flag(argv, 'model') ?? process.env['INTERLOCK_BENCH_MODEL'] ?? 'gpt-4o-mini';

  // The naive strawman runs on a deterministic scripted policy, not a model.
  // That is stated in the report rather than quietly assumed: any number it
  // produces is a fact about our harness, not about model behaviour.
  const scripted: ModelClient = createScriptedModel(benchPolicy());

  const harnesses: Harness[] = [];
  if (which === 'naive' || which === 'both') harnesses.push(createNaiveHarness());
  if (which === 'langgraph' || which === 'both') {
    harnesses.push(
      createLangGraphHarness({
        model: modelId,
        cacheDir,
        mode,
        ...(apiKey === undefined ? {} : { apiKey }),
      }),
    );
  }

  process.stdout.write(
    `bench: ${String(scenarios.length)} scenarios x ${String(harnesses.length)} harness(es) x ` +
      `${String(modes.length)} mode(s), cache ${mode}\n`,
  );

  const { observations, notes } = await runBench({
    scenarios,
    harnesses,
    modes,
    // The naive harness runs on the scripted policy; the langgraph harness
    // drives its own stock ChatOpenAI behind an HTTP-level cache and ignores
    // this. Neither path invents a model response.
    model: scripted,
    onResult: (observation) => {
      const mark = observation.assertion_passed ? 'ok  ' : 'FAIL';
      process.stdout.write(
        `  ${mark} ${observation.scenario_id} ${observation.harness}/${observation.mode} ` +
          `money=${String(observation.money_moved_minor)} entities=${String(
            observation.rail_entities,
          )}${observation.unavailable === undefined ? '' : ' (unavailable)'}\n`,
      );
    },
  });

  const report = {
    provenance: {
      model_id: harnesses.some((h) => h.name === 'langgraph') ? modelId : scripted.id,
      commit_sha: commitSha(),
      timestamp: new Date().toISOString(),
      rail,
      cache: cache.stats(),
      seed: 1,
    },
    scores: scoreAll(observations),
    observations,
    notes: [
      ...notes,
      `Scripted policy id: ${scripted.id}. The naive harness does not call a language model.`,
    ],
  };

  const out = resolve(flag(argv, 'out') ?? resolve(REPO_ROOT, 'RESULTS.bench.md'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderBenchReport(report), 'utf8');
  process.stdout.write(`\nwrote ${out}\n`);

  const failures = observations.filter((o) => !o.assertion_passed && o.mode === 'gated').length;
  process.stdout.write(`gated assertion failures: ${String(failures)}\n`);
  return 0;
}

if (import.meta.url.endsWith('cli.js')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
