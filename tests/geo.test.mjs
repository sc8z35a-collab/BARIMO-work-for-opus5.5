import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as G from '../src/geo.js';
import { cleanDEM, decodeTerrarium, decode16, SEA_FLOOR } from '../src/dem-decode.js';

const regions = JSON.parse(fs.readFileSync(new URL('../public/data/regions.json', import.meta.url)));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

test('mercator round-trip', () => {
  for (const lat of [-80, -45.5, -20.6, 0, 12.3, 42.4, 84]) near(G.myToLat(G.latToMy(lat)), lat, 1e-9, 'lat');
  for (const lon of [-179.9, -67.69, 0, 45.6, 166.5]) near(G.mxToLon(G.lonToMx(lon)), lon, 1e-9, 'lon');
});

test('frame: explorable block centred, matches widthM, ll<->xz round-trips, POIs inside', () => {
  for (const r of regions) {
    const F = new G.RegionFrame(r.terrain);
    near(F.size, r.terrain.widthM, r.terrain.widthM * 0.01, `${r.id} width`);
    const b = r.terrain.bbox;
    const [x0, z0] = F.llToXZ(b.north, b.west), [x1, z1] = F.llToXZ(b.south, b.east);
    near(x0, -F.half, 1e-3, `${r.id} W`); near(x1, F.half, 1e-3, `${r.id} E`); near(z0, -F.half, 1e-3, `${r.id} N`); near(z1, F.half, 1e-3, `${r.id} S`);
    for (const p of [...r.pois, ...r.places]) {
      const [x, z] = F.llToXZ(p.ll[0], p.ll[1]); const [ux, uz] = F.uvToXZ(p.uv);
      near(x, ux, F.size * 1e-4, `${r.id} ${p.name} uv x`); near(z, uz, F.size * 1e-4, `${r.id} ${p.name} uv z`);
      const [la, lo] = F.xzToLL(x, z); near(la, p.ll[0], 1e-7, 'lat'); near(lo, p.ll[1], 1e-7, 'lon');
      assert.ok(F.inExtent(x, z), `${r.id} ${p.name} inside extent`);
    }
    const W = F.world, e = F.ext;
    assert.ok(W.mx0 <= e.mx0 && W.mx1 >= e.mx1 && W.my0 <= e.my0 && W.my1 >= e.my1, `${r.id} world ring contains extent`);
    assert.equal(r.terrain.n, 5, `${r.id} is 5x extent`);
  }
});

test('frame distances agree with haversine (local scale correct)', () => {
  for (const r of regions) {
    const F = new G.RegionFrame(r.terrain), b = r.terrain.bbox;
    const dLL = G.haversine(b.north, b.west, b.north, b.east);
    const [x0, z0] = F.llToXZ(b.north, b.west), [x1, z1] = F.llToXZ(b.north, b.east);
    near(Math.hypot(x1 - x0, z1 - z0), dLL, dLL * 0.012, `${r.id} E-W`);
  }
});

test('tile rects tile the extent exactly', () => {
  const t = regions[0].terrain, F = new G.RegionFrame(t);
  const a = F.tileRect(t.z, t.x0, t.y0), b = F.tileRect(t.z, t.x0 + t.n - 1, t.y0 + t.n - 1);
  near(a.x0, -F.half, 1e-6, 'x0'); near(a.z0, -F.half, 1e-6, 'z0'); near(b.x1, F.half, 1e-6, 'x1'); near(b.z1, F.half, 1e-6, 'z1');
  assert.ok(F.tileInExtent(t.z, t.x0, t.y0)); assert.ok(!F.tileInExtent(t.z, t.x0 - 1, t.y0));
  assert.ok(F.tileInExtent(t.z + 3, t.x0 * 8, t.y0 * 8)); assert.ok(!F.tileInExtent(t.z + 3, t.x0 * 8 - 1, t.y0 * 8));
});

test('globe xyz <-> ll round-trip', () => {
  for (const [la, lo] of [[0, 0], [42.4, 45.6], [-20.6, 166.5], [39.4, -31.2], [-60, -170]]) {
    const [a, b] = G.xyzToLL(...G.llToXYZ(la, lo)); near(a, la, 1e-9, 'lat'); near(((b - lo + 540) % 360) - 180, 0, 1e-9, 'lon');
  }
});

test('helpers', () => {
  assert.equal(G.fmtDist(430), '430 m'); assert.equal(G.fmtDist(1234), '1.2 km'); assert.equal(G.fmtDist(23456), '23 km'); assert.equal(G.fmtDist(NaN), '—');
  near(G.bearingXZ(0, -1), 0, 1e-12, 'N'); near(G.bearingXZ(1, 0), Math.PI / 2, 1e-12, 'E'); near(G.bearingXZ(0, 1), Math.PI, 1e-12, 'S');
  assert.equal(G.dirName(0), '北'); assert.equal(G.dirName(Math.PI / 2), '東'); assert.equal(G.dirName(2 * Math.PI - 0.01), '北'); assert.equal(G.dirName(-0.3), '北');
  near(G.angDiff(0.1, 2 * Math.PI - 0.1), -0.2, 1e-12, 'angDiff');
  near(G.curvatureDrop(10000), 7.85, 0.01, 'curvature');
  assert.equal(G.escapeHTML(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('DEM decode + spike cleaning', () => {
  const px = new Uint8Array([128, 0, 0, 255, 128, 100, 128, 255]); // 0 m, 100.5 m
  const h = decodeTerrarium(px, 2); near(h[0], 0, 1e-6, 'zero'); near(h[1], 100.5, 1e-6, 'val');
  const q = decode16(new Uint8Array([255, 255, 0, 0, 0, 0, 0, 0]), 2, 100, 200); near(q[0], 200, 1e-6, 'hi'); near(q[1], 100, 1e-6, 'lo');
  // 5x5 slope with a spike in the middle and a deep pit in the corner
  const w = 5, s = new Float32Array(25); for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) s[y * 5 + x] = x * 30;
  s[12] = 5000; s[0] = -6000;
  const c = cleanDEM(s, w);
  near(c[12], 60, 1e-6, 'spike removed'); assert.ok(c[0] >= SEA_FLOOR, 'pit clamped'); near(c[7], 60, 1e-6, 'slope kept');
  const cliff = new Float32Array(25); for (let i = 0; i < 25; i++) cliff[i] = (i % 5) >= 3 ? 800 : 0;
  assert.deepEqual([...cleanDEM(cliff, 5)], [...cliff], 'real cliff preserved');
});
