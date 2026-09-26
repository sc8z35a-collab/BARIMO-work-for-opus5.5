// Input + camera controllers for the region scene.
//  PointerInput      — unified mouse/touch/pen gestures with pointer capture, tap / double-tap detection,
//                      pinch (scale + rotate + centroid pan) and two-finger tilt classification.
//  MapController     — Google-Earth-style map camera: grab-pan, zoom-to-cursor, rotate, tilt, inertia,
//                      terrain collision, curvature-aware target, animated flyTo.
//  FirstPerson       — walk (gravity, slope, shoreline & boundary limits, head-bob) and drone flight,
//                      joystick/keyboard/look input and autopilot navigation towards a destination.
import * as THREE from 'three';
import { clamp, lerp, damp, angDiff, easeInOut, curvatureDrop, bearingXZ } from './geo.js';

const TAP_PX = 9, TAP_MS = 320, DBL_MS = 320;

export class PointerInput {
  constructor(el, h = {}) {
    this.el = el; this.h = h; this.enabled = false;
    this.pts = new Map(); this.lastTap = null; this.gesture = null; this.tapCand = null;
    const on = (t, f, o) => el.addEventListener(t, f, o);
    on('pointerdown', (e) => this._down(e));
    on('pointermove', (e) => this._move(e));
    on('pointerup', (e) => this._up(e, false));
    on('pointercancel', (e) => this._up(e, true));
    on('lostpointercapture', (e) => { if (this.pts.has(e.pointerId)) this._up(e, true); });
    on('wheel', (e) => { if (!this.enabled) return; e.preventDefault(); const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY; h.wheel?.(clamp(d, -600, 600), e.clientX, e.clientY, e); }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
  }
  setEnabled(v) { this.enabled = v; if (!v) { this.pts.clear(); this.gesture = null; this.tapCand = null; } }

  _down(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button > 2) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, btn: e.button, mouse: e.pointerType === 'mouse', mods: e.ctrlKey || e.shiftKey || e.metaKey });
    if (this.pts.size === 1) {
      this.tapCand = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.gesture = null;
      this.h.start?.();
    } else {
      this.tapCand = null;
      this._pinchBase();
    }
  }
  _pinchBase() {
    const [a, b] = [...this.pts.values()];
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, mode: null, acc: 0, ay: a.y, by: b.y, ax: a.x, bx: b.x };
  }
  _move(e) {
    const p = this.pts.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.tapCand && Math.hypot(e.clientX - this.tapCand.x, e.clientY - this.tapCand.y) > TAP_PX) this.tapCand = null;
    if (this.pts.size === 1) {
      if (this.tapCand) return; // not a drag yet
      const rot = p.mouse && (p.btn === 2 || p.btn === 1 || p.mods);
      if (rot) this.h.rotate?.(dx, dy); else this.h.drag?.(dx, dy, e.clientX, e.clientY);
      return;
    }
    if (this.pts.size >= 2 && this.pinch) {
      const [a, b] = [...this.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, P = this.pinch;
      if (!P.mode) { // classify the gesture once it has moved enough
        const day = a.y - P.ay, dby = b.y - P.by, dax = a.x - P.ax, dbx = b.x - P.bx;
        const moved = Math.max(Math.abs(day), Math.abs(dby), Math.abs(dax), Math.abs(dbx));
        if (moved > 10) {
          const vertical = Math.sign(day) === Math.sign(dby) && Math.abs(day) > Math.abs(dax) * 1.6 && Math.abs(dby) > Math.abs(dbx) * 1.6;
          const flatPair = Math.abs(a.y - b.y) < Math.abs(a.x - b.x) * 0.9;
          P.mode = vertical && flatPair && Math.abs(d / P.d - 1) < 0.12 ? 'tilt' : 'pinch';
        }
      }
      if (P.mode === 'tilt') this.h.tilt?.(cy - P.cy);
      else if (P.mode === 'pinch') this.h.pinch?.({ scale: P.d > 0 ? d / P.d : 1, rotate: angDiff(P.ang, ang), dx: cx - P.cx, dy: cy - P.cy, cx, cy });
      P.d = d; P.ang = ang; P.cx = cx; P.cy = cy;
    }
  }
  _up(e, cancel) {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    this.pts.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pts.size === 1) { // pinch ended with one finger left → continue as a fresh single drag (no jump)
      this.pinch = null; this.tapCand = null;
      return;
    }
    if (this.pts.size >= 2) { this._pinchBase(); return; }
    this.pinch = null;
    const now = performance.now();
    if (!cancel && this.tapCand && now - this.tapCand.t < TAP_MS) {
      const t = this.tapCand;
      if (this.lastTap && now - this.lastTap.t < DBL_MS && Math.hypot(t.x - this.lastTap.x, t.y - this.lastTap.y) < 34) {
        this.lastTap = null; this.h.doubleTap?.(t.x, t.y);
      } else {
        this.lastTap = { x: t.x, y: t.y, t: now };
        this.h.tap?.(t.x, t.y);
      }
    }
    this.tapCand = null;
    this.h.end?.();
  }
}

