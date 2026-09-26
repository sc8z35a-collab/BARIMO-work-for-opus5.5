// DEM cleaning shared by the terrain agent (mirrored in src/dem-decode.js for streamed tiles).
// 1) Terrarium tiles contain isolated spike/pit artifacts (e.g. -5724 m inland) → pixels deviating > SPIKE m from
//    their 3×3 neighbourhood median are replaced by it (on a planar slope a pixel equals that median, so real
//    cliffs survive). 2) Deep bathymetry is clamped — only the first metres below sea level are visible.
export const SPIKE = 350, SEA_FLOOR = -300;
export function cleanDEM(h, w, hgt = w) {
  const out = new Float32Array(h.length), nb = new Float32Array(8);
  let fixed = 0;
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < hgt) nb[n++] = h[yy * w + xx];
    }
    const s = nb.subarray(0, n).sort(), med = n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
    let v = h[y * w + x];
    if (!(Math.abs(v - med) <= SPIKE)) { v = med; fixed++; }
    out[y * w + x] = Math.max(v, SEA_FLOOR);
  }
  return { h: out, fixed };
}
