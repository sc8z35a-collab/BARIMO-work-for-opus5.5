// Shared geodesy / tile math. Pure functions only (unit-tested in tests/geo.test.mjs).
//
// Local "region frame": metres on a tangent plane centred on the explorable block.
//   X = east, Z = south (north = -Z), Y = up. 1 unit = 1 metre.
// Built on normalised Web-Mercator coordinates (mx, my ∈ [0,1]) so every slippy-map tile is an exact
// axis-aligned square in the frame — tiles are placed without resampling.
export const EARTH_R = 6371008.8;
export const EARTH_C = 40075016.686;
const D2R = Math.PI / 180;

export const lonToMx = (lon) => (lon + 180) / 360;
export const latToMy = (lat) => {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const mxToLon = (mx) => mx * 360 - 180;
export const myToLat = (my) => Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / D2R;

export class RegionFrame {
  /** @param t region.terrain ({ z, x0, y0, n, world }) */
  constructor(t) {
    const N = 2 ** t.z;
    this.z0 = t.z;
    this.ext = { mx0: t.x0 / N, my0: t.y0 / N, mx1: (t.x0 + t.n) / N, my1: (t.y0 + t.n) / N };
    this.mcx = (this.ext.mx0 + this.ext.mx1) / 2;
    this.mcy = (this.ext.my0 + this.ext.my1) / 2;
    this.lat0 = myToLat(this.mcy);
    this.S = EARTH_C * Math.cos(this.lat0 * D2R); // metres per normalised-mercator unit at the frame centre
    this.size = (this.ext.mx1 - this.ext.mx0) * this.S;
    this.half = this.size / 2;
    const W = t.world, NW = 2 ** W.z;
    this.world = { z: W.z, x0: W.x0, y0: W.y0, n: W.n, mx0: W.x0 / NW, my0: W.y0 / NW, mx1: (W.x0 + W.n) / NW, my1: (W.y0 + W.n) / NW };
    this.worldRect = { x0: this.mToX(this.world.mx0), z0: this.mToZ(this.world.my0), x1: this.mToX(this.world.mx1), z1: this.mToZ(this.world.my1) };
  }
  mToX(mx) { return (mx - this.mcx) * this.S; }
  mToZ(my) { return (my - this.mcy) * this.S; }
  xToM(x) { return x / this.S + this.mcx; }
  zToM(z) { return z / this.S + this.mcy; }
  llToXZ(lat, lon) { return [this.mToX(lonToMx(lon)), this.mToZ(latToMy(lat))]; }
  xzToLL(x, z) { return [myToLat(this.zToM(z)), mxToLon(this.xToM(x))]; }
  uvToXZ([u, v]) { return [(u - 0.5) * this.size, (v - 0.5) * this.size]; }
  xzToUV(x, z) { return [x / this.size + 0.5, z / this.size + 0.5]; }
  tileRect(z, x, y) {
    const N = 2 ** z;
    return { x0: this.mToX(x / N), z0: this.mToZ(y / N), x1: this.mToX((x + 1) / N), z1: this.mToZ((y + 1) / N) };
  }
  tileInExtent(z, x, y) {
    const N = 2 ** z, e = this.ext, eps = 1e-12;
    return (x + 1) / N > e.mx0 + eps && x / N < e.mx1 - eps && (y + 1) / N > e.my0 + eps && y / N < e.my1 - eps;
  }
  tileAt(z, x, zz) { const N = 2 ** z; return [Math.floor(this.xToM(x) * N), Math.floor(this.zToM(zz) * N)]; }
  inExtent(x, z, margin = 0) { return Math.abs(x) <= this.half - margin && Math.abs(z) <= this.half - margin; }
  inWorld(x, z) { const r = this.worldRect; return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1; }
}

/** Earth-curvature drop (m) of a point at horizontal distance d from the viewer. */
export const curvatureDrop = (d) => (d * d) / (2 * EARTH_R);

export function haversine(lat1, lon1, lat2, lon2) {
  const dLa = (lat2 - lat1) * D2R, dLo = (lon2 - lon1) * D2R;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLo / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** compass bearing (0 = north, clockwise, radians) of a frame-space direction (dx east, dz south) */
export const bearingXZ = (dx, dz) => { const b = Math.atan2(dx, -dz); return b < 0 ? b + 2 * Math.PI : b; };

export function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 950) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  if (m < 9950) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}
export function fmtLL(lat, lon) {
  const f = (v, p, n) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? p : n}`;
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}
const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
export const dirName = (b) => DIRS[((Math.round((b / (2 * Math.PI)) * 8) % 8) + 8) % 8];

/** Globe: lat/lon → sphere vector (matches the equirectangular globe texture on THREE.SphereGeometry). */
export function llToXYZ(lat, lon, r = 1, out = [0, 0, 0]) {
  const phi = (lon + 180) * D2R, th = (90 - lat) * D2R;
  out[0] = -Math.cos(phi) * Math.sin(th) * r; out[1] = Math.cos(th) * r; out[2] = Math.sin(phi) * Math.sin(th) * r;
  return out;
}
export function xyzToLL(x, y, z) {
  const r = Math.hypot(x, y, z);
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, y / r))) / D2R;
  let lon = Math.atan2(z, -x) / D2R - 180;
  if (lon < -180) lon += 360;
  return [lat, lon];
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/** frame-rate independent exponential smoothing factor */
export const damp = (lambda, dt) => 1 - Math.exp(-lambda * dt);
/** shortest signed angle difference a→b (radians) */
export const angDiff = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
export const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
