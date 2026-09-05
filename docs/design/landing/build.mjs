// Splice gl.css and gl.js into the single deliverable between the marker comments. Re-runnable.
// Also writes QA-only variants next to this script (never ship them):
//   qa.html     same page, frames driven by a timer so an occluded automation window still animates, plus a debug hook
//   qa-2d.html  the head bootstrap removed → exactly the no-WebGL fallback page
//   qa-rm.html  bootstrap never adds .motion → the reduced-motion composition
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// The page this builds is the one the repository serves. It used to be an
// absolute path on one laptop, which meant the shipped page and the source it
// came from lived in different places and could only drift apart.
const target = new URL('../../index.html', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
let html = readFileSync(target, 'utf8');
const css = readFileSync(here + 'gl.css', 'utf8').trim();
let js = readFileSync(here + 'gl.js', 'utf8').trim();
const splice = (src, start, end, body) => {
  const a = src.indexOf(start), b = src.indexOf(end);
  if (a < 0 || b < 0 || b < a) throw new Error('markers missing: ' + start);
  return src.slice(0, a + start.length) + '\n' + body + '\n' + src.slice(b);
};
const HOOK = '/* qa:hook */';
if (!js.includes(HOOK)) throw new Error('gl.js lost the qa:hook marker');
html = splice(html, '/* gl:css:start */', '/* gl:css:end */', css);
const page = hookBody => splice(html, '<!-- gl:js:start -->', '<!-- gl:js:end -->', '<script type="module">\n' + js.replace(HOOK, hookBody) + '\n</script>');
const shipped = page('');
writeFileSync(target, shipped);
console.log('built', target, shipped.length, 'bytes', shipped.split('\n').length, 'lines');
/**
 * QA variants are a development aid and are never served.
 *
 * They used to be written unconditionally beside this script, which put three
 * 140KB pages inside the directory GitHub Pages publishes. They are now opt-in
 * (`node build.mjs --qa`) and land in a gitignored folder.
 *
 * The step is also no longer fatal. It looks for a marker inside the page, and
 * that search is line-ending sensitive: on a checkout with CRLF it failed and
 * took the whole build down with it, after the page had already been written
 * correctly. A dev aid must not be able to fail a build of the real artifact.
 */
if (process.argv.includes('--qa')) {
  const qaDir = here + '.qa/';
  mkdirSync(qaDir, { recursive: true });
  const shim =
    '<style>/* qa only */#gl,.lab,.xr-cap,.xr-index,.st,.brk,.rv,.gate{transition:none!important}</style>' +
    '<script>/* qa only */window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),33);' +
    'window.cancelAnimationFrame=id=>clearTimeout(id);</script>';
  const qa = page('window.__xray = { slots, SC, renderer, stack, dur, IC };').replace(
    '<meta charset="utf-8">',
    '<meta charset="utf-8">' + shim,
  );
  writeFileSync(qaDir + 'qa.html', qa);

  // Tolerate either line ending rather than assuming the one this machine uses.
  // Plain search on both line endings. A regex here needs the comment opener
  // escaped, and an unescaped '/*' is a quantifier rather than two characters —
  // which silently matched nothing instead of failing.
  const bootTail = String.fromCharCode(10) + '/* Decide the rendering mode';
  let bootStart = shipped.indexOf('<script>' + bootTail);
  if (bootStart < 0) bootStart = shipped.indexOf('<script>' + String.fromCharCode(13) + bootTail);
  if (bootStart < 0) {
    console.warn('qa: bootstrap marker not found, skipping the 2D fallback variant');
  } else {
    const bootEnd = shipped.indexOf('</script>', bootStart) + '</script>'.length;
    writeFileSync(qaDir + 'qa-2d.html', shipped.slice(0, bootStart) + shipped.slice(bootEnd));
  }
  writeFileSync(qaDir + 'qa-rm.html', qa.replace("if(!reduced) d.classList.add('motion');", ''));
  console.log('qa variants written to', qaDir);
}
