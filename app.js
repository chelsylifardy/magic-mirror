// Magic Mirror — live reflection, breath-triggered condensation,
// hand-wiped drawing, and stroke-to-music playback.

/* ----------------------------------------------------------------------
   DOM
------------------------------------------------------------------------*/
const video = document.getElementById('webcam');
const canvasBase = document.getElementById('canvas-base');
const canvasFog = document.getElementById('canvas-fog');
const canvasFx = document.getElementById('canvas-fx');
const ctxBase = canvasBase.getContext('2d');
const ctxFog = canvasFog.getContext('2d', { willReadFrequently: false });
const ctxFx = canvasFx.getContext('2d');

const stage = document.getElementById('stage');
const instructionText = document.getElementById('instruction-text');
const tapToMistBtn = document.getElementById('tap-to-mist');
const controls = document.getElementById('controls');
const btnUndo = document.getElementById('btn-undo');
const btnClear = document.getElementById('btn-clear');
const btnMist = document.getElementById('btn-mist');
const btnPlay = document.getElementById('btn-play');
const btnPlayLabel = document.getElementById('btn-play-label');
const replayPanel = document.getElementById('replay-panel');
const btnReplayPlay = document.getElementById('btn-replay-play');
const btnReplayKeep = document.getElementById('btn-replay-keep');
const btnReplayMist = document.getElementById('btn-replay-mist');
const startScreen = document.getElementById('start-screen');
const btnStart = document.getElementById('btn-start');
const startStatus = document.getElementById('start-status');

/* ----------------------------------------------------------------------
   Sizing & video-cover mapping
------------------------------------------------------------------------*/
const view = { w: 0, h: 0, dpr: 1 };
// source rect of the video actually shown after object-fit:cover style crop
const cover = { sx: 0, sy: 0, sw: 0, sh: 0, vw: 0, vh: 0 };

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = stage.clientWidth;
  view.h = stage.clientHeight;
  for (const c of [canvasBase, canvasFog, canvasFx]) {
    c.width = Math.round(view.w * view.dpr);
    c.height = Math.round(view.h * view.dpr);
  }
  mist.onResize();
  wipe.onResize();
}
window.addEventListener('resize', resize);

function updateCoverRect() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  cover.vw = vw; cover.vh = vh;
  const dstW = canvasBase.width, dstH = canvasBase.height;
  const srcRatio = vw / vh, dstRatio = dstW / dstH;
  if (srcRatio > dstRatio) {
    cover.sh = vh; cover.sw = vh * dstRatio; cover.sy = 0; cover.sx = (vw - cover.sw) / 2;
  } else {
    cover.sw = vw; cover.sh = vw / dstRatio; cover.sx = 0; cover.sy = (vh - cover.sh) / 2;
  }
}

// map a normalized (0..1) point in the RAW (unmirrored) video frame to
// mirrored canvas pixel coordinates, honoring the cover-crop above.
function videoNormToCanvas(nx, ny) {
  const px = nx * cover.vw, py = ny * cover.vh;
  let relX = (px - cover.sx) / cover.sw;
  const relY = (py - cover.sy) / cover.sh;
  relX = 1 - relX; // mirror
  return { x: relX * canvasBase.width, y: relY * canvasBase.height };
}

/* ----------------------------------------------------------------------
   One-Euro filter — smooths jitter without adding perceptible lag
------------------------------------------------------------------------*/
class OneEuro {
  constructor(minCutoff = 0.9, beta = 0.006, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.xPrev = null; this.dxPrev = 0; this.tPrev = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.tPrev == null) { this.tPrev = t; this.xPrev = x; return x; }
    const dt = Math.max((t - this.tPrev) / 1000, 1 / 120);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuro.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat; this.dxPrev = dxHat; this.tPrev = t;
    return xHat;
  }
  reset() { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
}

/* ----------------------------------------------------------------------
   Adaptive quality
------------------------------------------------------------------------*/
const quality = {
  tier: 2, // 2 = high, 1 = medium, 0 = low
  blur: 10,
  frameTimes: [],
  sample(dt) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    if (this.frameTimes.length < 60) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    if (avg > 34 && this.tier > 0) { this.tier--; this.applyTier(); this.frameTimes.length = 0; }
    else if (avg < 18 && this.tier < 2) { this.tier++; this.applyTier(); this.frameTimes.length = 0; }
  },
  applyTier() {
    this.blur = this.tier === 2 ? 10 : this.tier === 1 ? 6 : 3;
  }
};

/* ----------------------------------------------------------------------
   Fine grain texture (tileable static noise, used to give the mist a
   very fine moisture texture rather than a flat blur)
------------------------------------------------------------------------*/
function makeGrainTile(size = 160) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const gctx = c.getContext('2d');
  const img = gctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + Math.random() * 105;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
    img.data[i + 3] = Math.random() * 255;
  }
  gctx.putImageData(img, 0, 0);
  return c;
}
const grainTile = makeGrainTile();

