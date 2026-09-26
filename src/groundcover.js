// Near-field ground cover for first-person mode: wind-animated grass clumps (with occasional alpine flowers) and
// scattered boulders, living on the rendered LOD terrain and coloured by the satellite imagery beneath them.
//
//  • every ~20 m of movement (or every 2 s) the terrain around the walker is captured once:
//      – a 128² float height grid of the *rendered* surface (so blades never float or sink)
//      – a 512² top-down render of the terrain itself (imagery × lighting × shadows, linear HDR)
//  • instances live on a world-anchored cell grid that scrolls with the camera; jitter/rotation/size are hashed from
//    the world cell index, so nothing swims or pops while walking
//  • the imagery colour drives a vegetation mask (green/tan, saturated, not snow/water/rock) — grass only grows where
//    the satellite shows vegetation; boulders prefer grey, bare or steep ground
//  • two grass rings (dense 0.3 m cells near, 1 m cells to 55 m) cross-fade; everything fades out smoothly at range
import * as THREE from 'three';

const HN = 128; // height grid resolution

const COMMON = /* glsl */`
  uniform sampler2D uHeight, uCol; uniform vec2 uCenter; uniform float uSpan;
  uniform vec2 uCamCell; uniform float uCell, uR, uRin, uScale, uTime; uniform vec2 uFwd;
  float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
  vec2 gUV(vec2 w){ return vec2((w.x - uCenter.x) / uSpan + .5, .5 - (w.y - uCenter.y) / uSpan); }
  float gH(vec2 w){ // manual bilinear on a NEAREST float texture (works without float-linear support)
    vec2 f = gUV(w) * ${HN}.0 - .5; vec2 i = floor(f); f -= i;
    ivec2 a = ivec2(clamp(i, vec2(0), vec2(${HN - 1}.0))), b = ivec2(clamp(i + 1., vec2(0), vec2(${HN - 1}.0)));
    float h00 = texelFetch(uHeight, ivec2(a.x, a.y), 0).r, h10 = texelFetch(uHeight, ivec2(b.x, a.y), 0).r;
    float h01 = texelFetch(uHeight, ivec2(a.x, b.y), 0).r, h11 = texelFetch(uHeight, ivec2(b.x, b.y), 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }
  // shared placement: returns world xz of the instance and its visibility (0..1)
  float place(vec2 cellOfs, out vec2 base, out vec2 cellW, out float d){
    cellW = uCamCell + cellOfs;
    base = (cellW + h22(cellW)) * uCell;
    vec2 dv = base - cameraPosition.xz; d = length(dv);
    float v = (1. - smoothstep(uR * .72, uR, d));
    if (uRin > 0.) v *= smoothstep(uRin * .8, uRin, d);
    if (d > 4. && dot(dv / d, uFwd) < -.35) v = 0.; // behind the viewer
    vec2 uv = gUV(base); if (uv.x < .01 || uv.y < .01 || uv.x > .99 || uv.y > .99) v = 0.;
    return v;
  }
`;

const FOG = /* glsl */`
  uniform vec3 uHaze, uHazeSun, uSunDir; uniform float uVis, uFogMax;
  vec3 applyFog(vec3 c, vec3 wp){ vec3 dv = wp - cameraPosition; float d = length(dv); float f = (1. - exp(-d / uVis)) * uFogMax;
    float sd = pow(max(dot(dv / max(d, 1.), uSunDir), 0.), 6.); return mix(c, mix(uHaze, uHazeSun, sd * .75), f); }
`;

