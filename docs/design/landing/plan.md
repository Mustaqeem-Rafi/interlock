# Interlock landing page — 3D / scroll-choreography design plan (v1, for critique)

Source file under edit: `C:\Users\DELL\Desktop\interlock-landing-page\index (5).html` (991 lines, single file, vanilla HTML/CSS/JS, IBM Plex Sans + Mono, dark neutral palette). Read it before critiquing; every piece of copy, evidence and technical claim on it must survive.

## Condensed brief (the client's hard requirements)

Product truth: Interlock is an MCP proxy between an AI agent and an upstream MCP/payment API. Path: AGENT → MANDATE → GATES (01 scope, 02 value, 03 limits, 04 exactly-once, 05 purpose = model, optional, off by default, downgrade-only; 06 provenance) → INTENT → RAIL → OUTCOME. AI is never runtime authority; deterministic code touches the money. Canonical incident: agent proposed ₹48,000 (create_refund), rail-resolved authority ₹1,899 (order_A8841, claimed_line_item_minor 189900), Gate 02 → VALUE_NOT_AUTHORISED → BLOCK, rail call 0, intent never written. Second act: a valid ₹2,800 refund: PROPOSED → AUTHORIZED → IN_FLIGHT → process killed (kill -9) → UNKNOWN → RECONCILING ×6 → QUARANTINED; "Unknown never means retry." Benchmarks stay `TBD` (populated only by `fillResults()` from RESULTS.md). Public demo runs against a mock rail.

Creative idea: the page becomes an interactive x-ray / 3D cross-section of the control plane. Scrolling = moving a camera through the layers (AGENT → MCP → PROXY → MANDATE → GATE 01…06 → INTENT → RAIL). Real WebGL (Three.js via CDN, one HTML file, no framework, no build). One "InterlockStack" object: deep layered tunnel, each layer at a different z (depth) position; the camera dollies through; a single request packet carries ₹48,000, physically stops at the Gate 02 plane, downstream stays dormant, rail visibly never called (absence is the evidence). Progressive forensic evidence reveal at Gate 02 (VALUE_NOT_AUTHORISED → resolved_order → claimed_line_item_minor 189900 → ₹1,899 → rail call 0). Pull-back reveal of the whole mechanism. Proxy = a membrane between AI world and payment world; "AI stops here" = a physical plane; above it looser/semantic geometry, below it rigid/rectilinear/mechanical. Gate 05 = deliberate anomaly: dashed, amber, offset, "MODEL · OFF BY DEFAULT". Kill -9 = second 3D scene: process object disappears (no explosion), durable intent block survives, long pause at UNKNOWN (freeze motion), reconciliation ticks ×1…×6, QUARANTINED. Final CTA: ₹2,800 clean path, green only at APPLIED · VERIFIED.

Hard constraints: 2–3 major 3D moments only (contrast matters); scroll position drives state, scrubs both ways; lerp/damped motion; pinned/sticky scenes (no GSAP unless truly necessary); pointer parallax ~1–2% desktop only; restrained lighting; palette stays semantic (neutral system, green allowed, amber hold/model/unknown, red blocked, blue links) — colour rare; no neon/cyberpunk/particles/holograms/floating cards/rotating cubes/wireframe planets/HUD clutter/generic 3D-landing tropes; DPR cap, pause when not visible, few meshes, reuse geometry/materials, one animation loop; graceful 2D fallback (existing SVG trace) when WebGL is missing; prefers-reduced-motion → no choreography, static composed scene, information stays visible; mobile keeps the narrative (reduced geometry/DPR or a vertical tunnel); accessibility: everything understandable without WebGL; keep install copy, links, `fillResults`, kill -9 state logic, all copy and claims; no duplicated story (3D replaces visual redundancy). Standard: "remove the logo and someone still says: that is Interlock." Nothing unnecessary reaches the screen.

## Architecture

- ONE `<canvas>` fixed full-viewport at `z-index:-1` (under all content, over the body background), `aria-hidden`. Rendered with `renderer.setScissor/setViewport` into the on-screen rect of each visible *slot* (the three.js "multiple elements" pattern). One renderer, one rAF loop, renders only when a slot is on screen and something moved.
- `<html class="gl motion">` is set by a tiny inline head script only if WebGL context creation succeeds, `prefers-reduced-motion` is off, viewport ≥ 360px and `deviceMemory` > 2. Default CSS = today's page (fallback). `.gl` reshapes the hero into a pinned stage and hides the SVG trace; `.motion` enables the tall scroll tracks. If the three.js module fails to import (offline CDN), the classes are removed → identical fallback page. Reduced motion + WebGL: `.gl` without `.motion` → slots are in-flow static blocks showing the final composed pose (BLOCK at gate 02; whole stack; QUARANTINED; APPLIED).
- Code structure inside one `<script type="module">`: `InterlockScene {init, resize, render, destroy}`, `Stack` (the InterlockStack group + `applyPose`), `Durability` (kill -9 group + `applyState`), `Labels` (DOM `<span>`s projected from world anchors each frame → real IBM Plex Mono typography, no canvas text), `ScrollController {slots, update}`, `InteractionController {pointer, reducedMotion, visibility}`. Import is a single `three.module.min.js` from jsDelivr with `modulepreload`.
- Poses: per slot a keyframe table over progress `p∈[0,1]` (camera position, target, up, packet x, per-layer activation, evidence step); keys interpolated with smoothstep, then every applied value is damped (`v += (t−v)·k`, k≈.08–.12) → physically coherent, scrubs backwards for free.

