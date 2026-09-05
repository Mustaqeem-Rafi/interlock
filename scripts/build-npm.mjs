#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Build the single publishable package from the workspace.
 *
 * The workspace depends on itself with `workspace:*`, which npm cannot resolve
 * for a consumer, so the three internal packages are inlined into each binary
 * rather than published as three more names nobody would install separately.
 *
 * better-sqlite3 stays external and stays a real dependency. It is a native
 * addon, so bundling its JavaScript would only orphan the .node binary it
 * loads; and it is external for a second reason worth stating, since it is the
 * whole reason it was chosen: its writes are synchronous, which is what lets
 * the ledger row provably precede the rail call. Swapping it for something
 * bundleable would quietly break invariant I2.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(REPO, 'npm');
const DIST = join(OUT, 'dist');

const BINARIES = ['interlock-mcp', 'interlock-init', 'interlock-console'];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(OUT, 'examples'), { recursive: true });

await build({
  entryPoints: BINARIES.map((name) => join(REPO, 'packages', 'gate', 'src', 'bin', `${name}.ts`)),
  outdir: DIST,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3'],
  /**
   * The MCP SDK spawns child processes through cross-spawn, which is CommonJS
   * and calls require() at runtime. In ESM output esbuild replaces that with a
   * stub that throws "Dynamic require of ... is not supported" — at module
   * load, so both binaries died on import before running a line of our code.
   * A real createRequire, bound to this file, is what makes the bundle behave
   * like the CJS the dependency was written as.
   */
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __interlockCreateRequire } from 'node:module';",
      'const require = __interlockCreateRequire(import.meta.url);',
    ].join(String.fromCharCode(10)),
  },
  logLevel: 'info',
});

/**
 * The store finds its DDL with `new URL('../schema.sql', import.meta.url)`.
 * esbuild leaves import.meta alone in ESM output, so that resolves relative to
 * the bundle: npm/dist/x.js -> npm/schema.sql. Depth-sensitive, therefore
 * asserted below rather than assumed.
 */
/**
 * esbuild emits the entry file's own hashbang after the banner, so line 1 is
 * ours and line N is a stray `#!` that is a syntax error anywhere but line 1.
 * It is blanked rather than deleted so the line numbering the sourcemap was
 * generated against still holds.
 */
for (const name of BINARIES) {
  const file = join(DIST, `${name}.js`);
  const lines = readFileSync(file, 'utf8').split(String.fromCharCode(10));
  let stray = 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '#!/usr/bin/env node') {
      lines[i] = '//';
      stray += 1;
    }
  }
  if (stray > 0) writeFileSync(file, lines.join(String.fromCharCode(10)));
}

copyFileSync(join(REPO, 'packages', 'store', 'schema.sql'), join(OUT, 'schema.sql'));
// The console page, resolved by the server at ../console.html from the bundle.
copyFileSync(join(REPO, 'packages', 'gate', 'console.html'), join(OUT, 'console.html'));
copyFileSync(join(REPO, 'README.md'), join(OUT, 'README.md'));
copyFileSync(join(REPO, 'LICENSE'), join(OUT, 'LICENSE'));
copyFileSync(join(REPO, 'examples', 'mandate.yaml'), join(OUT, 'examples', 'mandate.yaml'));

const manifest = JSON.parse(readFileSync(join(OUT, 'package.json'), 'utf8'));
const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
if (manifest.version !== root.version) {
  manifest.version = root.version;
  writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`build-npm: version synced to ${root.version}`);
}

// --- the checks, because a broken publish is discovered by strangers ---

const problems = [];

/**
 * The separation, asserted against the shipped bytes.
 *
 * `interlock init` is the one command that sends anything to a model. If a
 * refactor ever routed it through the engine, this bundle would start carrying
 * the ledger and the state machine, and the sentence "no model is consulted at
 * decision time" would be a comment rather than a fact about the artifact.
 * Reading the output for the things that must not be in it is cheap; noticing
 * the drift later is not.
 *
 * The markers are the ledger driver, its durability pragmas and the WAL's
 * outbound stamp — the engine itself. Deliberately not the state names: those
 * are Zod schemas in core, and init legitimately carries the vocabulary a
 * mandate is written in without carrying the machine that runs on it.
 */
const initBundle = readFileSync(join(DIST, 'interlock-init.js'), 'utf8');
for (const forbidden of ['better-sqlite3', 'PRAGMA', 'interlock_sik']) {
  if (initBundle.includes(forbidden)) {
    problems.push(
      `interlock-init: the authoring binary reached the money path — it contains "${forbidden}"`,
    );
  }
}

for (const name of BINARIES) {
  const file = join(DIST, `${name}.js`);
  const text = readFileSync(file, 'utf8');
  // esbuild hoists the entry file's hashbang to the top of the bundle. These
  // two files are what npm links onto PATH, so if that ever stops being true
  // the package installs and then fails to run — assert it here instead.
  if (!text.startsWith('#!/usr/bin/env node')) problems.push(`${name}: no shebang on line 1`);
  // A `workspace:` specifier or a bare @interlock import surviving into the
  // bundle means a consumer's install resolves nothing.
  const leaked = /from ["']@interlock\//.exec(text);
  if (leaked) problems.push(`${name}: an @interlock import survived bundling`);
  for (const bare of text.matchAll(/^import\s+[^;]*?from\s*["']([^."'][^"']*)["']/gm)) {
    const spec = bare[1];
    if (spec.startsWith('node:') || spec === 'better-sqlite3') continue;
    problems.push(`${name}: unbundled runtime import "${spec}" is not a declared dependency`);
  }
  console.log(`build-npm: ${name}.js  ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

/**
 * Actually run the artifact. --version short-circuits before anything opens,
 * but the imports are evaluated first, so this fails if the bundle is broken at
 * module scope — which is the failure mode a structural check cannot see.
 *
 * The one tolerated failure is better-sqlite3 being absent or unloadable, which
 * says the build machine has no prebuild for its Node ABI, not that the package
 * is wrong. It is reported rather than swallowed, and CI runs the full
 * pack-install-and-refund check on a Node version where the driver loads.
 */
for (const name of BINARIES) {
  let printed;
  try {
    printed = execFileSync(process.execPath, [join(DIST, `${name}.js`), '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    const missingDriver =
      stderr.includes("Cannot find package 'better-sqlite3'") ||
      stderr.includes('better_sqlite3.node');
    if (!missingDriver) {
      problems.push(`${name}: failed to execute — ${stderr.split(String.fromCharCode(10))[0] ?? String(error)}`);
      continue;
    }
    console.log(
      `build-npm: ${name}.js not executed here — better-sqlite3 has no binary for ` +
        `Node ${process.versions.node}. CI runs this on Node 22.`,
    );
    continue;
  }
  if (printed !== manifest.version) {
    problems.push(`${name}: --version printed "${printed}", package.json says "${manifest.version}"`);
  }
}

if (problems.length > 0) {
  console.error(`\nbuild-npm: refusing to ship\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

console.log('build-npm: ok');