// ======================================================================= Map camera
export class MapController {
  constructor(camera, engine, frame) {
    this.cam = camera; this.E = engine; this.F = frame;
    this.target = new THREE.Vector3(); this.dist = 20000; this.yaw = 0; this.tilt = 0.9;
    this.vel = new THREE.Vector2(); this.anim = null; this.userActive = false;
    this.minDist = 70; this.maxDist = frame.size * 1.25;
    this.onUser = null;
    this._ray = new THREE.Raycaster(); this._v = new THREE.Vector3(); this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.groundY = 0;
  }
  maxTilt(d = this.dist) { return lerp(1.48, 1.0, clamp((d - 15000) / 220000, 0, 1)); }

  /** ground point under screen pixel (horizontal plane through the target) */
  groundAt(sx, sy) {
    const r = this.cam.domRect || { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const ndc = new THREE.Vector2(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(ndc, this.cam);
    this._plane.constant = -this.target.y;
    const hit = this._ray.ray.intersectPlane(this._plane, new THREE.Vector3());
    if (!hit) return null;
    if (hit.distanceTo(this.cam.position) > this.dist * 8) return null; // grazing ray near the horizon
    return hit;
  }

  // ---- gestures
  drag(dx, dy, sx, sy) {
    this.cancelAnim(); this._userTouched();
    const a = this.groundAt(sx - dx, sy - dy), b = this.groundAt(sx, sy);
    let mx, mz;
    if (a && b) { mx = a.x - b.x; mz = a.z - b.z; }
    else { const k = this._mpp(); const c = Math.cos(this.yaw), s = Math.sin(this.yaw); mx = (-dx * c + dy * s) * k; mz = (-dx * s - dy * c) * k; }
    const lim = this.dist * 0.6 + 50;
    const l = Math.hypot(mx, mz); if (l > lim) { mx *= lim / l; mz *= lim / l; }
    this.target.x += mx; this.target.z += mz;
    const dt = Math.max(1 / 120, (performance.now() - (this._lt || 0)) / 1000); this._lt = performance.now();
    this.vel.set(lerp(this.vel.x, mx / dt, 0.5), lerp(this.vel.y, mz / dt, 0.5));
    this._clampTarget();
  }
  rotate(dx, dy) { this.cancelAnim(); this._userTouched(); this.yaw += dx * 0.006; this.tilt = clamp(this.tilt - dy * 0.005, 0, this.maxTilt()); }
  tiltBy(dy) { this.cancelAnim(); this._userTouched(); this.tilt = clamp(this.tilt - dy * 0.006, 0, this.maxTilt()); }
  pinch({ scale, rotate, dx, dy, cx, cy }) {
    this.cancelAnim(); this._userTouched();
    if (dx || dy) this.drag(dx, dy, cx, cy);
    this.zoomAt(1 / Math.max(0.2, scale), cx, cy);
    if (Math.abs(rotate) > 0.0005) this.yaw -= rotate;
  }
  wheel(d, sx, sy) { this.cancelAnim(); this._userTouched(); this.zoomAt(Math.exp(d * 0.0016), sx, sy); }
  zoomAt(f, sx, sy) {
    const nd = clamp(this.dist * f, this.minDist, this.maxDist); f = nd / this.dist;
    const p = sx != null ? this.groundAt(sx, sy) : null;
    if (p && f < 1) { this.target.x += (p.x - this.target.x) * (1 - f); this.target.z += (p.z - this.target.z) * (1 - f); }
    else if (p && f > 1) { this.target.x -= (p.x - this.target.x) * (f - 1) * 0.35; this.target.z -= (p.z - this.target.z) * (f - 1) * 0.35; }
    this.dist = nd;
    this.tilt = Math.min(this.tilt, this.maxTilt());
    this._clampTarget();
  }
  end() { this._lt = 0; }
  _mpp() { return (2 * this.dist * Math.tan((this.cam.fov * Math.PI) / 360)) / (this.cam.domRect?.height || innerHeight); }
  _userTouched() { this.userActive = true; this.onUser?.(); }
  _clampTarget() { const m = this.F.half * 0.985; this.target.x = clamp(this.target.x, -m, m); this.target.z = clamp(this.target.z, -m, m); }

  cancelAnim() { if (this.anim) { const cb = this.anim.cancel; this.anim = null; cb?.(); } }

  /** animated flight to a ground point */
  flyTo(x, z, { dist = this.dist, tilt = this.tilt, yaw = this.yaw, dur, onDone, onCancel } = {}) {
    this.vel.set(0, 0);
    const from = { x: this.target.x, z: this.target.z, dist: this.dist, tilt: this.tilt, yaw: this.yaw };
    const travel = Math.hypot(x - from.x, z - from.z);
    const d = dur ?? clamp(1.2 + travel / 25000, 1.4, 4.5);
    const hop = Math.max(0, Math.min(travel * 0.7, this.maxDist) - (from.dist + dist) / 2);
    this.anim = { t: 0, d, from, to: { x, z, dist: clamp(dist, this.minDist, this.maxDist), tilt: Math.min(tilt, this.maxTilt(dist)), yaw: from.yaw + angDiff(from.yaw, yaw) }, hop, done: onDone, cancel: onCancel };
  }

  update(dt) {
    const A = this.anim;
    if (A) {
      A.t += dt; const k = easeInOut(Math.min(1, A.t / A.d));
      this.target.x = lerp(A.from.x, A.to.x, k); this.target.z = lerp(A.from.z, A.to.z, k);
      this.dist = lerp(A.from.dist, A.to.dist, k) + A.hop * Math.sin(Math.PI * k);
      this.tilt = lerp(A.from.tilt, A.to.tilt, k); this.yaw = lerp(A.from.yaw, A.to.yaw, k);
      if (A.t >= A.d) { this.anim = null; A.done?.(); }
    } else if (this.vel.lengthSq() > 1e-4 && this._lt === 0) { // inertia after release
      this.target.x += this.vel.x * dt; this.target.z += this.vel.y * dt;
      this.vel.multiplyScalar(Math.exp(-5 * dt));
      if (this.vel.length() < this.dist * 0.01) this.vel.set(0, 0);
      this._clampTarget();
    } else if (this._lt !== 0) this.vel.multiplyScalar(Math.exp(-12 * dt));

    // target follows the terrain (smoothly) — curvature correction applied below
    const gh = this.E.heightAt(this.target.x, this.target.z);
    this.groundY = lerp(this.groundY, gh, A ? 1 : damp(8, dt));
    this._apply();
  }
  _apply() {
    const s = Math.sin(this.tilt), c = Math.cos(this.tilt), hd = this.dist * s;
    this.target.y = this.groundY - curvatureDrop(hd);
    for (let i = 0; i < 10; i++) {
      const cx = this.target.x - Math.sin(this.yaw) * hd, cz = this.target.z + Math.cos(this.yaw) * hd;
      const cy = this.target.y + this.dist * Math.cos(this.tilt);
      const clear = Math.max(12, this.dist * 0.03);
      const ground = Math.max(this.E.groundAt(cx, cz), this.E.heightAt(lerp(cx, this.target.x, 0.25), lerp(cz, this.target.z, 0.25)) - curvatureDrop(hd * 0.25));
      if (cy >= ground + clear || this.tilt < 0.02) { this.cam.position.set(cx, Math.max(cy, ground + clear), cz); break; }
      this.tilt *= 0.9;
      const s2 = Math.sin(this.tilt); this.target.y = this.groundY - curvatureDrop(this.dist * s2);
    }
    void c;
    this.cam.rotation.set(-(Math.PI / 2 - this.tilt), -this.yaw, 0, 'YXZ');
    this.cam.updateMatrixWorld();
  }
  /** heading in radians (0 = north, clockwise) */
  get heading() { return ((this.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); }
  altitude() { return this.cam.position.y - this.E.heightAt(this.cam.position.x, this.cam.position.z); }
}

// ======================================================================= First person
export const WALK_SPEEDS = [{ key: 'walk', label: '徒歩', v: 1.4 }, { key: 'jog', label: 'ジョグ', v: 4 }, { key: 'car', label: '4WD', v: 17 }];
export const FLY_SPEEDS = [{ key: 'slow', label: 'ゆっくり', k: 0.45 }, { key: 'std', label: '標準', k: 1 }, { key: 'fast', label: '高速', k: 3 }];
export const EYE = 1.65;

export class FirstPerson {
  constructor(camera, engine, frame, { hasSea = false } = {}) {
    this.cam = camera; this.E = engine; this.F = frame; this.hasSea = hasSea;
    this.pos = new THREE.Vector3(); this.yaw = 0; this.pitch = 0; this.mode = 'walk'; this.speedIdx = 0;
    this.vel = new THREE.Vector3(); this.vy = 0; this.bob = 0; this.joy = { x: 0, y: 0 }; this.lift = 0;
    this.keys = new Set(); this.nav = null; this.onEvent = null; this.onArrive = null;
    this.lookVel = { x: 0, y: 0 };
    this._blockT = 0;
  }
  place(x, z, yaw = this.yaw) {
    this.pos.set(x, this.E.groundAt(x, z) + EYE, z); this.yaw = yaw; this.pitch = -0.04; this.vel.set(0, 0, 0); this.vy = 0;
  }
  look(dx, dy) { this.yaw += dx * 0.0042; this.pitch = clamp(this.pitch - dy * 0.0042, -1.45, 1.45); if (Math.abs(dx) + Math.abs(dy) > 2) this.cancelNav(true); }
  setMode(m) {
    if (m === this.mode) return;
    this.mode = m; this.speedIdx = m === 'fly' ? 1 : 0; this.vy = 0;
    if (m === 'fly') this.pos.y += 25;
  }
  speeds() { return this.mode === 'fly' ? FLY_SPEEDS : WALK_SPEEDS; }
  groundAt(x, z) { return this.E.groundAt(x, z); }
  agl() { return this.pos.y - this.groundAt(this.pos.x, this.pos.z); }
  setNav(target) { this.nav = target ? { ...target, arrived: false } : null; }
  cancelNav(soft) { if (this.nav && !this.nav.arrived) { if (soft && this.nav.auto) { this.nav.auto = false; this.onEvent?.('nav-manual'); } } }

  update(dt) {
    const K = this.keys, j = this.joy;
    let ix = j.x + (K.has('KeyD') || K.has('ArrowRight') ? 1 : 0) - (K.has('KeyA') || K.has('ArrowLeft') ? 1 : 0);
    let iy = j.y + (K.has('KeyS') || K.has('ArrowDown') ? 1 : 0) - (K.has('KeyW') || K.has('ArrowUp') ? 1 : 0);
    let iv = this.lift + (K.has('Space') || K.has('KeyE') ? 1 : 0) - (K.has('ShiftLeft') || K.has('KeyQ') || K.has('ShiftRight') ? 1 : 0);
    const il = Math.hypot(ix, iy); if (il > 1) { ix /= il; iy /= il; }
    if (il > 0.05 && this.nav?.auto) { this.nav.auto = false; this.onEvent?.('nav-manual'); }

    // autopilot: steer towards the destination and move forward
    const N = this.nav;
    if (N && N.auto && !N.arrived) {
      const dx = N.x - this.pos.x, dz = N.z - this.pos.z, d = Math.hypot(dx, dz);
      const want = bearingXZ(dx, dz);
      this.yaw += angDiff(this.yaw, want) * damp(2.2, dt);
      this.pitch = lerp(this.pitch, this.mode === 'fly' ? -0.12 : -0.03, damp(1.5, dt));
      iy = -Math.min(1, d / (this.mode === 'fly' ? 400 : 25) + 0.15);
      if (this.mode === 'fly') { // climb to cruise altitude, descend near the destination
        const agl = this.agl(), cruise = clamp(d * 0.08, 60, 450);
        iv = clamp((cruise - agl) / 60, -1, 1);
      }
    }
    if (N && !N.arrived && Math.hypot(N.x - this.pos.x, N.z - this.pos.z) < (this.mode === 'fly' ? 60 : 18)) {
      N.arrived = true; N.auto = false; this.onArrive?.(N);
    }

    const agl = this.agl();
    const S = this.speeds()[this.speedIdx];
    const speed = this.mode === 'fly' ? clamp(Math.max(agl, 20) * 0.5, 10, 600) * S.k : S.v;
    const fw = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw)), rt = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const want = fw.multiplyScalar(-iy * speed).add(rt.multiplyScalar(ix * speed));
    this.vel.x = lerp(this.vel.x, want.x, damp(this.mode === 'fly' ? 2.5 : 7, dt));
    this.vel.z = lerp(this.vel.z, want.z, damp(this.mode === 'fly' ? 2.5 : 7, dt));

    let nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const g0 = this.groundAt(this.pos.x, this.pos.z);
    // boundary of the explorable area
    const m = this.F.half - 40;
    if (Math.abs(nx) > m || Math.abs(nz) > m) { nx = clamp(nx, -m, m); nz = clamp(nz, -m, m); this._blocked('edge'); }
    let g1 = this.groundAt(nx, nz);
    if (this.mode === 'walk') {
      if (this.hasSea && g1 < 0.3 && g0 >= 0.3) { nx = this.pos.x; nz = this.pos.z; g1 = g0; this.vel.set(0, 0, 0); this._blocked('sea'); }
      // steep uphill slows you down — slope measured over a fixed 3 m baseline (per-frame steps of a few cm
      // amplify DEM interpolation noise and used to freeze the walker on ordinary hillsides)
      const mv = Math.hypot(nx - this.pos.x, nz - this.pos.z);
      if (mv > 1e-4) {
        const ux = (nx - this.pos.x) / mv, uz = (nz - this.pos.z) / mv;
        const slope = (this.groundAt(this.pos.x + ux * 3, this.pos.z + uz * 3) - g0) / 3;
        this.slope = slope;
        if (slope > 0.6) { const f = clamp(1.5 - slope, 0.3, 1); nx = this.pos.x + (nx - this.pos.x) * f; nz = this.pos.z + (nz - this.pos.z) * f; g1 = this.groundAt(nx, nz); }
      }
      // never walk into terrain that rises above eye level within the next step (steep DEM walls between
      // coarse samples): slide back instead of letting the camera end up inside the hillside
      if (g1 + 0.2 > this.pos.y + 1.2 && g1 - g0 > 1.2) { nx = this.pos.x; nz = this.pos.z; g1 = g0; }
      this.pos.x = nx; this.pos.z = nz;
      const floor = g1 + EYE;
      if (this.pos.y > floor + 0.05) { this.vy -= 9.81 * dt; this.pos.y += this.vy * dt; if (this.pos.y < floor) { this.pos.y = floor; this.vy = 0; } }
      else { this.pos.y = Math.max(floor, lerp(this.pos.y, floor, damp(18, dt))); this.vy = 0; }
      const moving = Math.hypot(this.vel.x, this.vel.z);
      this.bob += dt * clamp(moving, 0, 5) * 2.1;
    } else {
      this.pos.x = nx; this.pos.z = nz;
      this.vy = lerp(this.vy, iv * clamp(Math.max(agl, 20) * 0.45, 6, 300) * S.k, damp(3, dt));
      this.pos.y += this.vy * dt;
      const floor = g1 + 3;
      if (this.pos.y < floor) { this.pos.y = lerp(this.pos.y, floor, damp(12, dt)); if (this.pos.y < g1 + 1) this.pos.y = g1 + 1; this.vy = Math.max(0, this.vy); }
      this.pos.y = Math.min(this.pos.y, 12000);
    }
    const bobY = this.mode === 'walk' ? Math.sin(this.bob) * 0.035 * clamp(Math.hypot(this.vel.x, this.vel.z) / 2, 0, 1) : 0;
    this.cam.position.set(this.pos.x, this.pos.y + bobY, this.pos.z);
    this.cam.rotation.set(this.pitch, -this.yaw, this.mode === 'fly' ? clamp(-angDiff(this._py ?? this.yaw, this.yaw) * 3, -0.12, 0.12) : 0, 'YXZ');
    this._py = this.yaw;
    this.cam.updateMatrixWorld();
    this._blockT = Math.max(0, this._blockT - dt);
  }
  _blocked(kind) { if (this._blockT <= 0) { this._blockT = 2.5; this.onEvent?.(kind); } }
  get heading() { return ((this.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); }
  speedKmh() { return Math.hypot(this.vel.x, this.vel.z, this.mode === 'fly' ? this.vy : 0) * 3.6; }
}