## The InterlockStack (geometry grammar)

Axis: request travels along +X. Camera dollies along the axis looking toward +X (a tunnel of frames), later swings out to a 3/4 side view for reveals. Fog (`FogExp2`, bg colour) so far layers recede. Lights: ambient + one dim directional key + soft fill; geometry is read mostly by edges (`EdgesGeometry` line segments over dark `MeshStandardMaterial` boxes) and by translucent planes.

Layers, all centred on the axis, thin, perpendicular to X (frames in the YZ plane):
- **AGENT** x=−6.5: the only non-rectilinear object — a thin circle ring + two loose partial arcs at slight angles (semantic, "English"). No frame.
- **MCP transport** −6.5→−3: a thin line, very slightly curved (not a ruled line). The packet wobbles gently (±0.03) here.
- **PROXY membrane** x=−3: the system boundary. A large translucent near-square plane (3.4×2.6, neutral, opacity .06) framed by an amber dashed rectangle (`LineDashedMaterial`) — the same dashed amber the page already uses for "ai stops here". Passing through it bumps its opacity briefly. From here on: a faint rectilinear ground grid (opacity .07) runs under the stack to the rail — the "grid-like" deterministic side; nothing of the sort on the AI side. Packet wobble damps to 0; axis becomes a straight ruled line.
- **MANDATE** x=−1.6: a frame with a filled inner plane (a "document"), slightly larger than gates.
- **GATES 01–06** x=0,1,2,3,4,5: identical rectangular frame rings (one ExtrudeGeometry of a rect with a rect hole, reused ×5), 1.8×1.5, bar thickness .06, depth .08; dark neutral; edge lines muted. Small index tick on the top bar. Gate 02 has an inner translucent plane that becomes semantic red on BLOCK (a shutter closing). Gate 01 gets a thin green tick on pass (the only other colour in Act I).
- **GATE 05** at x=4 is the anomaly: amber `LineDashedMaterial` frame, no fill, lifted +0.35 in Y and rotated 6° about X — visibly removable — with a dashed drop-line to the axis; label "05 · purpose · model · off by default".
- **INTENT** x=6.6: a small solid slab (0.9×0.6×0.4) — the durable object. Dormant (edges only, opacity .25) in Act I.
- **RAIL** x=8.6: two long parallel bars (a literal rail, 2.8 long along Z) with a small terminal frame. Dark/inactive in Act I; label "rail · call 0". Nothing ever animates into it in Act I.
- **PACKET**: a short capsule-ish thin box (0.28×0.06×0.06) in bright neutral (#e6e9ee) with a faint trailing line; becomes red only after Gate 02 blocks. DOM label rides beside it: `create_refund · ₹48,000`.

Portrait/mobile: same scene, DPR cap 1.25, wider FOV; in the side-view reveals `camera.up` lerps to (−1,0,0) so the stack reads as a vertical tunnel (agent top → rail bottom). Dolly view is orientation-agnostic.

## Moment 1 — HERO (pinned, track ≈ 600vh; stage = 100svh sticky under the 58px header)

Overlays at p=0: existing eyebrow + H1 + lede + actions top-left (~45% width); the three-cell incident readout (₹48,000 / ₹1,899 / BLOCKED) as a full-width instrument strip along the bottom edge; tiny mono hint "scroll to enter the proxy"; top-right "system trace" index (layer name + rule). Camera sits behind the agent, offset so the tunnel's vanishing point is right-of-centre (axis on the right, copy on the left). Intro (time-based, 1.8s, once): packet fades in at the agent and drifts 1.2 units toward the membrane; frames fade in. Then scroll owns everything.

Progress map (rhythm: slow approach, medium through gates, pause at stop, slow pull-back):
- 0.00–0.12 approach: copy + readout fade out 0.06→0.16; camera centres on axis.
- 0.12–0.26 proxy: dolly to x≈−3.4; pass through the membrane at ≈0.24 (opacity bump); caption "MCP · INTERLOCK PROXY — the agent does not talk to money any more"; visual language shifts (grid appears, packet straightens).
- 0.26–0.38 mandate: dolly through the mandate frame; caption "MANDATE · yaml · approved by a human".
- 0.38–0.52 gate 01: packet passes gate 01 → tick "scope · pass".
- 0.52–0.62 gate 02 approach: camera slows; packet decelerates toward x=1.
- 0.62–0.68 STOP: packet halts at x=0.96, turns red; gate 02 shutter goes red; label "GATE 02 · BLOCK · VALUE_NOT_AUTHORISED". Camera holds.
- 0.68–0.82 evidence (camera still holds — the pause): `resolved_order order_A8841` → `claimed_line_item_minor 189900 → ₹1,899` → `₹48,000 ✕ / ₹1,899 ✓ authority` → far downstream label `RAIL · CALL 0`. Downstream layers stay dormant.
- 0.82–1.00 pull-back: camera swings to a 3/4 elevated side view framing the whole stack; all layer labels appear; caption "That is the entire mechanism." + "one proposed action · stopped at gate 02 · rail call 0". Then the page flows into Chapter 01 (the written incident reconstruction, unchanged).

The existing SVG trace and mobile trace list become the fallback only (hidden under `.gl`); a `.sr` textual equivalent of the sequence lives in the stage.

## Moment 2 — GATES DIVE (chapter 02)

Layout under `.gl`: two columns — the existing six-gate list (left, `.ev` stacks under the question like today's ≤1100px layout) and a sticky stage (right, ~420px, `top:78px`). The active gate = the row nearest a trigger line at 45% of the viewport; the camera slides along the stack in a 3/4 view to frame that layer; the active frame brightens + its label, others dim; Gate 05 shows its amber dashed anomaly with "model · off by default"; after Gate 06 the camera pulls to INTENT and RAIL as the `.ipath` (decision → durable intent → rail at most once → outcome verified) reveals. No packet here — this is inspection, not an incident. Desktop hover (raycast) focuses a frame; click scrolls the corresponding gate row into view (system index behaviour). Mobile: the stage becomes a short sticky strip (34svh) above the list.

## Moment 3 — KILL -9 DURABILITY (chapter 04)

Layout: states list (left, scroll content) | sticky stage (right, 4:3) + one caption line; the claims paragraph and the "recording pending" media placeholder move below the grid (nothing removed). State index is driven by which row has crossed the trigger line (scrubs both ways); extra vertical space around UNKNOWN and the big statement makes the scroll itself pause there. The existing timed `replay()` remains the fallback (no `.motion`).

Scene (same materials, different geometry — persistence, not flow): a flat storage plane (the disk/WAL) with a solid INTENT slab resting on it; a hollow wire box (the PROCESS) hovering above it; a rail bar at the far side; a thin call line from process to rail.
- PROPOSED: slab appears (edges), label `PROPOSED · sik:…`. AUTHORIZED: slab fills (neutral). IN_FLIGHT: call line extends toward the rail; a small lease bar beside the slab.
- PROCESS TERMINATED: the wire box simply fades to nothing; the call line is cut mid-way (no explosion, no fire). The slab does not move.
- UNKNOWN: camera drift → 0, all motion stops (deliberately uncomfortable), slab edges turn amber, lease bar empties; the page's big statement "Unknown never means retry." is on screen at the same time.
- RECONCILING ×1…×6: six thin probe lines from slab to rail, one per tick, each returning nothing; the list's tick marks light in sync.
- QUARANTINED: a slightly larger red wire boundary encloses the slab; label "QUARANTINED · a named human decides".

## Final CTA — quiet fourth use

Slot beside the CTA copy (replaces nothing; the 2D ₹2,800 trace list stays as the annotation and lights in sync). Progress = section scrolled into view. 3/4 side view; packet `₹2,800` passes membrane, mandate, gates 01–06 (neutral ticks, no colour), INTENT lights solid, RAIL lights once, then `APPLIED · VERIFIED` in green — the only green in the scene.

## Everything else (2D)

Benchmark: rows reveal one by one (labels only; values remain `TBD`, `fillResults` untouched). Adoption: a compact handoff diagram (your agent — amber dashed "ai stops here" — interlock proxy :8787 — your existing MCP server) next to the heading, config diff unchanged. Nav unchanged. Header unchanged. All reveal/copy/link/fillResults code preserved.

## Performance / a11y

DPR cap min(dpr, 1.75) desktop, 1.25 mobile, 1 if `hardwareConcurrency ≤ 4`; render only with a visible slot (IntersectionObserver + `visibilitychange`); ~60 objects total, 6 geometries, ~10 materials; no post-processing, no particles; `ResizeObserver`/resize/orientationchange handled. Canvas `aria-hidden`; each slot `role="img"` with an `aria-label`; DOM labels `aria-hidden`; `.sr` narrative in the hero; keyboard focus untouched.
