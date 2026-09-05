/* ═══════════════════ the x-ray ═══════════════════
   One WebGL renderer, one animation loop, one canvas. Scroll position is the only clock.
   InterlockScene        renderer, the two scenes, per-slot cameras, the frame loop
   Stack                 the control path as geometry: agent → proxy membrane → mandate → gates 01–06 → intent → egress → rail
   Durability            act II, built from the same parts: a record on disk, a process that dies, a process that restarts
   Labels                real type, projected from world anchors into each slot every frame
   ScrollController      maps the page's scroll into a progress value per slot, then into a pose
   InteractionController pointer parallax, hover on the stack, visibility
   Nothing here is required: html.gl / html.motion are removed if Three.js cannot load, and the 2D page returns. */
"use strict";
(async function xray(){
  const root = document.documentElement;
  if (!root.classList.contains('gl')) return;
  let degraded = false;
  const degrade = () => {
    if (degraded) return; degraded = true;
    root.classList.remove('gl', 'motion', 'ready');
    const here = document.elementFromPoint(24, 100); const sec = here && here.closest('section');
    if (window.__interlockTrace) window.__interlockTrace();
    if (window.__interlockReplay) window.__interlockReplay();
    if (sec && scrollY > 200) sec.scrollIntoView();
  };
  let THREE;
  try {
    THREE = await Promise.race([
      import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.min.js'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdn timeout')), 8000)),
    ]);
  } catch (e) { degrade(); return; }

  /* ── constants ── */
  const C = { bg:0x0c0e11, surface:0x14171c, raised:0x1b1f26, border:0x262b33, text:0xe6e9ee, muted:0x8b94a3, dim:0x5d6675, allow:0x3fb950, hold:0xd29922, block:0xf85149 };
  const X = { agent:-7.4, proxy:-3.6, mandate:-2.0, gates:[0, 1, 2, 3, 4, 5], intent:6.6, egress:7.4, rail:8.6 };
  const Y_FLOOR = -.8;                      /* top of the substrate */
  const STOP_X = .78;                       /* the packet's nose at .93; gate 02's front face is at .96 */
  const GATE_NAMES = ['01 · scope', '02 · value', '03 · limits', '04 · exactly once', '05 · purpose · model · off by default', '06 · provenance'];
  const GATE_SHORT = ['01 · scope', '02 · value', '03 · limits', '04 · exactly once', '05 · purpose · model', '06 · provenance'];
  const gateW = i => 1.8 * (1 - .04 * i), gateH = i => 1.5 * (1 - .04 * i);   /* apertures only ever narrow */
  const G5_LIFT = .78;                      /* gate 05 sits clear of the path: the packet passes beneath it */
  const motion = root.classList.contains('motion');
  const finePointer = matchMedia('(pointer: fine)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 860px)').matches;
  const lowPower = (navigator.hardwareConcurrency || 8) <= 4;

  /* ── small maths ── */
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
  const range = (p, a, b) => clamp((p - a) / (b - a));
  const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const col = h => new THREE.Color(h);
  const COL = { text: col(C.text), muted: col(C.muted), dim: col(C.dim), border: col(C.border), hold: col(C.hold), block: col(C.block), allow: col(C.allow), raised: col(C.raised), surface: col(C.surface), bg: col(C.bg) };

  /* keyframes: [p, partial] pairs; each key carries the previous values forward.
     Continuous channels (camera, packet, fov, fog) interpolate linearly — the damping supplies the ease.
     Everything else uses smoothstep so on/off channels arrive cleanly. */
  const LINEAR = new Set(['cam', 'tgt', 'fov', 'fog', 'packetX']);
  function keyframes(list){ const keys = []; let cur = {}; for (const [p, part] of list){ cur = Object.assign({}, cur, part); keys.push({ p, v: cur }); } return keys; }
  function sampleKeys(keys, p){
    if (p <= keys[0].p) return Object.assign({}, keys[0].v);
    for (let i = 0; i < keys.length - 1; i++){
      const a = keys[i], b = keys[i + 1];
      if (p <= b.p){
        const u = (p - a.p) / (b.p - a.p), s = smooth(u), out = {};
        for (const k in b.v){
          const va = a.v[k], vb = b.v[k], t = LINEAR.has(k) ? u : s;
          if (Array.isArray(vb)) out[k] = vb.map((n, j) => lerp(va[j], n, t));
          else if (typeof vb === 'number') out[k] = lerp(va, vb, t);
          else out[k] = t < .5 ? va : vb;
        }
        return out;
      }
    }
    return Object.assign({}, keys[keys.length - 1].v);
  }
  function dampPose(cur, tgt, dt, rates){
    for (const k in tgt){
      const r = (rates && rates[k]) || 6;
      if (Array.isArray(tgt[k])){ if (!cur[k]) cur[k] = tgt[k].slice(); for (let j = 0; j < tgt[k].length; j++) cur[k][j] = damp(cur[k][j], tgt[k][j], r, dt); }
      else if (typeof tgt[k] === 'number') cur[k] = cur[k] === undefined ? tgt[k] : damp(cur[k], tgt[k], r, dt);
      else cur[k] = tgt[k];
    }
    return cur;
  }
  const settled = (cur, tgt) => { for (const k in tgt){ if (Array.isArray(tgt[k])){ for (let j = 0; j < tgt[k].length; j++) if (Math.abs(cur[k][j] - tgt[k][j]) > 5e-4) return false; } else if (typeof tgt[k] === 'number' && Math.abs(cur[k] - tgt[k]) > 5e-4) return false; } return true; };

  /* ── materials: flat fills at the page's own tokens, hairline edges as a rim, no speculars ── */
  const mat = {
    fill: (color = C.raised, opacity = 1) => new THREE.MeshLambertMaterial({ color, transparent: true, opacity }),
    edge: (color = C.muted, opacity = .6) => new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    dashedLine: (color = C.dim, opacity = .7) => new THREE.LineDashedMaterial({ color, dashSize: .08, gapSize: .06, transparent: true, opacity }),
    plane: (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
    solid: (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
  };

  /* ── geometry helpers ── */
  /* a rectangular frame (ring) standing in the YZ plane, `depth` along X — the layer a request must pass through */
  function frameGeo(w, h, bar, depth){
    const s = new THREE.Shape(); s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.closePath();
    const iw = w / 2 - bar, ih = h / 2 - bar, hole = new THREE.Path(); hole.moveTo(-iw, -ih); hole.lineTo(iw, -ih); hole.lineTo(iw, ih); hole.lineTo(-iw, ih); hole.closePath();
    s.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
    g.rotateY(Math.PI / 2); g.translate(-depth / 2, 0, 0);
    return g;
  }
  const planeYZ = (w, h) => { const g = new THREE.PlaneGeometry(w, h); g.rotateY(Math.PI / 2); return g; };
  const lineGeo = pts => new THREE.BufferGeometry().setFromPoints(pts);
  const edges = (geo, material) => new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), material);
  const UNIT = new THREE.BoxGeometry(1, 1, 1);
  const bar = (mtl, sx, sy, sz) => { const m = new THREE.Mesh(UNIT, mtl); m.scale.set(sx, sy, sz); return m; };
  /* dashes as geometry, so a dashed rule has thickness at any pixel ratio. Rect in the YZ plane, or a run along Z. */
  function dashRect(w, h, material, dash = .12, gap = .08, thick = .028){
    const segs = [[V3(0, -h / 2, -w / 2), V3(0, -h / 2, w / 2)], [V3(0, h / 2, -w / 2), V3(0, h / 2, w / 2)], [V3(0, -h / 2, -w / 2), V3(0, h / 2, -w / 2)], [V3(0, -h / 2, w / 2), V3(0, h / 2, w / 2)]];
    return dashRun(segs, material, dash, gap, thick);
  }
  function dashRun(segs, material, dash = .12, gap = .08, thick = .028){
    const items = [];
    for (const [a, b] of segs){ const d = b.clone().sub(a), L = d.length(), dir = d.normalize(); for (let s = 0; s + dash * .5 < L; s += dash + gap){ const len = Math.min(dash, L - s); items.push({ p: a.clone().addScaledVector(dir, s + len / 2), dir, len }); } }
    const im = new THREE.InstancedMesh(UNIT, material, items.length); const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = V3(1, 0, 0);
    items.forEach((it, i) => { q.setFromUnitVectors(up, it.dir); sc.set(it.len, thick, thick); m4.compose(it.p, q, sc); im.setMatrixAt(i, m4); });
    im.instanceMatrix.needsUpdate = true; return im;
  }
  /* a drawn line: draws from its start (out 0→1) and retracts from its start (back 0→1) */
  function drawnLine(points, material, samples = 80){
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0);
    const pts = curve.getPoints(samples); const g = lineGeo(pts); const line = new THREE.Line(g, material); if (material.isLineDashedMaterial) line.computeLineDistances();
    line.userData.n = pts.length; line.set = (out, back) => { const n = line.userData.n; const end = Math.round(out * n), start = Math.round(back * n); g.setDrawRange(Math.min(start, end), Math.max(0, end - start)); line.visible = end - start > 1; }; line.set(0, 0); return line;
  }

  /* a layer: a body + its edges, with one activation value 0…1 that sets brightness */
  class Layer {
    constructor(x, geo, opts = {}){
      this.group = new THREE.Group(); this.group.position.x = x;
      this.dormant = opts.dormant ?? .32; this.act = -1;
      this.edgeLow = opts.edgeLow || COL.dim; this.edgeHigh = opts.edgeHigh || COL.text;
      this.fillLow = opts.fillLow || COL.raised; this.fillHigh = opts.fillHigh || col(0x2b323c);
      if (geo){
        this.mat = mat.fill(C.raised, 1); this.mesh = new THREE.Mesh(geo, this.mat); this.group.add(this.mesh);
        this.edgeMat = mat.edge(C.muted, .6); this.edges = edges(geo, this.edgeMat); this.group.add(this.edges);
      }
      this.set(this.dormant);
    }
    set(act){
      this.act = act;
      if (this.mat){ this.mat.opacity = lerp(.55, 1, act); this.mat.color.lerpColors(this.fillLow, this.fillHigh, smooth(act)); }
      if (this.edgeMat){ this.edgeMat.opacity = lerp(.22, .95, act); this.edgeMat.color.lerpColors(this.edgeLow, this.edgeHigh, smooth(act)); }
    }
  }

  /* ═══ Stack — the control path ═══ */
  class Stack {
    constructor(){
      const g = this.group = new THREE.Group();
      /* the AI side has no ground and no frame. A point, and an unruled line toward the membrane. */
      const agentDot = new THREE.Mesh(new THREE.SphereGeometry(.022, 12, 8), mat.solid(C.text, .9)); agentDot.position.x = X.agent; g.add(agentDot); this.agentDot = agentDot;
      const tpts = []; for (let i = 0; i <= 48; i++){ const t = i / 48; tpts.push(V3(lerp(X.agent, X.proxy, t), .06 * Math.sin(t * Math.PI * 2) * (1 - t), .12 * Math.sin(t * Math.PI))); }
      this.transportPts = tpts; this.transport = new THREE.Line(lineGeo(tpts), mat.edge(C.dim, .55)); g.add(this.transport);
      /* the upstream side is MCP too: from the egress to the rail, the same unruled line */
      const upts = []; for (let i = 0; i <= 16; i++){ const t = i / 16; upts.push(V3(lerp(X.egress, X.rail, t), .04 * Math.sin(t * Math.PI), .06 * Math.sin(t * Math.PI))); }
      this.upstream = new THREE.Line(lineGeo(upts), mat.edge(C.dim, .55)); g.add(this.upstream);
      /* the substrate: only the deterministic side has ground. A dark slab from the membrane to the egress. */
      const subLen = X.egress - X.proxy, subGeo = new THREE.BoxGeometry(subLen, .06, 3.2);
      this.substrate = new THREE.Mesh(subGeo, mat.fill(C.surface, 1)); this.substrate.position.set(X.proxy + subLen / 2, Y_FLOOR - .03, 0); g.add(this.substrate);
      this.substrateEdge = edges(subGeo, mat.edge(C.border, .9)); this.substrateEdge.position.copy(this.substrate.position); g.add(this.substrateEdge);
      const gpts = []; for (let z = -1.6; z <= 1.6001; z += .4) gpts.push(V3(X.proxy, Y_FLOOR + .004, z), V3(X.egress, Y_FLOOR + .004, z));
      for (let x = X.proxy; x <= X.egress + .001; x += .4) gpts.push(V3(x, Y_FLOOR + .004, -1.6), V3(x, Y_FLOOR + .004, 1.6));
      this.grid = new THREE.LineSegments(lineGeo(gpts), mat.edge(C.muted, .07)); this.grid.material.depthWrite = false; this.grid.renderOrder = -1; g.add(this.grid);
      /* the ruled axis, with ticks every half unit; after gate 02 it can go dashed — the path that was never taken */
      this.axisA = new THREE.Line(lineGeo([V3(X.proxy, 0, 0), V3(1, 0, 0)]), mat.edge(C.dim, .8)); g.add(this.axisA);
      this.axisB = new THREE.Line(lineGeo([V3(1, 0, 0), V3(X.egress, 0, 0)]), mat.edge(C.dim, .8)); g.add(this.axisB);
      this.axisAfter = new THREE.Line(lineGeo([V3(1, 0, 0), V3(X.egress, 0, 0)]), mat.dashedLine(C.dim, 0)); this.axisAfter.computeLineDistances(); g.add(this.axisAfter);
      const tpts2 = []; for (let x = -3.5; x <= X.egress + .001; x += .5) tpts2.push(V3(x, -.045, 0), V3(x, .045, 0));
      this.ticks = new THREE.LineSegments(lineGeo(tpts2), mat.edge(C.dim, .5)); g.add(this.ticks);
      /* the proxy membrane: a thin lamina, edged in the page's amber dashes, continued as a cut across the substrate */
      const proxy = this.proxy = new Layer(X.proxy, null);
      this.membraneMat = mat.plane(C.muted, .06); const membrane = new THREE.Mesh(new THREE.BoxGeometry(.05, 2.8, 3.6), this.membraneMat); membrane.renderOrder = 1; membrane.position.x = -.01;
      this.membraneDash = dashRect(3.6, 2.8, mat.solid(C.hold, .95));
      const cut = dashRun([[V3(0, Y_FLOOR + .01, -1.6), V3(0, Y_FLOOR + .01, 1.6)]], mat.solid(C.hold, .7), .1, .08, .02);
      proxy.group.add(membrane, this.membraneDash, cut); g.add(proxy.group);
      /* the egress: where Interlock ends and the upstream MCP server begins. A thin neutral rule. */
      this.egress = new THREE.Line(lineGeo([V3(X.egress, Y_FLOOR, 0), V3(X.egress, .9, 0)]), mat.edge(C.muted, .7)); g.add(this.egress);
      /* mandate: a larger frame with a filled leaf — the approved document */
      const mandGeo = frameGeo(2.1, 1.75, .06, .06);
      const mandate = this.mandate = new Layer(X.mandate, mandGeo, { dormant: .35 });
      this.mandateLeaf = new THREE.Mesh(planeYZ(1.98, 1.63), mat.plane(C.surface, .55)); mandate.group.add(this.mandateLeaf); g.add(mandate.group);
      /* gates: frames whose apertures only narrow. 05 is the anomaly — dashed, amber, lifted clear of the path */
      this.gates = X.gates.map((x, i) => {
        if (i === 4){
          const L = new Layer(x, null, { dormant: .5 });
          const dash = dashRect(gateW(i), gateH(i), mat.solid(C.hold, .9), .1, .07, .024); L.dashMat = dash.material;
          L.group.add(dash); L.group.position.y = G5_LIFT;
          L.set = function(act){ this.act = act; this.dashMat.opacity = lerp(.5, 1, act); };
          L.set(.5); L.model = true; g.add(L.group); return L;
        }
        const L = new Layer(x, frameGeo(gateW(i), gateH(i), .07, .08));
        const tick = bar(mat.solid(C.muted, 0), .015, .03, .18); tick.position.y = gateH(i) / 2 + .05; L.tick = tick; L.group.add(tick);
        g.add(L.group); return L;
      });
      /* gate 02 is a comparator: two measures in true proportion, a gauge line, and a shutter that can close */
      const g2 = this.gates[1], innerW = gateW(1) - .14, innerH = gateH(1) - .14;
      this.shutter = new THREE.Mesh(planeYZ(innerW - .02, innerH - .02), mat.plane(C.block, 0)); this.shutter.position.x = .02; this.shutter.renderOrder = 2; this.shutter.material.fog = false; g2.group.add(this.shutter);
      this.gauge = new THREE.Line(lineGeo([V3(0, -.08, -.75), V3(0, .44, -.75)]), mat.edge(C.dim, 0)); g2.group.add(this.gauge);
      this.barA = bar(mat.solid(C.muted, 0), .02, .025, 1); this.barA.position.set(0, .3, -.75); g2.group.add(this.barA);   /* order_amount_minor 4800000 */
      this.barB = bar(mat.solid(C.text, 0), .02, .025, 1); this.barB.position.set(0, .05, -.75); g2.group.add(this.barB);    /* claimed_line_item_minor 189900 */
      this.barALen = 1.5; this.barBLen = 1.5 * 189900 / 4800000;
      this.endstop = bar(mat.solid(C.block, 0), .02, .1, .1); this.endstop.position.set(.95, 0, 0); this.endstop.material.fog = false; g.add(this.endstop);
      /* the read-only resolve: leaves gate 02, touches the rail's flank, and comes back. Never the terminal. */
      this.probe = drawnLine([V3(1, .72, 0), V3(1.15, .9, .55), V3(X.rail - .8, .95, 1.0), V3(X.rail, .55, 1.05)], mat.dashedLine(C.text, .9)); g.add(this.probe);
      this.probe.material.fog = false;
      /* the verification read-back: from the rail's flank back to the intent */
      this.verify = drawnLine([V3(X.rail, .55, 1.05), V3(X.rail - .5, .95, 1.0), V3(X.intent + .3, .9, .7), V3(X.intent, .32, .46)], mat.dashedLine(C.text, .9)); g.add(this.verify);
      /* hit planes for hover — never drawn */
      this.hits = X.gates.map((x, i) => { const m = new THREE.Mesh(planeYZ(1.9, 1.6), new THREE.MeshBasicMaterial({ visible: false })); m.position.set(x, i === 4 ? G5_LIFT : 0, 0); m.userData.gate = i; g.add(m); return m; });
      /* intent: a block rooted in the substrate — the durable object. rail: a terminal frame on two long bars, on no ground of ours */
      const intentGeo = new THREE.BoxGeometry(.44, 1.1, .9);
      const intent = this.intent = new Layer(X.intent, intentGeo, { dormant: .2 }); intent.group.position.y = -.25; g.add(intent.group);
      const rail = this.rail = new Layer(X.rail, frameGeo(2.4, 1.0, .06, .07), { dormant: .2 });
      const railBarGeo = new THREE.BoxGeometry(.05, .05, 3.6);
      const b1 = new THREE.Mesh(railBarGeo, rail.mat), b2 = new THREE.Mesh(railBarGeo, rail.mat); b1.position.y = .5; b2.position.y = -.5;
      rail.group.add(b1, b2); this.railOkEdge = edges(frameGeo(2.4, 1.0, .06, .07), mat.edge(C.allow, 0)); rail.group.add(this.railOkEdge); g.add(rail.group);
      /* the request: one packet. Unresolved (a ghost around it) on the AI side, parsed (an outline) past the membrane. Neutral to the end. */
      this.packetMat = mat.solid(C.text, 1); this.packetMat.fog = false;
      this.packet = new THREE.Mesh(new THREE.BoxGeometry(.3, .06, .06), this.packetMat); g.add(this.packet);
      this.ghostMat = mat.solid(C.text, .12); this.ghost = new THREE.Mesh(new THREE.BoxGeometry(.48, .1, .1), this.ghostMat); this.ghost.material.depthWrite = false; g.add(this.ghost);
      this.outlineMat = mat.edge(C.muted, 0); this.outline = edges(new THREE.BoxGeometry(.42, .14, .14), this.outlineMat); g.add(this.outline);
      this.layers = { proxy, mandate, intent, rail };
    }
    /* where the packet sits for a given x: on the unruled line before the membrane, on the ruled axis after it */
    packetPos(x, out){
      out.set(x, 0, 0);
      if (x < X.proxy){ const t = (x - X.agent) / (X.proxy - X.agent); out.y = .06 * Math.sin(t * Math.PI * 2) * (1 - t); out.z = .12 * Math.sin(t * Math.PI); }
      else if (x > X.egress){ const t = (x - X.egress) / (X.rail - X.egress); out.y = .04 * Math.sin(t * Math.PI); out.z = .06 * Math.sin(t * Math.PI); }
      return out;
    }
    apply(p){
      this.agentDot.material.opacity = lerp(.35, .9, p.aAgent);
      this.membraneMat.opacity = lerp(.06, .18, p.glow);
      this.membraneDash.material.opacity = lerp(.55, 1, p.aProxy);
      this.mandate.set(p.aMandate); this.mandateLeaf.material.opacity = lerp(.25, .6, p.aMandate);
      for (let i = 0; i < 6; i++){ const L = this.gates[i]; L.set(p.aG[i]); if (L.tick) L.tick.material.opacity = p.tick[i]; }
      const g2 = this.gates[1];
      this.shutter.material.opacity = p.shutter * .16;
      if (p.shutter > .02){ g2.edgeMat.color.lerpColors(COL.text, COL.block, smooth(p.shutter)); g2.edgeMat.opacity = 1; }
      this.endstop.material.opacity = p.shutter * .95;
      this.axisAfter.material.opacity = p.shutter * .4; this.axisB.material.opacity = .8 * (1 - p.shutter);
      this.gauge.material.opacity = Math.max(p.barA, p.barB) * .6;
      this.barA.material.opacity = p.barA > .01 ? .9 : 0; this.barA.scale.z = Math.max(.001, this.barALen * p.barA); this.barA.position.z = -.75 + this.barA.scale.z / 2;
      this.barB.material.opacity = p.barB > .01 ? 1 : 0; this.barB.scale.z = Math.max(.001, this.barBLen * p.barB); this.barB.position.z = -.75 + this.barB.scale.z / 2;
      this.probe.set(p.probeOut, p.probeBack); this.verify.set(p.verifyOut, p.verifyBack);
      this.intent.set(p.aIntent); this.rail.set(p.aRail); this.railOkEdge.material.opacity = p.railOk;
      this.packet.visible = p.packetOn > .02; this.ghost.visible = this.packet.visible && p.ghost > .02; this.outline.visible = this.packet.visible && p.parsed > .02;
      if (this.packet.visible){
        this.packetPos(p.packetX, this.packet.position); this.packetMat.opacity = p.packetOn;
        this.ghost.position.copy(this.packet.position); const gs = lerp(.6, 1, p.ghost); this.ghost.scale.set(gs, gs, gs); this.ghostMat.opacity = .12 * p.ghost * p.packetOn;
        this.outline.position.copy(this.packet.position); this.outlineMat.opacity = .6 * p.parsed * p.packetOn;
      }
    }
  }

  /* ═══ Durability — act II from the same parts. The frame is the process; the block is the record; the floor is the disk ═══ */
  class Durability {
    constructor(){
      const g = this.group = new THREE.Group();
      const floorGeo = new THREE.BoxGeometry(4.4, .06, 2.8);
      this.floor = new THREE.Mesh(floorGeo, mat.fill(C.surface, 1)); this.floor.position.set(-.1, -.03, 0);
      this.floorEdge = edges(floorGeo, mat.edge(C.border, .9)); this.floorEdge.position.copy(this.floor.position); g.add(this.floor, this.floorEdge);
      const gpts = []; for (let z = -1.2; z <= 1.2001; z += .4) gpts.push(V3(-2.3, .004, z), V3(2.1, .004, z)); for (let x = -2.3; x <= 2.1001; x += .4) gpts.push(V3(x, .004, -1.4), V3(x, .004, 1.4));
      const grid = new THREE.LineSegments(lineGeo(gpts), mat.edge(C.muted, .07)); grid.material.depthWrite = false; grid.renderOrder = -1; g.add(grid);
      /* the record: the intent block, resting on the disk */
      const slabGeo = new THREE.BoxGeometry(.9, .5, .62);
      this.slab = new Layer(-.55, slabGeo, { dormant: .15 }); this.slab.group.position.y = .25; g.add(this.slab.group);
      /* the row: the same frame geometry, lying flat around the record. Inserted at PROPOSED, fenced at QUARANTINED. */
      const rowGeo = frameGeo(1.5, 1.25, .05, .03); rowGeo.rotateZ(-Math.PI / 2);
      this.rowMat = mat.edge(C.dim, 0); this.row = edges(rowGeo, this.rowMat); this.row.position.set(-.55, .015, 0); g.add(this.row);
      /* the process: a gate-type frame standing on the disk in front of the record. It holds the request in memory; it holds no state. */
      const procGeo = frameGeo(1.8, 1.5, .06, .06);
      this.procMat = mat.edge(C.muted, .75); this.proc = edges(procGeo, this.procMat); this.proc.position.set(.05, .75, 0); g.add(this.proc);
      this.procFillMat = mat.plane(C.muted, .03); const procFill = new THREE.Mesh(planeYZ(1.68, 1.38), this.procFillMat); procFill.position.copy(this.proc.position); g.add(procFill);
      this.packetMat = mat.solid(C.text, 1); this.packet = new THREE.Mesh(new THREE.BoxGeometry(.3, .06, .06), this.packetMat); this.packetHome = V3(.05, 1.0, 0); this.packet.position.copy(this.packetHome); g.add(this.packet);
      /* the rail, beyond the disk: a terminal frame on two bars */
      const RX = this.RX = 2.55; const railGeo = frameGeo(1.4, .7, .05, .06);
      this.rail = new Layer(RX, railGeo, { dormant: .25 }); this.rail.group.position.y = .35;
      const rb = new THREE.BoxGeometry(.04, .04, 2.2); const r1 = new THREE.Mesh(rb, this.rail.mat), r2 = new THREE.Mesh(rb, this.rail.mat); r1.position.y = .35; r2.position.y = -.35; this.rail.group.add(r1, r2); g.add(this.rail.group);
      this.terminalMat = mat.edge(C.hold, 0); this.terminal = edges(railGeo, this.terminalMat); this.terminal.position.copy(this.rail.group.position); g.add(this.terminal);
      /* lines: the write (fsync) down to the record, the call toward the rail, the read up from the disk at boot, six reconciliation passes */
      this.write = drawnLine([this.packetHome.clone(), V3(-.4, .52, 0)], mat.edge(C.text, .8), 24); g.add(this.write);
      this.callEnd = V3(RX - .7, .5, 0);
      this.call = drawnLine([this.packetHome.clone(), V3(1.2, .95, 0), this.callEnd.clone()], mat.edge(C.text, .8), 60); g.add(this.call);
      this.ghostCall = drawnLine([this.packetHome.clone(), V3(1.2, .95, 0), this.callEnd.clone()], mat.edge(C.dim, .12), 60); g.add(this.ghostCall);
      this.read = drawnLine([V3(-.4, .5, 0), V3(-.2, .95, 0), V3(.05, 1.0, 0)], mat.dashedLine(C.muted, .8), 24); g.add(this.read);
      this.probes = [];
      for (let i = 0; i < 6; i++){ const l = drawnLine([V3(.05, 1.5 - i * .04, 0), V3(1.2, 1.6 - i * .05, -.35 - i * .1), V3(RX, .72, -.9 - i * .05)], mat.dashedLine(C.text, .85), 64); this.probes.push(l); g.add(l); }
      /* the lease: a small bar on the record's top face */
      this.leaseMat = mat.solid(C.muted, 0); this.lease = bar(this.leaseMat, .6, .02, .02); this.lease.position.set(-.55, .51, .36); g.add(this.lease);
      this.leaseGhostMat = mat.edge(C.hold, 0); this.leaseGhost = edges(new THREE.BoxGeometry(.6, .02, .02), this.leaseGhostMat); this.leaseGhost.position.copy(this.lease.position); g.add(this.leaseGhost);
      this.procFill = procFill;
    }
    apply(s){
      this.slab.set(s.fill); this.slab.group.visible = s.slabOn > .02;
      this.slab.edgeMat.color.copy(COL.text).lerp(COL.hold, 0); this.slab.edgeMat.opacity = lerp(.25, 1, s.slabOn) * (s.fsync > 0 ? 1 : 1);
      this.rowMat.opacity = s.row * (s.quarantine > .01 ? 1 : .4); this.rowMat.color.lerpColors(COL.dim, COL.block, s.quarantine);
      this.procMat.opacity = .75 * s.proc; this.procFillMat.opacity = .03 * s.proc; this.proc.visible = s.proc > .01; this.procFill.visible = this.proc.visible;
      this.packetMat.opacity = s.packetOn; this.packet.visible = s.packetOn > .02;
      if (this.packet.visible){ const a = this.packetHome, b = this.callEnd, t = s.packetT; this.packet.position.set(lerp(a.x, b.x, t), t < .5 ? lerp(a.y, .95, t * 2) : lerp(.95, b.y, (t - .5) * 2), 0); }
      this.write.set(s.write, 0); this.write.material.opacity = .8 * s.writeOn;
      this.call.set(s.call * .85, 0); this.call.material.opacity = .8 * s.callOn;
      this.ghostCall.set(.85, 0); this.ghostCall.material.opacity = .12 * s.ghost;
      this.read.set(s.read, 0);
      for (let i = 0; i < 6; i++){ const t = clamp(s.probes - i); this.probes[i].set(Math.min(1, t / .6), Math.max(0, (t - .6) / .4)); }
      this.leaseMat.opacity = s.leaseOn; this.lease.scale.x = Math.max(.001, .6 * s.lease); this.lease.position.x = -.55 - .3 * (1 - s.lease);
      this.leaseGhostMat.opacity = s.leaseExpired * .9;
      this.terminalMat.opacity = s.terminal; this.terminalMat.color.lerpColors(COL.muted, COL.hold, s.terminalHold);
      this.rail.set(lerp(.25, .5, s.terminal));
    }
  }

  /* ═══ Labels — DOM type, projected ═══ */
  class Labels {
    constructor(container, defs){
      this.defs = defs; this.v = new THREE.Vector3();
      for (const d of defs){ d.el = document.createElement('span'); d.el.className = 'lab ' + (d.cls || ''); d.el.innerHTML = d.html; container.appendChild(d.el); d.on = false; d.anchor = d.anchor || V3(); }
    }
    update(camera, w, h, show){
      for (const d of this.defs){
        const want = show.has(d.key);
        this.v.copy(d.anchor).project(camera);
        const inFront = this.v.z < 1 && this.v.z > -1;
        const px = (this.v.x + 1) / 2 * w, py = (1 - this.v.y) / 2 * h;
        const inside = px > -40 && px < w + 40 && py > -20 && py < h + 20;
        const on = want && inFront && inside;
        if (on){
          const ax = d.align === 'c' ? '-50%' : d.align === 'r' ? '-100%' : '0';
          const ay = d.valign === 'm' ? '-50%' : d.valign === 'b' ? '-100%' : '0';
          d.el.style.transform = `translate3d(${Math.round(px + (d.dx || 0))}px,${Math.round(py + (d.dy || 0))}px,0) translate(${ax},${ay})`;
        }
        if (on !== d.on){ d.on = on; d.el.classList.toggle('on', on); }
      }
    }
  }

  /* ═══ InterlockScene ═══ */
  const canvas = document.getElementById('gl');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPower, alpha: true, powerPreference: 'high-performance' }); }
  catch (e) { degrade(); return; }
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); degrade(); }, false);
  renderer.autoClear = false;
  const dprCap = lowPower ? 1 : coarse ? 1.25 : 1.75;
  let dpr = Math.min(window.devicePixelRatio || 1, dprCap); renderer.setPixelRatio(dpr);
  const hemi = () => new THREE.HemisphereLight(0xe6e9ee, 0x0c0e11, 1.05);
  const stackScene = new THREE.Scene(); stackScene.fog = new THREE.FogExp2(C.bg, .03); stackScene.add(new THREE.AmbientLight(0xffffff, .35), hemi());
  const stack = new Stack(); stackScene.add(stack.group);
  const killScene = new THREE.Scene(); killScene.fog = new THREE.FogExp2(C.bg, .02); killScene.add(new THREE.AmbientLight(0xffffff, .35), hemi());
  const dur = new Durability(); killScene.add(dur.group);

  /* ═══ InteractionController ═══ */
  const IC = {
    px: 0, py: 0, tx: 0, ty: 0, hover: -1, gain: 1,
    init(){
      if (finePointer && motion) addEventListener('pointermove', e => { this.tx = (e.clientX / innerWidth) * 2 - 1; this.ty = (e.clientY / innerHeight) * 2 - 1; wake(); }, { passive: true });
      document.addEventListener('visibilitychange', wake);
    },
    step(dt){ this.px = damp(this.px, this.tx, 4, dt); this.py = damp(this.py, this.ty, 4, dt); }
  };
  IC.init();

  /* ═══ slots ═══ */
  const slots = [...document.querySelectorAll('.stage[data-slot]')].map(el => ({ el, kind: el.dataset.slot, visible: false, camera: new THREE.PerspectiveCamera(38, 1, .05, 80), pose: {}, rect: null, show: new Set(), labels: null, lastP: null }));
  const io = new IntersectionObserver(es => { es.forEach(e => { const s = slots.find(s => s.el === e.target); if (s) s.visible = e.isIntersecting; }); wake(); }, { rootMargin: '10% 0px 10% 0px' });
  slots.forEach(s => io.observe(s.el));
  const byKind = k => slots.find(s => s.kind === k);

  /* the whole mechanism, framed: distance follows the slot's aspect so the stack fits either way */
  function revealCam(aspect, fov = 38, half = 9.3){
    const t = Math.tan(fov / 2 * Math.PI / 180);
    const d = aspect >= 1 ? half / (t * aspect) * 1.04 : half / t * 1.06;
    const dir = V3(.05, .32, .95).normalize().multiplyScalar(Math.min(d, 70));
    return [.6 + dir.x, -.1 + dir.y, dir.z];
  }
  const RIDE = { cam: [-1.2, .8, 1.7], tgt: [1.4, -.15, 0] };
  const ride = px => ({ cam: [px + RIDE.cam[0], RIDE.cam[1], RIDE.cam[2]], tgt: [px + RIDE.tgt[0], RIDE.tgt[1], 0] });

  /* ── hero: the incident, as a camera move along the path ── */
  const BASE = { fov: 38, fog: .03, packetOn: 1, ghost: 1, parsed: 0, glow: 0, shutter: 0, barA: 0, barB: 0, probeOut: 0, probeBack: 0, verifyOut: 0, verifyBack: 0,
                 aAgent: 1, aProxy: .55, aMandate: .35, aG: [.32, .32, .32, .32, .5, .32], tick: [0, 0, 0, 0, 0, 0], aIntent: .2, aRail: .2, railOk: 0 };
  const heroKeys = keyframes([
    [0.00, Object.assign({}, BASE, { cam: [-10.0, 1.0, 2.5], tgt: [-8.3, 0, 0], packetX: X.agent })],
    [0.10, Object.assign({ packetX: -6.9 }, ride(-6.9))],
    [0.19, Object.assign({ packetX: -3.7, aProxy: 1 }, ride(-3.7))],
    [0.21, { glow: 1 }],
    [0.23, Object.assign({ packetX: -3.35, glow: 0, ghost: 0, parsed: 1 }, ride(-3.35))],
    [0.28, Object.assign({ packetX: -2.25, aMandate: 1, aAgent: .5 }, ride(-2.25))],
    [0.34, Object.assign({ packetX: -.1, aG: [1, .32, .32, .32, .5, .32] }, ride(-.1))],
    [0.355, { tick: [1, 0, 0, 0, 0, 0] }],
    [0.40, Object.assign({ packetX: .45, aG: [1, .7, .32, .32, .5, .32] }, ride(.45))],
    [0.47, { packetX: STOP_X, cam: [-1.2, 1.15, 2.7], tgt: [3.0, -.1, 0], fov: 36, aG: [1, 1, .32, .32, .5, .32] }],
    [0.48, {}],
    [0.52, { probeOut: 1 }],
    [0.55, { probeBack: 1 }],
    [0.59, {}],
    [0.61, { barA: 1 }],
    [0.63, {}],
    [0.645, { barB: 1 }],
    [0.68, {}],
    [0.70, { shutter: 1 }],
    [0.80, { cam: [-1.3, 1.2, 2.8], tgt: [3.0, -.1, 0] }],
    [0.92, { cam: [0, 0, 0], tgt: [.6, -.1, 0], fov: 38, fog: .018, aAgent: .6, aProxy: .8, aMandate: .7, aG: [.7, 1, .32, .32, .5, .32] }],
    [1.00, {}],
  ]);
  const rideC = px => ({ cam: [px - .7, .9, 2.8], tgt: [px + .15, -.1, 0] });
  const heroKeysCoarse = keyframes(heroKeys.map(k => {
    const v = Object.assign({}, k.v);
    if (k.p <= .40 && v.packetX !== undefined) Object.assign(v, rideC(k.p === 0 ? X.agent : v.packetX));
    if (k.p >= .47 && k.p <= .80){ v.cam = [-1.6, 1.25, 3.6]; v.tgt = [1.5, -.1, 0]; v.fov = 40; }
    return [k.p, v];
  }));
  const heroCaps = [['proxy', .13, .27], ['stop', .70, .84], ['reveal', .92, 1.01]];
  const heroIndex = [[0, 'ai agent'], [.10, 'mcp transport'], [.19, 'interlock proxy'], [.27, 'mandate'], [.33, 'gate 01 · scope'], [.41, 'gate 02 · value'], [.48, 'gate 02 · resolving'], [.59, 'gate 02 · evidence'], [.70, 'gate 02 · block'], [.84, 'the stack']];
  const heroLabelDefs = () => [
    { key: 'agent', html: 'ai agent · support-agent', anchor: V3(X.agent, -.3, 0), align: 'c', dy: 10 },
    { key: 'pSans', cls: 'sans', html: 'create_refund for <b>₹48,000</b>', anchor: V3(), dy: -14, valign: 'b', align: 'c' },
    { key: 'pMono', cls: 'evd hi', html: '<span class="k">create_refund · well-formed</span>amount_minor <b>4800000</b> · subject order_A8841', anchor: V3(), dy: -16, valign: 'b', align: 'c' },
    { key: 'pBad', cls: 'evd', html: '<span class="k">proposed · no authority</span><b class="red">₹48,000</b> · create_refund', anchor: V3(), dy: -16, valign: 'b', align: 'c' },
    { key: 'pBad2', cls: 'evd', html: '<span class="k">proposed · no authority</span><b class="red">₹48,000</b> · create_refund', anchor: V3(), dy: 18, align: 'c' },
    { key: 'proxy', cls: 'hold', html: 'interlock proxy · ai stops here', anchor: V3(X.proxy, 1.42, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'det', html: 'deterministic execution begins', anchor: V3(X.proxy + .2, Y_FLOOR, 1.6), dy: 10 },
    { key: 'mandate', cls: 'hi', html: 'mandate · yaml · approved by a human', anchor: V3(X.mandate, .875, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'g0', cls: 'hi', html: '01 · scope', anchor: V3(0, gateH(0) / 2, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'g0pass', cls: 'hi', html: '<i class="tick"></i>pass', anchor: V3(0, -gateH(0) / 2, 0), align: 'c', dy: 12 },
    { key: 'g1', cls: 'hi', html: '02 · value', anchor: V3(1, gateH(1) / 2, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'probe', cls: 'evd hi', html: '<span class="k">read-only client</span>resolve <b>order_A8841</b> from the rail', anchor: V3(3.0, .93, .95), align: 'c', dy: 10 },
    { key: 'ev1', cls: 'evd', html: '<span class="k">resolved_order</span><b>order_A8841</b>', anchor: V3(1, gateH(1) / 2, .9), dx: 14, dy: -6, valign: 'b' },
    { key: 'ev2', cls: 'evd', html: '<span class="k">order_amount_minor</span><b>4800000</b> → ₹48,000', anchor: V3(1, .3, .78), dx: 14, valign: 'm' },
    { key: 'ev3', cls: 'evd', html: coarse ? '<span class="k">claimed_line_item_minor</span><b>189900</b> → ₹1,899' : '<span class="k">claimed_line_item_minor</span><b>189900</b> → ₹1,899 · the authority', anchor: V3(1, .05, .78), dx: 14, valign: 'm' },
    { key: 'ev4', cls: 'evd', html: '<span class="k">return_record</span>null', anchor: V3(1, -.25, .78), dx: 14, valign: 'm' },
    { key: 'verdict', cls: 'chip', html: 'VALUE_NOT_AUTHORISED <i>block</i>', anchor: V3(1, gateH(1) / 2, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'never', html: 'gates 03–06 · never ran', anchor: V3(3.9, gateH(3) / 2 + .1, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'intent', html: 'intent · never written', anchor: V3(X.intent, .32, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'rail', cls: 'hi', html: 'rail · call 0', anchor: V3(X.rail, .55, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'egress', html: 'upstream mcp', anchor: V3(X.egress, Y_FLOOR, 0), align: 'c', dy: 10 },
  ];

  /* ── dive: inspection of the machine, one layer at a time ── */
  const diveLabelDefs = () => [
    { key: 'proxy', cls: 'hold', html: 'ai stops here', anchor: V3(X.proxy, 1.42, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'mandate', cls: 'hi', html: 'mandate', anchor: V3(X.mandate, .875, 0), align: 'c', valign: 'b', dy: -10 },
    ...X.gates.map((x, i) => ({ key: 'g' + i, cls: i === 4 ? 'hold' : 'hi', html: GATE_SHORT[i], anchor: V3(x, i === 4 ? G5_LIFT + gateH(i) / 2 : gateH(i) / 2, 0), align: 'c', valign: 'b', dy: -10 })),
    { key: 'g4long', cls: 'hold', html: GATE_NAMES[4], anchor: V3(4, G5_LIFT + gateH(4) / 2, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'g4note', cls: 'hold evd', html: '<span class="k" style="color:var(--hold)">not in the path</span>advisory · can hold or block<br>can never allow', anchor: V3(4, G5_LIFT - gateH(4) / 2, .8), dx: 10, dy: 6 },
    { key: 'intent', cls: 'hi', html: 'durable intent', anchor: V3(X.intent, .32, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'rail', cls: 'hi', html: 'rail · at most once', anchor: V3(X.rail, .55, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'out', cls: 'ok', html: '<i class="tick"></i>outcome verified', anchor: V3(X.rail, -.5, 0), align: 'c', dy: 12 },
    { key: 'egress', html: 'upstream mcp', anchor: V3(X.egress, .9, 0), align: 'c', valign: 'b', dy: -8 },
  ];
  const diveCamFor = (i, aspect) => {
    if (i < 0) return { cam: [-3.4, 1.9, 6.2], tgt: [2.2, -.1, 0], fov: 38, fog: .026 };
    if (i >= 6) return { cam: [X.intent - 1.7, 1.6, 5.2], tgt: [X.intent + 1.1, -.05, 0], fov: 36, fog: .025 };
    const x = X.gates[i], y = i === 4 ? .38 : 0; return { cam: [x - 1.6, 1.55 + y, 5.0], tgt: [x + .35, -.05 + y, 0], fov: 36, fog: .025 };
  };

  /* ── act II ── */
  const killLabelDefs = () => [
    { key: 'state', cls: 'big', html: 'PROPOSED', anchor: V3(-.55, 0, .62), align: 'c', dy: 14 },
    { key: 'disk', html: 'on disk · sqlite · write-ahead log', anchor: V3(-2.3, 0, 1.4), dy: 10 },
    { key: 'proc', cls: 'hi', html: 'process', anchor: V3(.05, 1.5, 0), align: 'c', valign: 'b', dy: -8 },
    { key: 'dead', cls: 'bad', html: 'process terminated · kill -9', anchor: V3(.05, 1.5, 0), align: 'c', valign: 'b', dy: -8 },
    { key: 'boot', cls: 'hi', html: 'new process · boot', anchor: V3(.05, 1.5, 0), align: 'c', valign: 'b', dy: -8 },
    { key: 'rail', cls: 'hi', html: 'rail', anchor: V3(2.55, .72, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'fsync', cls: 'evd hi', html: '<span class="k">write-ahead</span>fsynced <b>before</b> the call', anchor: V3(-.2, .8, 0), dx: 12, valign: 'm' },
    { key: 'lease', html: 'lease · +30s', anchor: V3(-.25, .51, .36), dx: 10, valign: 'm' },
    { key: 'lease0', cls: 'hold', html: 'lease expired', anchor: V3(-.25, .51, .36), dx: 10, valign: 'm' },
    { key: 'call', cls: 'hi', html: 'rail call · in flight', anchor: V3(1.2, .95, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'unknown', cls: 'hold', html: 'did the rail act? unknown', anchor: V3(1.2, .95, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'found', cls: 'evd hi', html: '<span class="k">found on disk at boot</span>not retried', anchor: V3(-.2, .95, 0), dx: -14, align: 'r', valign: 'm' },
    { key: 'probe', cls: 'hold', html: 'reconciling · ×<b data-n>1</b> · pages read, nothing found', anchor: V3(1.2, 1.6, -.35), align: 'c', valign: 'b', dy: -10 },
    { key: 'quar', cls: 'bad', html: 'a named human decides', anchor: V3(-.55, 0, .62), align: 'c', dy: 54 },
  ];
  /* one pose per state, sub-beats from the fraction scrolled through that state's row */
  function killPose(i, f){
    const s = { slabOn: 0, fill: 0, row: 0, proc: 1, packetOn: 1, packetT: 0, write: 0, writeOn: 0, call: 0, callOn: 0, ghost: 0, read: 0, probes: 0, lease: 0, leaseOn: 0, leaseExpired: 0, terminal: 0, terminalHold: 0, quarantine: 0, fsync: 0, parallax: 1 };
    if (i >= 0){ s.slabOn = 1; s.row = 1; }
    if (i >= 1){ s.fill = 1; }
    if (i === 2){ s.write = smooth(range(f, 0, .3)); s.writeOn = 1; s.fsync = 1; s.lease = smooth(range(f, .3, .5)); s.leaseOn = s.lease > 0 ? 1 : 0; s.call = smooth(range(f, .5, 1)); s.callOn = 1; s.packetT = .7 * smooth(range(f, .55, 1)); }
    if (i >= 3){ s.write = 1; s.lease = 1; s.leaseOn = 1; s.call = 1; s.packetT = .7; }
    if (i === 3){ const fade = 1 - smooth(range(f, 0, .45)); s.proc = fade; s.packetOn = fade; s.callOn = fade; s.writeOn = fade * .6; s.ghost = smooth(range(f, .2, .6)); s.lease = 1 - smooth(range(f, .5, 1)); }
    if (i >= 4){ s.proc = 0; s.packetOn = 0; s.callOn = 0; s.writeOn = .35; s.ghost = 1; s.lease = 0; s.leaseOn = 0; s.leaseExpired = 1; s.terminal = 1; s.terminalHold = 1; s.parallax = 0; }
    if (i === 4){ s.proc = smooth(range(f, 0, .3)); s.read = smooth(range(f, .2, .5)); }
    if (i >= 5){ s.proc = 1; s.read = 1; }
    if (i >= 6){ s.parallax = .5; }
    if (i === 6){ s.probes = f * 6; }
    if (i >= 7){ s.probes = 7; s.quarantine = 1; s.terminal = .35; s.terminalHold = 0; s.proc = .3; s.read = 0; s.leaseExpired = 0; }
    return s;
  }
  const KILL_STATE = ['PROPOSED', 'AUTHORIZED', 'IN_FLIGHT', 'IN_FLIGHT', 'UNKNOWN', 'UNKNOWN', 'RECONCILING', 'QUARANTINED'];
  const KILL_CLS = ['', 'ok', '', '', 'hold', 'hold', 'hold', 'bad'];

  /* ── the invitation: a clean path, camera still ── */
  const ctaLabelDefs = () => [
    { key: 'packet', cls: 'txt', html: 'create_refund · ₹2,800', anchor: V3(), dy: -12, align: 'c', valign: 'b' },
    { key: 'g4', cls: 'hold', html: '05 · off by default · not in the path', anchor: V3(4, G5_LIFT + gateH(4) / 2, 0), align: 'c', valign: 'b', dy: -10 },
    { key: 'call1', cls: 'hi', html: 'rail · called once', anchor: V3(X.rail, .55, .9), align: 'r', dx: -6, valign: 'b', dy: -10 },
    { key: 'applied', cls: 'big ok', html: 'APPLIED<small style="color:var(--allow)">verified against the ledger</small>', anchor: V3(X.rail, -.55, .9), align: 'r', dx: -6, dy: 16 },
    { key: 'intent', cls: 'hi', html: 'intent · fsynced first', anchor: V3(X.intent, .32, -.5), align: 'r', dx: -10, valign: 'b', dy: -10 },
  ];
  const CTA_PATH = [[0, X.agent], [.22, X.proxy], [.30, X.mandate], [.70, 5], [.74, X.intent], [.86, X.rail]];
  const ctaX = q => { for (let i = 0; i < CTA_PATH.length - 1; i++){ const [qa, xa] = CTA_PATH[i], [qb, xb] = CTA_PATH[i + 1]; if (q <= qb) return lerp(xa, xb, range(q, qa, qb)); } return X.rail; };

  /* build label sets */
  for (const s of slots){
    const holder = s.el.querySelector('[data-labels]');
    const defs = s.kind === 'hero' ? heroLabelDefs() : s.kind === 'dive' ? diveLabelDefs() : s.kind === 'kill' ? killLabelDefs() : ctaLabelDefs();
    s.labels = new Labels(holder, defs); s.label = k => s.labels.defs.find(d => d.key === k);
  }

  /* ═══ ScrollController ═══ */
  const hero = byKind('hero'), dive = byKind('dive'), kill = byKind('kill'), cta = byKind('cta');
  const dom = {
    track: document.getElementById('track-hero'), copyWrap: document.getElementById('hero-copy-wrap'), copy: document.querySelector('.hero-copy'), readout: document.querySelector('.readout'),
    caps: [...document.querySelectorAll('.xr-cap')], heroIndex: hero.el.querySelector('.xr-index'), heroLayer: hero.el.querySelector('[data-xr="layer"]'), heroBar: hero.el.querySelector('[data-xr="bar"]'),
    gates: [...document.querySelectorAll('.machine .gate')], machineOut: document.querySelector('.machine-out'),
    diveIndex: dive.el.querySelector('.xr-index'), diveLayer: dive.el.querySelector('[data-xr="layer"]'), diveBar: dive.el.querySelector('[data-xr="bar"]'),
    states: document.getElementById('states'), ticks: [...document.querySelectorAll('#states .ticks i')],
    ctaRows: [...document.querySelectorAll('.final .trace [data-q]')],
  };
  const SC = {
    vh: innerHeight, heroP: motion ? 0 : 1, diveI: -1, killI: -1, killFrac: 0, ctaQ: motion ? 0 : 1,
    update(){
      this.vh = innerHeight;
      if (!motion) return;
      /* hero: the stage pins once the copy above it (phones) has scrolled away */
      const tr = dom.track.getBoundingClientRect();
      const copyH = dom.copyWrap.offsetHeight;
      const total = tr.height - copyH - this.vh;
      this.heroP = total > 10 ? clamp(-(tr.top + copyH) / total) : 1;
      /* dive: the gate being read is the last one whose top has passed 48% of the viewport */
      let di = -1; const line = this.vh * .48;
      dom.gates.forEach((g, i) => { if (g.getBoundingClientRect().top < line) di = i; });
      if (dom.machineOut.getBoundingClientRect().top < line) di = 6;
      if (dom.gates[0].getBoundingClientRect().top > this.vh * 1.1) di = -1;
      this.diveI = di;
      /* act II: rows that have crossed 58% of the viewport, and how far */
      let ki = -1, frac = 0; const kl = this.vh * .58;
      [...dom.states.children].forEach((r, i) => { const rc = r.getBoundingClientRect(); if (rc.top < kl){ ki = i; frac = clamp((kl - rc.top) / Math.max(1, rc.height)); } });
      this.killI = ki; this.killFrac = frac;
      /* the invitation: how far it has risen into view; exactly 1 at the end of the page */
      const cr = cta.el.getBoundingClientRect();
      const maxScroll = document.documentElement.scrollHeight - this.vh;
      const restTop = cr.top - (maxScroll - scrollY);
      const span = Math.min(1.1 * cr.height, .9 * this.vh - restTop);
      this.ctaQ = span > 40 ? clamp((.9 * this.vh - cr.top) / span) : 1;
    }
  };

  /* ═══ per-slot pose sampling ═══ */
  const tmpV = V3();
  const vertical = aspect => aspect < 1;
  function heroTarget(s, p, aspect){
    const keys = coarse ? heroKeysCoarse : heroKeys;
    const k = sampleKeys(keys, p);
    if (p > .80){ const t = range(p, .80, .92); const rc = revealCam(aspect, 38, vertical(aspect) ? 10.6 : 9.3); const a = sampleKeys(keys, .80).cam; k.cam = [lerp(a[0], rc[0], t), lerp(a[1], rc[1], t), lerp(a[2], rc[2], t)]; }
    if (!motion){
      /* a still: the copy holds the left of the stage, so the frame is shifted so the membrane-to-rail span sits on the right */
      const wide = aspect >= 1 && !coarse; const dx = wide ? -3.0 : 0; const rc = revealCam(aspect, 38, wide ? 12.4 : 9.3);
      k.cam = [rc[0] + dx, rc[1], rc[2]]; k.tgt = [.6 + dx, -.1, 0]; k.shutter = 1; k.barA = 1; k.barB = 1; k.packetX = STOP_X; k.ghost = 0; k.parsed = 1; k.fog = .016;
    }
    const v = vertical(aspect) ? smooth(range(p, .80, .96)) : 0; k.up = [-v, 1 - v, 0];
    if (v > 0){ k.cam[0] += 1.9 * v; k.tgt[0] += 1.9 * v; k.cam[1] -= .5 * v; k.tgt[1] -= .5 * v; }
    if (!motion && vertical(aspect)) k.up = [-1, 0, 0];
    return k;
  }
  function heroShow(s, p, pose){
    const show = s.show; show.clear();
    const on = (k, a, b) => { if (p >= a && p < b) show.add(k); };
    on('agent', 0, .17); on('pSans', 0, .225); on('pMono', .225, .70); on('pBad', .70, .84); on('pBad2', .84, 1.01);
    on('proxy', .12, .27); on('det', .215, .30); on('mandate', .255, .37); on('g0', .31, .45); on('g0pass', .355, .47); on('g1', .40, .59);
    on('probe', .485, .555); on('ev1', .565, .84); on('ev3', .64, .84); if (!coarse){ on('ev2', .605, .84); on('ev4', .665, .84); }
    on('verdict', .70, 1.01); on('never', .83, 1.01); on('intent', .86, 1.01); on('rail', .885, 1.01); on('proxy', .84, 1.01); if (!coarse) on('egress', .90, 1.01);
    if (!motion){ show.clear(); (coarse ? ['pBad2', 'proxy', 'verdict', 'never', 'rail'] : ['pBad2', 'verdict', 'never', 'rail']).forEach(k => show.add(k)); }
    /* the packet's own labels ride with it */
    const pp = stack.packetPos(pose.packetX, tmpV); ['pSans', 'pMono', 'pBad'].forEach(k => s.label(k).anchor.set(pp.x, pp.y + .08, pp.z)); s.label('pBad2').anchor.set(pp.x, pp.y - .08, pp.z);
  }
  function heroDom(p){
    if (!motion) return;
    const fade = coarse ? 1 : 1 - smooth(range(p, .03, .11));
    dom.copy.style.opacity = fade; dom.copy.style.transform = coarse ? '' : `translateY(${(1 - fade) * -14}px)`; dom.copy.classList.toggle('gone', fade < .05);
    const rf = 1 - smooth(range(p, .05, .14));
    dom.readout.style.opacity = rf; dom.readout.style.transform = `translateY(${(1 - rf) * 16}px)`; dom.readout.classList.toggle('gone', rf < .05);
    for (const c of dom.caps){ const r = heroCaps.find(x => x[0] === c.dataset.cap); c.classList.toggle('on', !!r && p >= r[1] && p < r[2]); }
    let name = heroIndex[0][1]; for (const [a, n] of heroIndex) if (p >= a) name = n;
    if (dom.heroLayer.textContent !== name) dom.heroLayer.textContent = name;
    dom.heroBar.style.width = (p * 100).toFixed(1) + '%';
    dom.heroIndex.classList.toggle('on', p > .08 && p < (coarse ? .86 : .995));
  }

  function diveTarget(s, i, aspect){
    const k = Object.assign({}, BASE, diveCamFor(motion ? i : -1, aspect));
    const hov = IC.hover;
    k.aG = X.gates.map((x, j) => j === i ? 1 : j === hov ? .85 : (Math.abs(j - i) === 1 ? .55 : .36));
    if (i === 4) k.aG[4] = 1;
    k.aMandate = i < 0 ? .7 : i === 0 ? .6 : .35; k.aIntent = i >= 6 ? 1 : i < 0 ? .5 : .2; k.aRail = i >= 6 ? .9 : i < 0 ? .5 : .2; k.railOk = i >= 6 ? 1 : 0;
    k.aProxy = i < 0 ? .8 : .4; k.aAgent = i < 0 ? .6 : .3; k.packetOn = 0; k.packetX = X.agent; k.railOk = i >= 6 ? .6 : 0;
    k.up = [0, 1, 0];
    if (!motion){ k.aG = [1, 1, 1, 1, 1, 1]; k.aMandate = .9; k.aIntent = .9; k.aRail = .9; }
    return k;
  }
  function diveShow(s, i){
    const show = s.show; show.clear();
    if (!motion || i < 0){ ['proxy', 'mandate', 'g0', 'g4', 'rail'].forEach(k => show.add(k)); return; }
    if (i >= 6){ show.add('g5'); show.add('intent'); show.add('rail'); show.add('out'); show.add('egress'); return; }
    if (i === 4){ show.add('g4long'); show.add('g4note'); } else show.add('g' + i); if (i === 0) show.add('mandate');
    if (IC.hover >= 0) show.add('g' + IC.hover);
  }
  function diveDom(i){
    const name = i < 0 ? 'the stack' : i >= 6 ? 'intent · rail' : 'gate ' + GATE_SHORT[i];
    if (dom.diveLayer.textContent !== name) dom.diveLayer.textContent = name;
    dom.diveBar.style.width = (i < 0 ? 0 : i >= 6 ? 100 : ((i + 1) / 6) * 100) + '%';
    dom.diveIndex.classList.toggle('on', motion);
    dom.gates.forEach((g, j) => g.classList.toggle('focus', j === IC.hover));
  }

  function killTarget(s, i, frac, aspect){
    const k = killPose(motion ? i : 7, motion ? frac : 1);
    k.cam = [3.0, 2.0, 5.4]; k.tgt = [.7, .35, 0]; k.fov = 38; k.fog = .02; k.up = [0, 1, 0];
    return k;
  }
  function killShow(s, i, frac, pose){
    const show = s.show; show.clear(); if (!motion){ i = 7; frac = 1; }
    if (i >= 0) show.add('state'); show.add('rail');
    if (i >= 0 && i < 3) show.add('proc'); if (i === 3) show.add('dead'); if (i === 4 && pose.proc > .3) show.add('boot');
    if (i >= 1) show.add('disk');
    if (i === 2 && frac > .05) show.add('fsync'); if (i >= 2 && i < 4 && (i > 2 || frac > .3)) show.add('lease'); if (i === 2 && frac > .5) show.add('call'); if (i === 3) show.add('unknown');
    if (i >= 4 && i < 7) { show.add('lease0'); } if (i >= 4 && i < 6) { show.add('found'); }
    if (i === 6) show.add('probe'); if (i >= 7) show.add('quar');
    if (coarse) ['disk', 'lease', 'lease0', 'fsync', 'found', 'call'].forEach(k => show.delete(k));
    const st = s.label('state'); const idx = clamp(i, 0, 7);
    const n = Math.max(1, Math.min(6, Math.ceil(frac * 6 - 1e-6)));
    const txt = KILL_STATE[idx] + (idx === 6 ? ' ×' + n : '');
    if (st.el.dataset.txt !== txt){ st.el.dataset.txt = txt; st.el.innerHTML = txt; st.el.className = 'lab big ' + KILL_CLS[idx] + (st.on ? ' on' : ''); }
    const pr = s.label('probe').el.querySelector('[data-n]'); if (pr && pr.textContent != n) pr.textContent = n;
  }
  function killDom(i, frac){
    if (!motion) return;
    [...dom.states.children].forEach((r, j) => r.classList.toggle('on', j <= i));
    const n = i > 6 ? 6 : i === 6 ? Math.min(6, Math.ceil(frac * 6 - 1e-6)) : 0;
    dom.ticks.forEach((t, j) => t.classList.toggle('on', j < n));
  }

  function ctaTarget(s, q, aspect){
    const px = ctaX(q);
    const passed = x => smooth(range(px, x - .3, x + .05));
    const k = Object.assign({}, BASE, { packetX: Math.min(px, X.rail - .05), packetOn: q > .005 && q < .995 ? 1 : 0, ghost: 1 - passed(X.proxy), parsed: passed(X.proxy), glow: clamp(1 - Math.abs(px - X.proxy) / .5) * .8 });
    k.aAgent = .6; k.aProxy = lerp(.55, .9, passed(X.proxy)); k.aMandate = lerp(.35, .85, passed(X.mandate));
    k.aG = X.gates.map((x, i) => i === 4 ? .5 : lerp(.36, .85, passed(x))); k.tick = X.gates.map((x, i) => i === 4 ? 0 : passed(x + .12));
    k.aIntent = lerp(.2, 1, passed(X.intent)); k.aRail = lerp(.2, .9, passed(X.rail)); k.railOk = q >= .95 ? 1 : 0;
    k.verifyOut = smooth(range(q, .88, .92)); k.verifyBack = smooth(range(q, .93, .96));
    k.cam = revealCam(aspect); k.tgt = [.6, -.1, 0]; k.fov = 38; k.fog = .018; k.up = [vertical(aspect) ? -1 : 0, vertical(aspect) ? 0 : 1, 0];
    if (!motion){ k.packetOn = 0; k.railOk = 1; k.aIntent = 1; k.aRail = .9; k.tick = [1, 1, 1, 1, 0, 1]; k.aG = [.85, .85, .85, .85, .5, .85]; k.aMandate = .85; k.aProxy = .9; }
    return k;
  }
  function ctaShow(s, q, pose){
    const show = s.show; show.clear();
    if (motion && q > .01 && q < .95) show.add('packet');
    if (q > .58 && q < .70) show.add('g4');
    if (q >= .86 && !coarse) show.add('call1'); if (q >= .74 && !coarse) show.add('intent'); if (q >= .95) show.add('applied');
    const pp = stack.packetPos(pose.packetX, tmpV); s.label('packet').anchor.set(pp.x, pp.y + .08, pp.z);
    dom.ctaRows.forEach(r => r.classList.toggle('lit', q >= parseFloat(r.dataset.q)));
  }

  /* ═══ the frame loop ═══ */
  let last = performance.now(), awake = true, rafId = 0, firstFrame = true, lastScrollY = -1, frameAvg = 16;
  const RATES = { cam: 6, tgt: 6, up: 4, fov: 5, fog: 4, packetX: 9, packetOn: 6, ghost: 6, parsed: 6, glow: 8, shutter: 8, barA: 10, barB: 10, probeOut: 10, probeBack: 10, verifyOut: 10, verifyBack: 10,
                  aAgent: 5, aProxy: 5, aMandate: 5, aG: 5, tick: 8, aIntent: 5, aRail: 5, railOk: 6,
                  slabOn: 6, fill: 5, row: 5, proc: 4, packetT: 6, write: 8, writeOn: 6, call: 6, callOn: 5, ghost: 4, read: 8, probes: 12, lease: 5, leaseOn: 6, leaseExpired: 5, terminal: 5, terminalHold: 5, quarantine: 5, parallax: 2 };
  function wake(){ if (!awake){ awake = true; last = performance.now(); rafId = requestAnimationFrame(frame); } }
  function rectOf(el){ const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom }; }
  function renderSlot(s, scene){
    const r = s.rect, w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const H = canvas.clientHeight || innerHeight;
    const left = Math.round(r.left), bottom = Math.round(H - r.bottom);
    const clipTop = Math.max(r.top, 58);                              /* nothing is ever painted under the header */
    const ch = Math.round(r.bottom - clipTop); if (ch <= 0) return;
    renderer.setViewport(left, bottom, w, h);
    renderer.setScissor(left, bottom, w, ch); renderer.setScissorTest(true);
    renderer.setClearColor(C.bg, 1); renderer.clear();
    s.camera.aspect = w / h; s.camera.updateProjectionMatrix();
    renderer.render(scene, s.camera);
  }
  function placeCamera(s, k, gain = 1){
    const cam = s.camera;
    cam.fov = k.fov; cam.position.set(k.cam[0], k.cam[1], k.cam[2]);
    tmpV.set(k.tgt[0], k.tgt[1], k.tgt[2]);
    if (finePointer && motion && gain > 0){
      const d = cam.position.distanceTo(tmpV); const up = V3(k.up[0], k.up[1], k.up[2]).normalize(); const fwd = tmpV.clone().sub(cam.position).normalize(); const right = fwd.clone().cross(up).normalize();
      cam.position.addScaledVector(right, IC.px * d * .016 * gain).addScaledVector(up, -IC.py * d * .012 * gain);
    }
    cam.up.set(k.up[0], k.up[1], k.up[2]).normalize(); cam.lookAt(tmpV); cam.updateMatrixWorld();
  }
  function frame(now){
    rafId = 0;
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000)); last = now;
    frameAvg = frameAvg * .95 + dt * 1000 * .05;
    if (frameAvg > 30 && dpr > 1){ dpr = Math.max(1, dpr - .25); renderer.setPixelRatio(dpr); frameAvg = 16; }
    SC.update(); IC.step(dt);
    renderer.setScissorTest(false); renderer.setClearColor(C.bg, 0); renderer.clear();
    let moving = Math.abs(IC.px - IC.tx) > 1e-3 || Math.abs(IC.py - IC.ty) > 1e-3;
    for (const s of slots){
      s.rect = rectOf(s.el);
      const onScreen = s.rect.bottom > -20 && s.rect.top < innerHeight + 20 && s.rect.width > 2 && s.rect.height > 2;
      if (!onScreen && !s.visible) continue;
      const aspect = s.rect.width / Math.max(1, s.rect.height);
      let tgt, p;
      if (s.kind === 'hero'){ p = SC.heroP; tgt = heroTarget(s, p, aspect); }
      else if (s.kind === 'dive'){ p = SC.diveI; tgt = diveTarget(s, p, aspect); }
      else if (s.kind === 'kill'){ p = SC.killI + SC.killFrac; tgt = killTarget(s, SC.killI, SC.killFrac, aspect); }
      else { p = SC.ctaQ; tgt = ctaTarget(s, p, aspect); }
      const first = !s.pose.cam;
      const jump = s.lastP !== null && Math.abs(p - s.lastP) > .2;                 /* a hash jump: snap, do not replay */
      if (first && s.kind === 'hero' && motion){ Object.assign(s.pose, tgt); s.pose.packetX = X.agent - 1.2; s.pose.packetOn = 0; s.pose.cam = tgt.cam.slice(); s.pose.tgt = tgt.tgt.slice(); }   /* the request arrives on its own */
      dampPose(s.pose, tgt, first || jump ? 1e9 : dt, RATES);
      s.lastP = p;
      if (!settled(s.pose, tgt)) moving = true;
      if (!onScreen) continue;
      const k = s.pose;
      if (s.kind === 'hero'){ heroShow(s, p, k); heroDom(p); placeCamera(s, k); stackScene.fog.density = k.fog; stack.apply(k); renderSlot(s, stackScene); }
      else if (s.kind === 'dive'){ diveShow(s, p); diveDom(p); placeCamera(s, k); stackScene.fog.density = k.fog; stack.apply(k); renderSlot(s, stackScene); }
      else if (s.kind === 'kill'){ killShow(s, SC.killI, SC.killFrac, k); killDom(SC.killI, SC.killFrac); placeCamera(s, k, k.parallax); dur.apply(k); renderSlot(s, killScene); }
      else { ctaShow(s, p, k); placeCamera(s, k); stackScene.fog.density = k.fog; stack.apply(k); renderSlot(s, stackScene); }
      s.labels.update(s.camera, s.rect.width, s.rect.height, s.show);
    }
    if (firstFrame){ firstFrame = false; root.classList.add('ready'); moving = true; }
    if (scrollY !== lastScrollY){ lastScrollY = scrollY; moving = true; }
    awake = moving && !document.hidden;
    if (awake) rafId = requestAnimationFrame(frame);
  }

  /* ═══ resize · scroll · hover ═══ */
  let lastW = 0, lastH = 0;
  function resize(){ const w = innerWidth, h = canvas.clientHeight || innerHeight; if (w !== lastW || h !== lastH){ lastW = w; lastH = h; renderer.setSize(w, h, false); } wake(); }
  resize();
  addEventListener('resize', resize, { passive: true });
  addEventListener('orientationchange', resize, { passive: true });
  addEventListener('scroll', wake, { passive: true });
  if (window.ResizeObserver){ const ro = new ResizeObserver(() => wake()); slots.forEach(s => ro.observe(s.el)); }

  if (finePointer && motion){
    const hit = dive.el.querySelector('[data-labels]'); const ray = new THREE.Raycaster(); const nd = new THREE.Vector2();
    const pick = e => { const r = dive.rect; if (!r) return -1; nd.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(nd, dive.camera); const hits = ray.intersectObjects(stack.hits, false); return hits.length ? hits[0].object.userData.gate : -1; };
    hit.addEventListener('pointermove', e => { const h = pick(e); if (h !== IC.hover){ IC.hover = h; dive.el.classList.toggle('hovering', h >= 0); wake(); } });
    hit.addEventListener('pointerleave', () => { IC.hover = -1; dive.el.classList.remove('hovering'); wake(); });
    hit.addEventListener('click', e => { const h = pick(e); if (h >= 0 && dom.gates[h]) dom.gates[h].scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  }

  /* qa:hook */
  rafId = requestAnimationFrame(frame);
  addEventListener('pagehide', () => { if (rafId) cancelAnimationFrame(rafId); });
})();
