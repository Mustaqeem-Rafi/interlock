# Interlock x-ray upgrade — state and QA log

Updated 2026-09-05 (second session). The deliverable is `index (5).html`; everything here describes it.

## Layout of the work

- `index (5).html` — the single-file deliverable. Your copy edits from between sessions ("View the source", "Get it on npm", real GitHub/npm links) are preserved; the build only replaces the two marked blocks.
- `_xray-work/gl.js`, `_xray-work/gl.css` — the module and CSS spliced into the HTML between `/* gl:css:start */…` and `<!-- gl:js:start -->…`. Edit these, then run `node _xray-work/build.mjs`.
- `_xray-work/build.mjs` also writes QA-only pages next to itself (never ship them): `qa.html` (timer-driven frames + `window.__xray` debug hook), `qa-2d.html` (bootstrap removed = the no-WebGL page), `qa-rm.html` (reduced-motion composition), `qa-mobile.html` (a 420×560 iframe around qa.html).
- `_xray-work/serve.mjs` — `node _xray-work/serve.mjs` serves the folder at http://127.0.0.1:8765/ and the work folder at /qa/. The Chrome extension refuses file:// URLs.
- `_xray-work/index5.orig.html` — the page before any of this work. `plan.md`, `critique.txt` — design plan and the three-lens critique it was revised against.

## Verified in this session (desktop 1366×641, DPR 1, Chrome)

Hero: p 0, .10, .21, .30, .42, .50–.53 (resolve probe + label), .60–.75 (evidence rows, red shutter, verdict chip, end-stop), .86, .97 (full reveal with proxy / never-ran / intent / rail labels, rail no longer clipped). Copy and readout fade; three captions; index; no console errors; 21 draw calls / 1,280 triangles for the hero.
Gates dive: landscape orientation in the sticky column; overview, gate 02 focus, gate 05 (amber, lifted, "not in the path" note), outro (intent + rail + outcome verified); index bottom-right; hover/click wiring present (not exercised — no real pointer here).
Kill -9: PROPOSED, IN_FLIGHT (write line, fsync label, lease), TERMINATED (frame fades, ghost call), UNKNOWN (restart frame, read line, expired lease, amber terminal), RECONCILING ×n (probe lines, list ticks in sync), QUARANTINED (red fence). Rail in frame. State label below the record.
CTA: full-width stage above the final grid; packet crossing; gate 05 bypassed; intent fill; rail once; verification read-back; APPLIED · VERIFIED green; progress completes when the stage is fully in view.
2D fallback (qa-2d): original two-column hero with the SVG trace, no stages, timed replay completes, sticky side panel.
Reduced motion (qa-rm): still poses for hero (stack right of the copy), dive (overview), kill (QUARANTINED), CTA (APPLIED).
Mobile (420×560 iframe): copy in flow above the pinned stage, compact 3-cell readout, no horizontal overflow (a `.gl .gate` grid rule that outranked the page's mobile rule was the cause and is fixed), portrait reveal as a vertical stack shifted right of the caption, gate 02 hold centred, fewer evidence labels, dive strip sticky at the top.

## Environment quirks that distort screenshots (not page bugs)

- The automation Chrome window never fires `requestAnimationFrame`; QA pages shim it with a 33ms timer. Real browsers are unaffected.
- CSS transitions and IntersectionObserver callbacks only advance when a capture forces a frame; QA pages disable transitions. `.gate.in` / `.rv.in` reveals therefore lag in screenshots.
- A capture can show the previous committed frame; take two screenshots and trust the second.
- `html{scroll-behavior:smooth}` animates programmatic scrolls; QA helpers set it to auto. Hash navigation could not be judged for the same reason.
- The viewport height flips between 585 and 641 as an infobar toggles; `resize_window` below ~1000px wide is ignored (hence the iframe harness).
- Occasional `Page.captureScreenshot` timeouts freeze the tab for ~30s; nothing in the page hangs (JS stays responsive).

## Still open

- [ ] Real-browser pass with a mouse: pointer parallax feel, dive hover focus + click-to-scroll, damping feel at 60/120Hz, hash navigation from the nav (`jump` snap when |Δp| > .2), performance on an integrated GPU at DPR 1.75 (adaptive DPR step-down is in place but unmeasured).
- [ ] Mobile pass on a real phone: touch scrolling through the 520vh hero and URL-bar resize behaviour (`100lvh` canvas, `100svh` stage). In the 420×560 iframe harness the hero (p 0, .75, .97), the dive strip, the kill strip and the CTA were all checked and the label sets trimmed for the small stages.
- [ ] Reduced motion at runtime: the mode is chosen at load; toggling the OS setting mid-visit is not handled.
- [ ] Anchor landing under the sticky header uses `scroll-margin-top:78px`; untested in this environment.
- [ ] Copy edits you make in `index (5).html` are safe; edits inside the two marked blocks are overwritten by the next build — change `gl.css`/`gl.js` instead.