function bladeClump(blades = 6, segs = 4) {
  const pos = [], t = [], side = [], idx = [];
  let rnd = 7; const R = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < blades; b++) {
    const a = R() * Math.PI * 2, r = R() * 0.16, ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const yaw = R() * Math.PI * 2, lean = 0.15 + R() * 0.35, hgt = 0.65 + R() * 0.5, w = 0.035 + R() * 0.03;
    const cx = Math.cos(yaw), sz = Math.sin(yaw);
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const k = s / segs, ww = w * (1 - k) ** 0.9 + 0.002, bend = lean * k * k;
      for (const sd of [-1, 1]) {
        pos.push(ox + cx * ww * sd - sz * bend * hgt, k * hgt, oz + sz * ww * sd + cx * bend * hgt);
        t.push(k); side.push(sd);
      }
    }
    for (let s = 0; s < segs; s++) { const q = base + s * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

function rockGeo() {
  const src = new THREE.IcosahedronGeometry(1, 2);
  const p = src.attributes.position;
  for (let i = 0; i < p.count; i++) { // lumpy, flattened boulder
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + 0.18 * Math.sin(x * 3.1 + z * 1.7) + 0.12 * Math.sin(y * 4.3 - x * 2.2) + 0.07 * Math.sin(z * 7.1 + y * 5.3);
    p.setXYZ(i, x * n * 1.15, (y > 0 ? y * 0.62 : y * 0.9) * n, z * n);
  }
  src.computeVertexNormals();
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', src.attributes.position); g.setAttribute('normal', src.attributes.normal);
  g.setIndex(src.index);
  return g;
}

function cellGrid(g, n) {
  const a = new Float32Array(n * n * 2); let k = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { a[k++] = i - n / 2; a[k++] = j - n / 2; }
  g.setAttribute('aCell', new THREE.InstancedBufferAttribute(a, 2));
  g.instanceCount = n * n;
  return g;
}

export class GroundCover {
  constructor({ renderer, engine, uniforms, density = 1 }) {
    this.renderer = renderer; this.E = engine; this.U = uniforms;
    this.group = new THREE.Group(); this.group.visible = false;
    this.density = density;
    this.heightData = new Float32Array(HN * HN);
    this.heightTex = new THREE.DataTexture(this.heightData, HN, HN, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter; this.heightTex.needsUpdate = true;
    this.rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, depthBuffer: true });
    this.rt.texture.minFilter = THREE.LinearFilter; this.rt.texture.generateMipmaps = false;
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000); this.ortho.up.set(0, 0, -1);
    this.center = new THREE.Vector2(1e9, 1e9); this.span = 150; this.lastCap = -1e9; this.ready = false;
    this.shared = {
      uHeight: { value: this.heightTex }, uCol: { value: this.rt.texture }, uCenter: { value: new THREE.Vector2() }, uSpan: { value: this.span },
      uTime: { value: 0 }, uFwd: { value: new THREE.Vector2(0, -1) },
      uHaze: uniforms.uHaze, uHazeSun: uniforms.uHazeSun, uSunDir: uniforms.uSunDir, uVis: uniforms.uVis, uFogMax: uniforms.uFogMax,
      uSunCol: { value: new THREE.Color('#fff4e0') },
    };
    this.layers = [];
    if (density > 0) {
      const d = density;
      this._grass(Math.round(120 * Math.sqrt(d)), 0.3 / Math.sqrt(d) * 1, 0, 1.0, 6);   // dense near ring (≈18 m)
      this._grass(Math.round(110 * Math.sqrt(d)), 1.0, 16, 1.35, 5);                     // far ring (≈55 m)
      this._rocks(Math.round(48 * Math.sqrt(d)), 2.2);
    }
  }

  _layerUniforms(n, cell, rin, scale) {
    return { ...this.shared, uCamCell: { value: new THREE.Vector2() }, uCell: { value: cell }, uR: { value: (n / 2) * cell * 0.98 }, uRin: { value: rin }, uScale: { value: scale } };
  }

  _grass(n, cell, rin, scale, blades) {
    const g = cellGrid(bladeClump(blades), n);
    const u = this._layerUniforms(n, cell, rin, scale);
    const m = new THREE.ShaderMaterial({
      uniforms: u, side: THREE.DoubleSide,
      vertexShader: COMMON + /* glsl */`
        attribute float aT, aSide; attribute vec2 aCell;
        varying vec3 vCol, vW; varying float vT, vK, vLush;
        void main(){
          vec2 base, cellW; float d; float vis = place(aCell, base, cellW, d);
          vec4 c4 = texture2D(uCol, gUV(base)); vec3 c = c4.rgb;
          float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), lum = dot(c, vec3(.2126, .7152, .0722));
          float sat = (mx - mn) / max(mx, 1e-4);
          // meadow = saturated green/tan of mid brightness; dense forest (very dark) and snow/rock/water get none
          float veg = smoothstep(.1, .25, sat) * (1. - smoothstep(.35, .6, lum)) * step(c.b, c.g * 1.05) * smoothstep(.035, .075, lum) * step(.5, c4.a);
          float lush = clamp((c.g - max(c.r, c.b) * .92) * 12., 0., 1.);
          float H = gH(base);
          float sl = length(vec2(gH(base + vec2(1.5, 0.)) - gH(base - vec2(1.5, 0.)), gH(base + vec2(0., 1.5)) - gH(base - vec2(0., 1.5)))) / 3.;
          veg *= 1. - smoothstep(.65, 1.1, sl);
          if (H < .4) veg = 0.; // shoreline / sea
          vec2 hh = h22(cellW + 17.3);
          float keep = step(hh.x, veg * 1.15);
          vis *= keep;
          if (vis < .02) { gl_Position = vec4(2., 2., 2., 1.); return; }
          float s = uScale * (.45 + .75 * hh.y) * mix(.55, 1.15, lush) * mix(.3, 1., vis) * (.6 + .4 * veg);
          float a = h12(cellW * 1.7) * 6.2832, ca = cos(a), sa = sin(a);
          vec3 p = position * s; p.xz = mat2(ca, -sa, sa, ca) * p.xz;
          // wind: travelling gusts + per-clump flutter
          float gust = sin(uTime * 1.3 + base.x * .21 + base.y * .13) * .5 + sin(uTime * 2.9 + base.x * .63 - base.y * .41) * .25 + .45;
          float flut = sin(uTime * 7. + h12(cellW) * 30.) * .06;
          vec2 wd = normalize(vec2(.8, .55));
          float bend = aT * aT * s * (.22 * gust + flut);
          p.xz += wd * bend; p.y -= bend * bend * .6;
          vec3 w = vec3(base.x + p.x, H + p.y - .04, base.y + p.z);
          vW = w; vT = aT; vCol = c; vK = h12(cellW + 3.1); vLush = lush * veg;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
        }`,
      fragmentShader: FOG + /* glsl */`
        uniform vec3 uSunCol;
        varying vec3 vCol, vW; varying float vT, vK, vLush;
        void main(){
          vec3 c = vCol * (.82 + .36 * vK);
          c = mix(c, c * vec3(1.06, 1.12, .82), vT * .5);         // sun-bleached tips
          vec3 col = c * mix(.6, 1.22, vT);                        // self-shadowed base → bright tip
          vec3 V = normalize(vW - cameraPosition);
          col += uSunCol * vCol * pow(max(dot(V, uSunDir), 0.), 3.) * vT * 1.4; // translucency against the sun
          if (vK > .955 && vT > .8 && vLush > .25) {                // alpine flowers
            float f = fract(vK * 97.);
            col = f < .33 ? vec3(.95, .93, .88) : f < .66 ? vec3(.95, .78, .22) : vec3(.62, .45, .85);
            col *= .7;
          }
          gl_FragColor = vec4(applyFog(col, vW), 1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 1;
    this.group.add(mesh); this.layers.push({ mesh, u, n, cell });
  }

  _rocks(n, cell) {
    const g = cellGrid(rockGeo(), n);
    const u = this._layerUniforms(n, cell, 0, 1);
    const m = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: COMMON + /* glsl */`
        attribute vec2 aCell; varying vec3 vCol, vW, vN;
        void main(){
          vec2 base, cellW; float d; float vis = place(aCell, base, cellW, d);
          vec4 c4 = texture2D(uCol, gUV(base)); vec3 c = c4.rgb;
          float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), lum = dot(c, vec3(.2126, .7152, .0722));
          float sat = (mx - mn) / max(mx, 1e-4);
          float H = gH(base);
          if (c4.a < .5) H = -1.;
          float sl = length(vec2(gH(base + vec2(2., 0.)) - gH(base - vec2(2., 0.)), gH(base + vec2(0., 2.)) - gH(base - vec2(0., 2.)))) / 4.;
          float rocky = max((1. - smoothstep(.1, .24, sat)) * smoothstep(.03, .09, lum) * (1. - smoothstep(.5, .75, lum)), smoothstep(.55, .9, sl));
          vec2 hh = h22(cellW + 5.7);
          float p = rocky * .5 + .03;                               // a few everywhere, many on bare/steep ground
          if (H < .4 || hh.x > p || vis < .02) { gl_Position = vec4(2., 2., 2., 1.); return; }
          float s = (.18 + pow(hh.y, 3.) * 1.4) * mix(.2, 1., vis);
          float a = h12(cellW * 2.3) * 6.2832, ca = cos(a), sa = sin(a);
          vec3 q = position * s; q.xz = mat2(ca, -sa, sa, ca) * q.xz;
          vec3 nn = normal; nn.xz = mat2(ca, -sa, sa, ca) * nn.xz;
          vec3 w = vec3(base.x + q.x, H + q.y - s * .25, base.y + q.z);
          vW = w; vN = nn; vCol = mix(vec3(lum), c, .55) * (.85 + .3 * h12(cellW + 9.));
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
        }`,
      fragmentShader: FOG + /* glsl */`
        uniform vec3 uSunCol; varying vec3 vCol, vW, vN;
        void main(){
          vec3 n = normalize(vN);
          float dif = max(dot(n, uSunDir), 0.), sky = .5 + .5 * n.y;
          vec3 col = vCol * (.35 * sky + .95 * dif * uSunCol + .12) * 1.25;
          gl_FragColor = vec4(applyFog(col, vW), 1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
    this.group.add(mesh); this.layers.push({ mesh, u, n, cell });
  }

  /** rebuild height grid + top-down colour capture around (cx, cz) */
  _capture(scene, cx, cz, hide) {
    const span = this.span, N = HN, E = this.E;
    // leaves overlapping the capture window, finest first → exact rendered-surface heights
    const x0 = cx - span / 2, z1 = cz + span / 2;
    const leaves = E.leaves.filter((n) => n.mesh && n.rect.x1 > x0 && n.rect.x0 < cx + span / 2 && n.rect.z1 > cz - span / 2 && n.rect.z0 < z1).sort((a, b) => b.z - a.z);
    let mnH = Infinity, mxH = -Infinity;
    for (let j = 0; j < N; j++) {
      const z = cz - ((j + 0.5) / N - 0.5) * span; // row j ↔ v (north-up capture)
      for (let i = 0; i < N; i++) {
        const x = x0 + ((i + 0.5) / N) * span;
        let h = null;
        for (const n of leaves) if (x >= n.rect.x0 && x <= n.rect.x1 && z >= n.rect.z0 && z <= n.rect.z1) { h = E._surfaceIn(n, x, z); break; }
        if (h == null) h = E.heightAt(x, z);
        this.heightData[j * N + i] = h; if (h < mnH) mnH = h; if (h > mxH) mxH = h;
      }
    }
    this.heightTex.needsUpdate = true;
    // colour: orthographic top-down render of the terrain only
    const o = this.ortho;
    o.left = -span / 2; o.right = span / 2; o.top = span / 2; o.bottom = -span / 2;
    o.position.set(cx, mxH + 200, cz); o.near = 10; o.far = mxH - mnH + 400; o.lookAt(cx, mnH - 10, cz); o.updateProjectionMatrix(); o.updateMatrixWorld();
    const r = this.renderer, prevT = r.getRenderTarget(), vis = hide.map((x) => x.visible);
    hide.forEach((x) => (x.visible = false)); this.group.visible = false;
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0); // alpha 0 = no terrain captured → nothing grows there
    r.setRenderTarget(this.rt); r.clear(); r.render(scene, o); r.setRenderTarget(prevT);
    r.setClearColor(cc, ca);
    hide.forEach((x, k) => (x.visible = vis[k]));
    this.center.set(cx, cz); this.shared.uCenter.value.set(cx, cz); this.shared.uSpan.value = span;
    this.ready = true;
  }

  /**
   * @param on  first-person at walking/drone-skimming height
   * @param camera main camera, scene, hide = objects to hide during capture (sky, water, clouds…)
   */
  update({ on, camera, scene, hide, t, sunColor }) {
    if (!this.layers.length) return;
    const cam = camera.position;
    if (!on) { this.group.visible = false; return; }
    const now = performance.now();
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const f2 = new THREE.Vector2(fwd.x, fwd.z); if (f2.lengthSq() < 1e-6) f2.set(0, -1); f2.normalize();
    // the capture only sees terrain inside the main frustum → refresh on movement, turning, or time
    const moved = Math.hypot(cam.x - this.center.x, cam.z - this.center.y);
    const turned = !this.capFwd || f2.dot(this.capFwd) < 0.82;
    if (moved > 22 || turned || now - this.lastCap > 2200) { this.lastCap = now; this.capFwd = f2.clone(); this._capture(scene, cam.x, cam.z, hide); }
    if (!this.ready) return;
    this.group.visible = true;
    this.shared.uFwd.value.copy(f2); this.shared.uTime.value = t;
    if (sunColor) this.shared.uSunCol.value.copy(sunColor);
    for (const L of this.layers) {
      const R = L.u.uR.value, ahead = R * 0.35;
      L.u.uCamCell.value.set(Math.floor((cam.x + f2.x * ahead) / L.cell), Math.floor((cam.z + f2.y * ahead) / L.cell));
    }
  }

  dispose() {
    for (const L of this.layers) { L.mesh.geometry.dispose(); L.mesh.material.dispose(); }
    this.heightTex.dispose(); this.rt.dispose();
  }
}