/* ----------------------------------------------------------------------
   Mist field — the condensation density mask
------------------------------------------------------------------------*/
class MistField {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.blobs = [];
    this.state = 'clear'; // clear | growing | blooming | fogged
    this.animStart = 0;
    this.animDur = 1600;
    this.pattern = null;
    this.currentOrigin = null;
    this.totalBreath = 0;
    this.readyAt = 0.35; // a single decent "hah"/blow should already clear this
    this.maxSpread = 6; // caps how far a single continued blow can widen
    this.lastGrainAt = 0;
  }
  onResize() {
    const old = this.canvas;
    const oldW = old.width, oldH = old.height;
    const next = document.createElement('canvas');
    next.width = canvasFog.width;
    next.height = canvasFog.height;
    const nctx = next.getContext('2d');
    if (oldW && oldH && (this.state === 'growing' || this.state === 'fogged')) {
      nctx.drawImage(old, 0, 0, oldW, oldH, 0, 0, next.width, next.height);
      if (this.currentOrigin) {
        this.currentOrigin = {
          x: this.currentOrigin.x * (next.width / oldW),
          y: this.currentOrigin.y * (next.height / oldH)
        };
      }
    }
    this.canvas = next;
    this.ctx = nctx;
    this.pattern = this.ctx.createPattern(grainTile, 'repeat');
  }
  // continuous breath-driven growth: called every frame while the user is
  // "hah"-ing or blowing at the glass. intensity is 0..~1, dt in seconds.
  // stamps a soft patch near `origin` each call — the longer/harder they
  // keep blowing, the further those stamps drift from the exact mouth
  // point (spreading the misted area outward, even across the whole
  // screen) while patches that land back on already-misted spots simply
  // add more alpha there, so revisited areas get visibly thicker.
  grow(origin, intensity, dt) {
    if (this.state === 'blooming') return; // don't fight the instant-bloom animation
    if (this.state === 'clear') {
      this.state = 'growing';
      this.totalBreath = 0;
      this.lastGrainAt = 0;
      tapToMistBtn.classList.add('hidden');
      setInstruction('Breath meets the glass...');
    }
    this.currentOrigin = origin;
    this.totalBreath += intensity * dt;

    const g = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const minDim = Math.min(W, H);
    const spread = Math.min(this.totalBreath, this.maxSpread);

    // a couple of stamps per call once it's spreading wide, so coverage
    // can keep pace with a large area instead of crawling one dot at a time
    const stampCount = 1 + Math.floor(spread * 0.8);
    for (let i = 0; i < stampCount; i++) {
      const jitterR = minDim * (0.04 + spread * 0.16);
      const angle = Math.random() * Math.PI * 2;
      const jr = Math.pow(Math.random(), 0.6) * jitterR;
      let x = origin.x + Math.cos(angle) * jr;
      let y = origin.y + Math.sin(angle) * jr;
      x = Math.min(Math.max(x, 0), W);
      y = Math.min(Math.max(y, 0), H);
      const r = minDim * (0.18 + Math.min(spread, 1) * 0.12);
      const a = Math.min((intensity * dt * 55) / stampCount, 0.5);
      if (a <= 0) continue;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();

      // blowing directly onto a spot you've already wiped clear gradually
      // re-mists it — real condensation would build back up there too
      const wctx = wipe.ctx;
      wctx.globalCompositeOperation = 'destination-out';
      wctx.fillStyle = `rgba(0,0,0,${a * 0.75})`;
      wctx.beginPath();
      wctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
      wctx.fill();
      wctx.globalCompositeOperation = 'source-over';
    }

    // periodically weave fine moisture texture into whatever has formed
    // so far, so newly-spread areas get it too, not just the original spot
    if (this.totalBreath - this.lastGrainAt > 0.3) {
      this.lastGrainAt = this.totalBreath;
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = 0.1;
      g.fillStyle = this.pattern || '#fff';
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    if (this.state === 'growing' && this.totalBreath >= this.readyAt) {
      this.state = 'fogged';
      onFogSettled();
    }
  }
  // real condensation doesn't just sit there forever — fade it out slowly
  // whenever the breath driver isn't actively adding to it. Called every
  // frame with dt=0 while actively growing (a no-op then) and with the
  // real dt otherwise, so it just gently dissipates over time when idle.
  decay(dt) {
    if (this.state !== 'growing' && this.state !== 'fogged') return;
    if (dt <= 0) return;
    const rate = 0.075; // tuned so it reads as essentially back to a clear reflection by ~30s of no mouth-open
    const a = 1 - Math.exp(-rate * dt);
    const g = this.ctx;
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = `rgba(0,0,0,${a})`;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.globalCompositeOperation = 'source-over';
  }
  reset() {
    this.state = 'clear';
    this.totalBreath = 0;
    this.currentOrigin = null;
    this.blobs = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  generateBlobs(origin) {
    const W = this.canvas.width, H = this.canvas.height;
    const minDim = Math.min(W, H);
    const o = origin || { x: W / 2, y: H * 0.55 };
    const n = 14 + Math.floor(Math.random() * 6);
    const blobs = [];
    // first patch lands right where the breath hit the glass, then
    // successive patches spread outward from it with growing radius/delay
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radial = Math.pow(Math.random(), 1.5);
      const spread = minDim * 0.46;
      let cx = o.x + Math.cos(angle) * radial * spread;
      let cy = o.y + Math.sin(angle) * radial * spread;
      // keep the cluster from sailing past the glass edges
      cx = Math.min(Math.max(cx, minDim * 0.05), W - minDim * 0.05);
      cy = Math.min(Math.max(cy, minDim * 0.05), H - minDim * 0.05);
      blobs.push({
        x: cx, y: cy,
        r: minDim * (0.14 + Math.random() * 0.2),
        alpha: 0.7 + Math.random() * 0.2,
        delay: radial * 0.7 + Math.random() * 0.15,
        dur: 0.5 + Math.random() * 0.5
      });
    }
    return blobs;
  }
  bloom(origin) {
    this.currentOrigin = origin || { x: this.canvas.width / 2, y: this.canvas.height * 0.55 };
    this.blobs = this.generateBlobs(this.currentOrigin);
    this.state = 'blooming';
    this.animStart = performance.now();
  }
  unmist(origin) {
    // "mist again": fade a fresh layer of condensation back over existing wipes
    this.currentOrigin = origin || this.currentOrigin || { x: this.canvas.width / 2, y: this.canvas.height * 0.55 };
    this.blobs = this.generateBlobs(this.currentOrigin);
    this.state = 'blooming';
    this.animStart = performance.now();
    wipe.beginRemist();
  }
  clearInstant() {
    this.state = 'clear';
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  paintStatic() {
    const g = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    for (const b of this.blobs) {
      const grad = g.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      grad.addColorStop(0, `rgba(255,255,255,${b.alpha})`);
      grad.addColorStop(0.6, `rgba(255,255,255,${b.alpha * 0.55})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fill();
    }
    // fine moisture texture, confined to the fog shape already painted
    g.globalCompositeOperation = 'source-atop';
    g.globalAlpha = 0.28;
    g.fillStyle = this.pattern || '#fff';
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    // slightly clearer perimeter
    g.globalCompositeOperation = 'destination-out';
    const edge = g.createRadialGradient(W / 2, H * 0.52, Math.min(W, H) * 0.42, W / 2, H * 0.52, Math.max(W, H) * 0.62);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.2)');
    g.fillStyle = edge;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }
  update(now) {
    if (this.state === 'blooming') {
      const t = (now - this.animStart) / this.animDur;
      if (t >= 1) {
        this.state = 'fogged';
        this.paintStatic();
        if (wipe.remisting) wipe.finishRemist();
        onFogSettled();
        return;
      }
      const g = this.ctx;
      const W = this.canvas.width, H = this.canvas.height;
      g.clearRect(0, 0, W, H);
      for (const b of this.blobs) {
        const local = Math.min(Math.max((t - b.delay) / b.dur, 0), 1);
        if (local <= 0) continue;
        const ease = 1 - Math.pow(1 - local, 3);
        const r = b.r * ease;
        const a = b.alpha * ease;
        const grad = g.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
        grad.addColorStop(0, `rgba(255,255,255,${a})`);
        grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.55})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(b.x, b.y, Math.max(r, 0.01), 0, Math.PI * 2);
        g.fill();
      }
      if (wipe.remisting) wipe.updateRemist(t);
    }
  }
}
const mist = new MistField();

/* ----------------------------------------------------------------------
   Wipe mask — accumulated cleared strokes on the glass
------------------------------------------------------------------------*/
class WipeMask {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    // the in-progress stroke is drawn on its own layer, fully cleared and
    // redrawn as ONE continuous path every time a point is added. Stroking
    // a fresh short segment on every extend (the old approach) meant each
    // segment got its own round cap, and those caps overlapping at every
    // joint is what produced the bumpy/serrated edge — a single path with
    // lineJoin:'round' has no per-segment caps to bump into each other.
    this.liveCanvas = document.createElement('canvas');
    this.liveCtx = this.liveCanvas.getContext('2d');
    this.strokes = []; // {points:[{x,y,t}], isDot}
    this.current = null;
    this.remisting = false;
    this.remistFrom = null;
  }
  onResize() {
    // preserve strokes across resize by rebuilding at new scale-independent coords
    const oldW = this.canvas.width, oldH = this.canvas.height;
    this.canvas.width = canvasFog.width;
    this.canvas.height = canvasFog.height;
    this.liveCanvas.width = canvasFog.width;
    this.liveCanvas.height = canvasFog.height;
    if (oldW && oldH && (oldW !== this.canvas.width || oldH !== this.canvas.height)) {
      const sx = this.canvas.width / oldW, sy = this.canvas.height / oldH;
      for (const s of this.strokes) for (const p of s.points) { p.x *= sx; p.y *= sy; }
      if (this.current) for (const p of this.current.points) { p.x *= sx; p.y *= sy; }
      for (const s of this.strokes) if (s.prints) for (const pr of s.prints) for (const p of pr) { p.x *= sx; p.y *= sy; }
      if (this.currentHand) for (const pr of this.currentHand.prints) for (const p of pr) { p.x *= sx; p.y *= sy; }
    }
    this.rebuild();
  }
  strokeWidth() { return Math.min(this.canvas.width, this.canvas.height) * 0.052; }
  paintSegment(ctx, x0, y0, x1, y1, isDotRadius = null) {
    const w = this.strokeWidth();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // soft outer rim
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = w;
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = w * 0.35;
    ctx.beginPath();
    if (isDotRadius != null) ctx.arc(x0, y0, isDotRadius, 0, Math.PI * 2);
    else { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    ctx.stroke();
    if (isDotRadius != null) ctx.fill();
    // clear core
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.lineWidth = w * 0.62;
    ctx.beginPath();
    if (isDotRadius != null) ctx.arc(x0, y0, isDotRadius * 0.62, 0, Math.PI * 2);
    else { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    ctx.stroke();
    if (isDotRadius != null) ctx.fill();
    ctx.globalAlpha = 1;
  }
  // a continuous quadratic-through-midpoints path removes the bumpy JOINTS
  // between segments, but it still passes through every raw point along
  // the way — so if the points themselves are noisy (real hand tracking
  // jitter), the curve still visibly wobbles following that noise. This
  // smooths the point sequence itself first (a 1-2-1 weighted pass,
  // repeated) so the curve has less noise to follow in the first place.
  // Endpoints are left alone so the stroke still starts/ends exactly
  // where the pinch began/ended.
  smoothPoints(points, passes = 3) {
    let pts = points;
    for (let p = 0; p < passes; p++) {
      if (pts.length < 3) break;
      const out = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        out.push({
          x: (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4,
          y: (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4
        });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }
  // builds ONE continuous path for the whole stroke (through running
  // midpoints, with each raw point as a curve control point) so the
  // stroke below has no internal segment joins to look bumpy at
  buildSmoothPath(points) {
    const n = points.length;
    const path = new Path2D();
    if (n === 1) return path;
    path.moveTo(points[0].x, points[0].y);
    if (n === 2) { path.lineTo(points[1].x, points[1].y); return path; }
    for (let i = 1; i < n - 1; i++) {
      const p1 = points[i], p2 = points[i + 1];
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      path.quadraticCurveTo(p1.x, p1.y, mid.x, mid.y);
    }
    path.lineTo(points[n - 1].x, points[n - 1].y);
    return path;
  }
  strokeSmoothPath(ctx, points) {
    const w = this.strokeWidth();
    const path = this.buildSmoothPath(this.smoothPoints(points));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = w;
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = w * 0.35;
    ctx.stroke(path);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.lineWidth = w * 0.62;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }
  beginStroke(x, y, t) {
    this.current = { points: [{ x, y, t }], isDot: true };
    this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    this.paintSegment(this.liveCtx, x, y, x, y, this.strokeWidth() * 0.5);
  }
  extendStroke(x, y, t) {
    if (!this.current) return;
    const pts = this.current.points;
    const last = pts[pts.length - 1];
    const dist = Math.hypot(x - last.x, y - last.y);
    if (dist < 1.5) return;
    this.current.isDot = false;
    pts.push({ x, y, t });
    // fully clear + redraw the live layer as one path every time — cheap
    // for the short point counts a single stroke ever reaches, and it's
    // what keeps every joint smooth instead of just the newest one
    this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    this.strokeSmoothPath(this.liveCtx, pts);
  }
  endStroke() {
    if (!this.current) return;
    // bake the finished live layer onto the permanent canvas once
    this.ctx.drawImage(this.liveCanvas, 0, 0);
    this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    this.strokes.push(this.current);
    const done = this.current;
    this.current = null;
    onStrokeCompleted(done);
  }
  cancelStroke() {
    this.current = null;
    this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
  }
  rebuild() {
    const g = this.ctx;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const s of this.strokes) {
      if (s.isHand) { for (const pr of s.prints) this.paintHandprint(g, pr); continue; }
      if (s.isDot || s.points.length === 1) {
        const p = s.points[0];
        this.paintSegment(g, p.x, p.y, p.x, p.y, this.strokeWidth() * 0.5);
      } else {
        this.strokeSmoothPath(g, s.points);
      }
    }
  }
  // open palm pressed against the glass: clears a hand-shaped print
  // (palm + five fingers) out of the mist, like a real hand on a fogged
  // mirror. Moving the open hand smears it, wiping a wider area.
  paintHandprint(ctx, lm) {
    const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    const fw = Math.max(d(5, 9), d(9, 13), d(13, 17)) * 0.95; // finger width
    const draw = (alpha, scale, blur) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = blur;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // palm
      ctx.lineWidth = fw * scale;
      ctx.beginPath();
      for (const [i, k] of [0, 1, 2, 5, 9, 13, 17].entries()) {
        if (i === 0) ctx.moveTo(lm[k].x, lm[k].y); else ctx.lineTo(lm[k].x, lm[k].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // fingers
      for (const f of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
        ctx.lineWidth = fw * scale * (f[0] === 17 ? 0.85 : 1);
        ctx.beginPath();
        ctx.moveTo(lm[f[0]].x, lm[f[0]].y);
        for (let i = 1; i < f.length; i++) ctx.lineTo(lm[f[i]].x, lm[f[i]].y);
        ctx.stroke();
      }
    };
    draw(0.5, 1.25, fw * 0.5); // soft damp rim
    draw(1, 0.95, 0);          // clear core
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
  beginHand(lm, t) {
    const c = lm[9];
    this.currentHand = { isHand: true, prints: [lm], points: [{ x: c.x, y: c.y, t }] };
    this.paintHandprint(this.ctx, lm);
  }
  extendHand(lm, t) {
    if (!this.currentHand) return this.beginHand(lm, t);
    const h = this.currentHand;
    const last = h.prints[h.prints.length - 1];
    if (Math.hypot(lm[9].x - last[9].x, lm[9].y - last[9].y) < 4) return;
    h.prints.push(lm);
    h.points.push({ x: lm[9].x, y: lm[9].y, t });
    this.paintHandprint(this.ctx, lm);
  }
  endHand() {
    if (!this.currentHand) return;
    const done = this.currentHand;
    this.currentHand = null;
    this.strokes.push(done);
    onStrokeCompleted(done);
  }
  undo() {
    this.strokes.pop();
    this.rebuild();
  }
  clear() {
    this.currentHand = null;
    this.strokes = [];
    this.current = null;
    this.rebuild();
  }
  beginRemist() {
    this.remisting = true;
    this.remistFrom = document.createElement('canvas');
    this.remistFrom.width = this.canvas.width;
    this.remistFrom.height = this.canvas.height;
    this.remistFrom.getContext('2d').drawImage(this.canvas, 0, 0);
  }
  updateRemist(t) {
    const g = this.ctx;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.globalAlpha = Math.max(1 - t * 1.15, 0);
    g.drawImage(this.remistFrom, 0, 0);
    g.globalAlpha = 1;
  }
  finishRemist() {
    this.remisting = false;
    this.strokes = [];
    this.current = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    onDrawingReset();
  }
}
const wipe = new WipeMask();

/* ----------------------------------------------------------------------
   Main render loop — composite base video, frosted fog, wipe holes
------------------------------------------------------------------------*/
const offFog = document.createElement('canvas');
const offFogCtx = offFog.getContext('2d');
let frostPattern = null;

let lastFrameT = performance.now();
function renderFrame(now) {
  requestAnimationFrame(renderFrame);
  const dt = now - lastFrameT;
  lastFrameT = now;
  quality.sample(dt);

  if (video.readyState >= 2 && video.videoWidth) {
    updateCoverRect();
    const W = canvasBase.width, H = canvasBase.height;

    // 1. sharp mirrored base
    ctxBase.save();
    ctxBase.setTransform(1, 0, 0, 1, 0, 0);
    ctxBase.translate(W, 0);
    ctxBase.scale(-1, 1);
    ctxBase.drawImage(video, cover.sx, cover.sy, cover.sw, cover.sh, 0, 0, W, H);
    ctxBase.restore();

    // 2. frosted layer (blurred + desaturated + brightened copy of same frame)
    if (offFog.width !== W || offFog.height !== H) { offFog.width = W; offFog.height = H; }
    offFogCtx.save();
    offFogCtx.setTransform(1, 0, 0, 1, 0, 0);
    offFogCtx.filter = `blur(${quality.blur + 9}px) saturate(0.55) brightness(1.18) contrast(0.82)`;
    offFogCtx.translate(W, 0);
    offFogCtx.scale(-1, 1);
    offFogCtx.drawImage(video, cover.sx, cover.sy, cover.sw, cover.sh, 0, 0, W, H);
    offFogCtx.restore();
    offFogCtx.filter = 'none';
    // milky veil
    offFogCtx.fillStyle = 'rgba(255,255,255,0.3)';
    offFogCtx.fillRect(0, 0, W, H);
    // frosty micro-texture so it reads as condensation, not a white sheet
    if (!frostPattern) frostPattern = offFogCtx.createPattern(grainTile, 'repeat');
    offFogCtx.globalAlpha = 0.35;
    offFogCtx.fillStyle = frostPattern;
    offFogCtx.fillRect(0, 0, W, H);
    offFogCtx.globalAlpha = 1;

    // 3. shape it by the mist density field
    offFogCtx.globalCompositeOperation = 'destination-in';
    offFogCtx.drawImage(mist.canvas, 0, 0);
    offFogCtx.globalCompositeOperation = 'source-over';

    // 4. punch clear holes where the user has wiped (plus whatever
    // stroke is still being drawn right now, on its own live layer)
    offFogCtx.globalCompositeOperation = 'destination-out';
    offFogCtx.drawImage(wipe.canvas, 0, 0);
    offFogCtx.drawImage(wipe.liveCanvas, 0, 0);
    offFogCtx.globalCompositeOperation = 'source-over';

    // 5. composite onto visible fog canvas
    ctxFog.clearRect(0, 0, W, H);
    ctxFog.drawImage(offFog, 0, 0);

    mist.update(now);
  }

  cursorFx.render(now);
  playback.renderGlow(now);
}
requestAnimationFrame(renderFrame);

/* ----------------------------------------------------------------------
   Cursor overlay (fingertip / pointer indicator)
------------------------------------------------------------------------*/
const cursorFx = {
  pos: null, // {x,y}
  pinching: false,
  visible: false,
  render(now) {
    ctxFx.clearRect(0, 0, canvasFx.width, canvasFx.height);
    if (!this.visible || !this.pos) return;
    const r = this.pinching ? 7 : 5;
    ctxFx.beginPath();
    ctxFx.arc(this.pos.x, this.pos.y, r, 0, Math.PI * 2);
    ctxFx.fillStyle = this.pinching ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)';
    ctxFx.shadowColor = 'rgba(255,255,255,0.8)';
    ctxFx.shadowBlur = this.pinching ? 14 : 6;
    ctxFx.fill();
    ctxFx.shadowBlur = 0;
  }
};

/* ----------------------------------------------------------------------
   Application state / UI wiring
------------------------------------------------------------------------*/
const appState = { phase: 'clear' }; // clear | fogged

function setInstruction(text) {
  instructionText.style.opacity = 0;
  setTimeout(() => { instructionText.textContent = text; instructionText.style.opacity = 1; }, 180);
}

function onFogSettled() {
  appState.phase = 'fogged';
  setInstruction('Pinch to draw, or press your open hand on the glass.');
  tapToMistBtn.classList.add('hidden');
  controls.classList.remove('hidden');
  updateControlAvailability();
}

function onDrawingReset() {
  setInstruction('Pinch to draw, or press your open hand on the glass.');
  replayPanel.classList.add('hidden');
  updateControlAvailability();
}

function updateControlAvailability() {
  const has = wipe.strokes.length > 0;
  btnUndo.disabled = !has;
  btnClear.disabled = !has;
  btnPlay.disabled = !has;
}

function onStrokeCompleted() {
  updateControlAvailability();
}

function triggerInstantFog(origin) {
  // manual "tap to mist" fallback — fogs fully right away, no blowing needed
  if (appState.phase !== 'clear') return;
  tapToMistBtn.classList.add('hidden');
  setInstruction('Breath meets the glass...');
  mist.bloom(origin);
}

function fullReset() {
  wipe.clear();
  mist.reset();
  handTrack.pinchActive = false;
  appState.phase = 'clear';
  controls.classList.add('hidden');
  replayPanel.classList.add('hidden');
  setInstruction('Breathe a little magic.');
  updateControlAvailability();
}

tapToMistBtn.addEventListener('click', () => triggerInstantFog(faceTrack.lastMouthPos));
btnUndo.addEventListener('click', () => { wipe.undo(); updateControlAvailability(); });
btnClear.addEventListener('click', fullReset);
btnMist.addEventListener('click', () => {
  replayPanel.classList.add('hidden');
  mist.unmist(faceTrack.lastMouthPos);
});
btnReplayMist.addEventListener('click', () => {
  replayPanel.classList.add('hidden');
  mist.unmist(faceTrack.lastMouthPos);
});
btnReplayKeep.addEventListener('click', () => {
  replayPanel.classList.add('hidden');
  setInstruction('Pinch to draw, or press your open hand on the glass.');
});
btnPlay.addEventListener('click', () => playback.play());
btnReplayPlay.addEventListener('click', () => playback.play());

/* ----------------------------------------------------------------------
   Pointer (mouse / touch) drawing fallback
------------------------------------------------------------------------*/
let pointerDrawing = false;
function stagePointFromEvent(e) {
  const rect = stage.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * canvasFog.width;
  const y = (e.clientY - rect.top) / rect.height * canvasFog.height;
  return { x, y };
}
canvasFx.style.pointerEvents = 'none';
stage.addEventListener('pointerdown', (e) => {
  if (appState.phase !== 'fogged') return;
  if (!e.isPrimary) return;
  if (e.target !== stage && e.target !== canvasBase && e.target !== canvasFog) return;
  pointerDrawing = true;
  const p = stagePointFromEvent(e);
  wipe.beginStroke(p.x, p.y, performance.now());
  cursorFx.visible = true; cursorFx.pinching = true; cursorFx.pos = p;
});
stage.addEventListener('pointermove', (e) => {
  if (!pointerDrawing || !e.isPrimary) return;
  const p = stagePointFromEvent(e);
  wipe.extendStroke(p.x, p.y, performance.now());
  cursorFx.pos = p;
});
function endPointerDraw() {
  if (!pointerDrawing) return;
  pointerDrawing = false;
  wipe.endStroke();
  cursorFx.visible = false; cursorFx.pinching = false;
}
stage.addEventListener('pointerup', endPointerDraw);
stage.addEventListener('pointerleave', endPointerDraw);
stage.addEventListener('pointercancel', endPointerDraw);

/* ----------------------------------------------------------------------
   MediaPipe Tasks Vision — shared loader for hand + face landmarkers
------------------------------------------------------------------------*/
let visionPromise = null;
function loadVision() {
  if (!visionPromise) {
    visionPromise = import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs')
      .then(async (vision) => {
        const fileset = await vision.FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        );
        return { vision, fileset };
      });
  }
  return visionPromise;
}

/* ----------------------------------------------------------------------
   Hand tracking — drives the wipe-drawing cursor once the glass is fogged
------------------------------------------------------------------------*/
const handTrack = {
  landmarker: null,
  ready: false,
  lastSeen: 0,
  pinchActive: false,
  filterX: new OneEuro(),
  filterY: new OneEuro(),
  lostTimeout: 380,
  smoothedRatio: null,
  belowCount: 0,
  aboveCount: 0,

  async init() {
    try {
      const { vision, fileset } = await loadVision();
      this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 2
      });
      this.ready = true;
    } catch (err) {
      console.warn('Hand tracking unavailable, falling back to touch/mouse only.', err);
      this.ready = false;
    }
  },

  detect(now) {
    if (!this.ready || !video.videoWidth) return;
    let result;
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch (e) { return; }
    const lm = result && result.landmarks && result.landmarks[0];
    if (!lm) {
      if (now - this.lastSeen > this.lostTimeout) this.handleLost();
      return;
    }
    this.lastSeen = now;

    // open palm (all 5 fingers extended) → handprint wipe, takes priority
    if (!this.pinchActive && this.detectPalm(result.landmarks, now)) return;

    const thumb = lm[4], index = lm[8], wrist = lm[0], midMcp = lm[9];
    // 3D distance (x,y,z) instead of flat 2D — a purely 2D ratio spikes
    // falsely whenever the hand rotates while moving to draw (perspective
    // foreshortening shrinks the 2D wrist→knuckle reference even though
    // the fingers never touched), which is exactly what made any hand
    // motion register as a "pinch". Including z is far more stable.
    const handScale = Math.hypot(
      (wrist.x - midMcp.x) * cover.vw,
      (wrist.y - midMcp.y) * cover.vh,
      ((wrist.z || 0) - (midMcp.z || 0)) * cover.vw
    ) || 1;
    const pinchDist = Math.hypot(
      (thumb.x - index.x) * cover.vw,
      (thumb.y - index.y) * cover.vh,
      ((thumb.z || 0) - (index.z || 0)) * cover.vw
    );
    const rawRatio = pinchDist / handScale;
    // smooth the ratio itself before thresholding, on top of the frame-count
    // debounce below — the combination is what kills single-frame blips
    this.smoothedRatio = this.smoothedRatio == null ? rawRatio : this.smoothedRatio * 0.6 + rawRatio * 0.4;
    const ratio = this.smoothedRatio;

    // use the midpoint between thumb and index, not the index fingertip
    // alone — averaging two independently-noisy points is meaningfully
    // steadier, and it's the more natural "pinch point" anyway
    const midNormX = (thumb.x + index.x) / 2;
    const midNormY = (thumb.y + index.y) / 2;
    const raw = videoNormToCanvas(midNormX, midNormY);
    const x = this.filterX.filter(raw.x, now);
    const y = this.filterY.filter(raw.y, now);

    // strict thumb-to-index pinch only: a real pinch brings the fingertips
    // almost together, well inside a third of the hand's own scale — and
    // it must hold for several consecutive frames, not just one dip
    const startThresh = 0.32, endThresh = 0.55;
    const framesToConfirm = 3;
    if (ratio < startThresh) { this.belowCount++; this.aboveCount = 0; }
    else if (ratio > endThresh) { this.aboveCount++; this.belowCount = 0; }
    else { this.belowCount = 0; this.aboveCount = 0; }

    if (!this.pinchActive && this.belowCount >= framesToConfirm) {
      this.pinchActive = true;
      cursorFx.pinching = true;
      cursorFx.visible = true;
      cursorFx.pos = { x, y };
      if (appState.phase === 'fogged') wipe.beginStroke(x, y, now);
    } else if (this.pinchActive && this.aboveCount >= 2) {
      this.pinchActive = false;
      cursorFx.pinching = false;
      cursorFx.visible = false;
      if (appState.phase === 'fogged') wipe.endStroke();
    } else if (this.pinchActive) {
      // only track/draw once an actual pinch is confirmed — don't follow
      // the hand around just because it's visible
      cursorFx.pos = { x, y };
      if (appState.phase === 'fogged') wipe.extendStroke(x, y, now);
    }
  },

  palmFrames: 0,
  palmActive: false,
  isOpenPalm(lm) {
    const w = lm[0];
    const dist = (a) => Math.hypot(a.x - w.x, a.y - w.y, (a.z || 0) - (w.z || 0));
    // each finger tip must be clearly further from the wrist than its middle joint
    for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
      if (dist(lm[tip]) < dist(lm[pip]) * 1.12) return false;
    }
    // thumb spread away from the index knuckle
    const t = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y);
    const ref = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1;
    return t / ref > 0.45;
  },
  detectPalm(hands, now) {
    const open = hands.filter((h) => this.isOpenPalm(h));
    if (open.length) this.palmFrames++; else this.palmFrames = 0;
    if (this.palmFrames >= 3 && appState.phase === 'fogged') {
      const lm = open[0].map((p) => videoNormToCanvas(p.x, p.y));
      this.palmActive = true;
      wipe.extendHand(lm, now);
      for (let i = 1; i < open.length; i++) {
        wipe.paintHandprint(wipe.ctx, open[i].map((p) => videoNormToCanvas(p.x, p.y)));
      }
      cursorFx.visible = false;
      return true;
    }
    if (!open.length && this.palmActive) {
      this.palmActive = false;
      wipe.endHand();
    }
    return open.length > 0;
  },

  handleLost() {
    this.palmFrames = 0;
    if (this.palmActive) { this.palmActive = false; wipe.endHand(); }
    if (this.pinchActive) {
      this.pinchActive = false;
      this.belowCount = 0;
      this.aboveCount = 0;
      this.smoothedRatio = null;
      // commit whatever was drawn so far instead of silently discarding it —
      // a brief tracking hiccup mid-stroke shouldn't erase the user's line
      wipe.endStroke();
    }
    cursorFx.visible = false;
    cursorFx.pinching = false;
    this.filterX.reset();
    this.filterY.reset();
  }
};

function handLoop() {
  requestAnimationFrame(handLoop);
  // only worth running once there's mist to wipe through
  if (appState.phase === 'fogged') handTrack.detect(performance.now());
}

/* ----------------------------------------------------------------------
   Face tracking — reads a continuous "mouth openness" score every frame
   (the jawOpen blendshape only — an open mouth, nothing to do with sound
   or pursed lips). Plain mouth-open alone would also fire briefly while
   talking, but since this only *feeds* a continuous accumulator (see
   breathDriver below) rather than firing once, a brief moment barely
   moves the needle — only a mouth held open for a while builds real
   density. Also tracks where the mouth is on screen so mist grows there.
------------------------------------------------------------------------*/
const faceTrack = {
  landmarker: null,
  ready: false,
  faceVisible: false,
  openScore: 0,
  lastMouthPos: null,

  async init() {
    try {
      const { vision, fileset } = await loadVision();
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true
      });
      this.ready = true;
    } catch (err) {
      console.warn('Face tracking unavailable — falling back to tap to mist.', err);
      this.ready = false;
    }
  },

  detect(now) {
    if (!video.videoWidth) return;
    let result;
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch (e) { return; }
    const lm = result && result.faceLandmarks && result.faceLandmarks[0];
    if (!lm) { this.faceVisible = false; this.openScore = 0; return; }
    this.faceVisible = true;

    // mouth centroid (inner lip midpoints + corners), mapped to canvas space
    const pts = [lm[13], lm[14], lm[61], lm[291]];
    const nx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const ny = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    this.lastMouthPos = videoNormToCanvas(nx, ny);

    const categories = result.faceBlendshapes && result.faceBlendshapes[0] && result.faceBlendshapes[0].categories;
    if (!categories) { this.openScore = 0; return; }
    const category = categories.find((c) => c.categoryName === 'jawOpen');
    this.openScore = category ? category.score : 0;
  }
};

/* ----------------------------------------------------------------------
   Breath driver — turns the open-mouth score into mist growth. Purely
   visual now (no microphone): the longer the mouth stays open past the
   deadzone, the denser the mist gets; close it and growth stops, but the
   mist stays on the glass instead of fading. Runs for as
   long as the camera is on — not just before the glass fogs — so keeping
   your mouth open after drawing has started keeps widening the mist.
------------------------------------------------------------------------*/
const breathDriver = {
  update(dt) {
    const faceScore = faceTrack.faceVisible ? faceTrack.openScore : 0;
    // floor sits above a resting/neutral or talking mouth, so a held-open
    // mouth is what actually builds density, not brief incidental movement
    const intensity = Math.max(0, faceScore - 0.35) / 0.4;

    if (intensity > 0.06) {
      const origin = faceTrack.lastMouthPos || mist.currentOrigin
        || { x: canvasFog.width / 2, y: canvasFog.height * 0.55 };
      mist.grow(origin, intensity, dt);
    }
    // mouth closed: the mist stays put (no decay) until wiped or cleared
  }
};

let lastBreathT = null;
let breathFrameCounter = 0;
let breathAccumDt = 0;
function breathLoop(now) {
  requestAnimationFrame(breathLoop);
  const dt = lastBreathT ? Math.min((now - lastBreathT) / 1000, 0.1) : 0;
  lastBreathT = now;
  breathAccumDt += dt;
  breathFrameCounter++;
  // once already fogged, hand tracking (drawing) is the priority — running
  // two heavy CV models every frame risks starving the hand-tracking loop
  // of frame time, which was causing pinch strokes to lose tracking mid-
  // draw. Check breath at a much lower rate here; the growth/decay it
  // drives is a slow accumulator anyway, so it doesn't need high-frequency
  // sampling — but the skipped frames' time must still count, or both
  // growth and decay would silently run several times slower than tuned.
  if (mist.state === 'fogged' && breathFrameCounter % 6 !== 0) return;
  if (faceTrack.ready) faceTrack.detect(now);
  breathDriver.update(breathAccumDt);
  breathAccumDt = 0;
}

/* ----------------------------------------------------------------------
   Music — draw strokes into a pentatonic melody with Tone.js
------------------------------------------------------------------------*/
const PENTATONIC = ['C3','D3','E3','G3','A3','C4','D4','E4','G4','A4','C5','D5','E5','G5','A5','C6'];

const playback = {
  synth: null, glowLayer: null, initialized: false, events: [], startPerf: 0, playing: false,

  ensureAudio() {
    if (this.initialized) return;
    const chorus = new Tone.Chorus(2.2, 1.4, 0.25).start();
    const filter = new Tone.Filter(2600, 'lowpass');
    const reverb = new Tone.Reverb({ decay: 2.4, wet: 0.32 });
    const vol = new Tone.Volume(-6);
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.015, decay: 0.35, sustain: 0.12, release: 1.1 }
    });
    this.synth.chain(chorus, filter, reverb, vol, Tone.Destination);
    this.initialized = true;
  },

  resample(points, spacingPx) {
    if (points.length <= 1) return points.slice();
    const out = [points[0]];
    let prev = points[0];
    let dist = 0;
    for (let i = 1; i < points.length; i++) {
      const curr = points[i];
      let segLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
      let segStart = prev;
      while (dist + segLen >= spacingPx) {
        const remain = spacingPx - dist;
        const t = segLen > 0 ? remain / segLen : 0;
        const nx = segStart.x + (curr.x - segStart.x) * t;
        const ny = segStart.y + (curr.y - segStart.y) * t;
        out.push({ x: nx, y: ny });
        segStart = { x: nx, y: ny };
        segLen = Math.hypot(curr.x - segStart.x, curr.y - segStart.y);
        dist = 0;
      }
      dist += segLen;
      prev = curr;
    }
    out.push(points[points.length - 1]);
    return out;
  },
  subsampleEven(points, maxCount) {
    if (points.length <= maxCount) return points;
    const out = [];
    const step = (points.length - 1) / (maxCount - 1);
    for (let i = 0; i < maxCount; i++) out.push(points[Math.round(i * step)]);
    return out;
  },

  buildSequence() {
    const H = canvasFog.height;
    const spacing = Math.min(canvasFog.width, canvasFog.height) * 0.09;
    const noteDur = 0.16;
    const strokeGap = 0.14;
    const events = [];
    let t = 0;
    for (const stroke of wipe.strokes) {
      let pts = (stroke.isDot || stroke.points.length === 1)
        ? [stroke.points[0]]
        : this.resample(stroke.points, spacing);
      pts = this.subsampleEven(pts, 14);
      for (const p of pts) {
        const pitchT = 1 - Math.min(Math.max(p.y / H, 0), 1);
        const idx = Math.round(pitchT * (PENTATONIC.length - 1));
        events.push({ time: t, dur: noteDur, note: PENTATONIC[idx], x: p.x, y: p.y });
        t += noteDur;
      }
      t += strokeGap;
    }
    return events;
  },

  async play() {
    if (wipe.strokes.length === 0) return;
    this.ensureAudio();
    await Tone.start();
    this.events = this.buildSequence();
    this.startPerf = performance.now();
    this.playing = true;
    replayPanel.classList.add('hidden');
    for (const ev of this.events) {
      this.synth.triggerAttackRelease(ev.note, ev.dur * 1.4, Tone.now() + ev.time);
    }
    const totalMs = (this.events.length ? this.events[this.events.length - 1].time + 1.2 : 0.5) * 1000;
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => {
      this.playing = false;
      instructionText.textContent = '';
      replayPanel.classList.remove('hidden');
    }, totalMs);
  },

  renderGlow(now) {
    if (!this.playing || this.events.length === 0) return;
    const elapsed = (now - this.startPerf) / 1000;
    // find current / next event to interpolate a traveling point
    let cur = null, next = null;
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].time <= elapsed) cur = this.events[i];
      if (this.events[i].time > elapsed) { next = this.events[i]; break; }
    }
    if (!cur) return;
    let x = cur.x, y = cur.y, pulse = 1;
    if (next) {
      const span = next.time - cur.time || 0.001;
      const localT = Math.min(Math.max((elapsed - cur.time) / span, 0), 1);
      x = cur.x + (next.x - cur.x) * localT;
      y = cur.y + (next.y - cur.y) * localT;
    }
    const sinceNote = elapsed - cur.time;
    pulse = Math.max(0, 1 - sinceNote / 0.3);
    const r = 10 + pulse * 10;
    const grad = ctxFx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,205,140,${0.55 + pulse * 0.35})`);
    grad.addColorStop(1, 'rgba(255,205,140,0)');
    ctxFx.fillStyle = grad;
    ctxFx.beginPath();
    ctxFx.arc(x, y, r, 0, Math.PI * 2);
    ctxFx.fill();
  }
};

/* ----------------------------------------------------------------------
   Start flow — request the camera only after a deliberate action
------------------------------------------------------------------------*/
async function startMirror() {
  btnStart.disabled = true;
  startStatus.textContent = 'Waking the glass…';
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
  } catch (err) {
    startScreen.classList.remove('hidden');
    startStatus.textContent = 'Camera access is needed for the mirror to work. Please allow it and try again.';
    btnStart.disabled = false;
    return;
  }

  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });

  resize();
  startScreen.classList.add('hidden');

  handTrack.init().then(() => { if (handTrack.ready) handLoop(); });
  faceTrack.init(); // fire-and-forget; breathLoop checks faceTrack.ready itself
  requestAnimationFrame(breathLoop);
}
// start straight away; the button only shows if the camera was refused
btnStart.addEventListener('click', startMirror);
startMirror();

resize();
