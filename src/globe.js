// Globe scene — bright satellite earth with soft sky-blue atmosphere and HTML pins
import * as THREE from 'three';

const DEG = Math.PI / 180;
export function llToVec(lat, lon, r = 1) {
  const phi = (lon + 180) * DEG, th = (90 - lat) * DEG;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(th) * r, Math.cos(th) * r, Math.sin(phi) * Math.sin(th) * r);
}

export class Globe {
  constructor(renderer, labelsEl) {
    this.renderer = renderer;
    this.labelsEl = labelsEl;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.pins = [];
    this.selected = null;
    this.rot = { lon: 40, lat: 20, dist: 4.2 };
    this.target = { lon: 40, lat: 20, dist: 4.2 };
    this.autoSpin = true;
    this.onSelect = () => {};
    this.onOpen = () => {};
    this._build();
    this._bindInput();
  }

  async _build() {
    const loader = new THREE.TextureLoader();
    const tex = await loader.loadAsync('/textures/globe.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const geo = new THREE.SphereGeometry(1, 192, 128);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
    // brighten oceans with a soft turquoise tint & lift shadows in shader
    mat.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        float oc = smoothstep(0.08, 0.02, diffuseColor.r - diffuseColor.b * 0.55);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.75, 1.05, 1.18) + vec3(0.03, 0.10, 0.16), oc * 0.8);
        diffuseColor.rgb = pow(diffuseColor.rgb, vec3(0.92));
      `);
    };
    this.earth = new THREE.Mesh(geo, mat);
    this.group.add(this.earth);

    // soft cloud veil
    const cloudTex = new THREE.CanvasTexture(this._cloudCanvas());
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 128, 96),
      new THREE.MeshStandardMaterial({ map: cloudTex, alphaMap: cloudTex, transparent: true, opacity: 0.55, depthWrite: false, roughness: 1 }));
    this.group.add(this.clouds);

    // atmosphere — pale sky blue fresnel rim (no neon)
    const atm = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.NormalBlending,
      uniforms: { c: { value: new THREE.Color('#bfe0f2') } },
      vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix*normal); vec4 p = modelViewMatrix*vec4(position,1.); vP = p.xyz; gl_Position = projectionMatrix*p; }`,
      fragmentShader: `uniform vec3 c; varying vec3 vN; varying vec3 vP; void main(){ float f = pow(clamp(1.0 - abs(dot(normalize(-vP), vN)) , 0., 1.), 0.0); float i = pow(max(0., 0.72 - dot(vN, vec3(0,0,1.))), 2.2); gl_FragColor = vec4(c, clamp(i*1.6,0.,0.85)); }`,
    });
    this.group.add(new THREE.Mesh(new THREE.SphereGeometry(1.16, 96, 64), atm));
    const rim = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { c: { value: new THREE.Color('#e8f5fb') } },
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 p = modelViewMatrix*vec4(position,1.); vV = normalize(-p.xyz); gl_Position = projectionMatrix*p; }`,
      fragmentShader: `uniform vec3 c; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.), 3.0); gl_FragColor = vec4(c, f*0.75); }`,
    });
    this.group.add(new THREE.Mesh(new THREE.SphereGeometry(1.004, 96, 64), rim));

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#cfe3ee', 1.25));
    this.sun = new THREE.DirectionalLight('#fff6e8', 2.4);
    this.scene.add(this.sun);
    this.ready = true;
  }

  _cloudCanvas() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    const rnd = mulberry(7);
    for (let i = 0; i < 900; i++) {
      const lat = (rnd() - 0.5) * 150, y = (0.5 - lat / 180) * c.height;
      const band = Math.abs(lat) > 40 && Math.abs(lat) < 65 ? 1.6 : Math.abs(lat) < 10 ? 1.3 : 0.7;
      const x = rnd() * c.width, r = (10 + rnd() * 50) * band;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(255,255,255,${0.16 * band})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.beginPath(); g.ellipse(x, y, r * 2.2, r, 0, 0, Math.PI * 2); g.fill();
    }
    return c;
  }

  setRegions(regions) {
    this.labelsEl.querySelectorAll('.pin').forEach((e) => e.remove());
    this.pins = regions.map((r) => {
      const el = document.createElement('div');
      el.className = 'pin';
      el.style.setProperty('--c', r.accent);
      el.innerHTML = `<div class="lb">${r.name}</div><div class="dot"></div><div class="pulse"></div>`;
      el.addEventListener('pointerup', (e) => { e.stopPropagation(); if (this.selected === r) this.onOpen(r); else this.select(r); });
      this.labelsEl.appendChild(el);
      return { r, el, pos: llToVec(r.center[0], r.center[1], 1.005) };
    });
  }

  select(r, fly = true) {
    this.selected = r;
    this.autoSpin = false;
    this.pins.forEach((p) => p.el.classList.toggle('sel', p.r === r));
    if (fly) { this.target.lon = r.center[1]; this.target.lat = Math.max(-50, Math.min(55, r.center[0])); this.target.dist = 3.1; }
    this.onSelect(r);
  }

  deselect() {
    this.selected = null; this.target.dist = 4.2;
    this.pins.forEach((p) => p.el.classList.remove('sel'));
  }

  _bindInput() {
    const el = this.renderer.domElement;
    let down = null, pinch = null;
    const pts = new Map();
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY, lon: this.target.lon, lat: this.target.lat, t: performance.now() };
      this.autoSpin = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.active || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!pinch) pinch = { d, dist: this.target.dist };
        this.target.dist = THREE.MathUtils.clamp(pinch.dist * (pinch.d / d), 1.8, 6);
        return;
      }
      if (!down) return;
      const k = 0.18 * (this.target.dist / 4);
      this.target.lon = down.lon - (e.clientX - down.x) * k;
      this.target.lat = THREE.MathUtils.clamp(down.lat + (e.clientY - down.y) * k, -70, 75);
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size === 0) down = null; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => { if (this.active) this.target.dist = THREE.MathUtils.clamp(this.target.dist * (1 + e.deltaY * 0.001), 1.8, 6); }, { passive: true });
  }

  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.w = w; this.h = h; }

  update(dt, t) {
    if (!this.ready) return;
    if (this.autoSpin) this.target.lon += dt * 4;
    const s = 1 - Math.pow(0.02, dt);
    let dl = ((this.target.lon - this.rot.lon + 540) % 360) - 180;
    this.rot.lon += dl * s; this.rot.lat += (this.target.lat - this.rot.lat) * s; this.rot.dist += (this.target.dist - this.rot.dist) * s;
    // camera orbits; offset target to the left so UI panel on the right has room
    const cam = llToVec(this.rot.lat, this.rot.lon, this.rot.dist);
    this.camera.position.copy(cam);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const shift = this.selected ? 0.42 : 0;
    this.camera.position.addScaledVector(right, shift);
    this.camera.lookAt(right.clone().multiplyScalar(shift));
    this.sun.position.copy(cam).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).add(new THREE.Vector3(0, 1.5, 0));
    this.clouds.rotation.y = t * 0.004;
    // project pins
    const v = new THREE.Vector3(), camDir = this.camera.position.clone().normalize();
    for (const p of this.pins) {
      const facing = p.pos.clone().normalize().dot(camDir);
      v.copy(p.pos).project(this.camera);
      const x = (v.x * 0.5 + 0.5) * this.w, y = (-v.y * 0.5 + 0.5) * this.h;
      p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      p.el.style.opacity = facing > 0.15 ? 1 : facing > 0 ? facing / 0.15 : 0;
      p.el.style.pointerEvents = facing > 0.1 ? 'auto' : 'none';
      p.el.classList.toggle('nolabel', p.r !== this.selected && (this.rot.dist > 3.6 || facing < 0.55));
    }
  }

  show(on) { this.active = on; this.pins.forEach((p) => (p.el.style.display = on ? '' : 'none')); }
  render() { this.renderer.render(this.scene, this.camera); }
}

export function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
