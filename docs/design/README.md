# Design

What the two front-end surfaces are, where their source lives, and which parts of them ship.

## The operator console

`packages/gate/console.html` — one file, served by `interlock-console` at `/`.

It is **not** a mockup. It was designed against a stated API contract and the gate was extended to serve that contract, rather than the design being rewritten around whatever the store happened to expose. The contract is `packages/gate/src/api/routes.ts`; the read models that fill it are `packages/gate/src/api/console-api.ts`.

The page carries its own offline mode. Opened with no gate URL it runs `LocalGate`, a set of seeded fixtures, so the design can be reviewed without a ledger. When the gate serves it, `window.INTERLOCK_GATE_URL` is injected at response time and it talks to the real backend instead. That injection matters: without it a real deployment would quietly show fixtures, which is the worst failure available to a surface whose only job is to say what actually happened.

Where the ledger cannot answer something the console asks for, the answer is a zero and a comment saying why — see `orphans_detected`, which is 0 because nothing scans for orphans at runtime, not because none were found.

## The landing page

`docs/index.html` — served by GitHub Pages from `/docs`.

**It is generated.** The source is in `landing/`:

| | |
| --- | --- |
| `landing/gl.css`, `landing/gl.js` | the animated x-ray: spliced into the page between marker comments |
| `landing/build.mjs` | does the splicing. `node docs/design/landing/build.mjs` |
| `landing/plan.md` | the design plan |
| `landing/QA-NOTES.md` | what was checked, at which viewports, and which environment quirks distort a screenshot |

Everything outside the two marker blocks — all the prose — is edited in `docs/index.html` directly and survives a rebuild. Run the build after changing `gl.css` or `gl.js`; it is idempotent, so running it twice changes nothing.

`build.mjs --qa` writes three development-only variants to `landing/.qa/` (gitignored): a timer-driven page for automated capture, the no-WebGL fallback, and the reduced-motion composition. They are never served.

## Both surfaces are real

Neither of these is a picture of something that does not exist. The console reads the ledger; the landing page's claims are the ones the repository can back, and the five that it could not — a console that had not been built, validation against Razorpay test mode that had never been run, a scenario count that was wrong, and a quickstart flag that did not exist — were removed rather than left as design intent.
