// The orb's 3D mode: a gold hologram of Jarvis after the films — a ribbed
// cage of broken bands, two tilted dial plates, a central eye, a cloud of
// glinting fragments and spikes, all drawn in thick lines through bloom.
// The model never turns; when he talks it flashes and its parts ripple and
// spin with his voice. three.js loads only when 3D is switched on.

import type { Group, Object3D } from "three";
import type { LineSegments2 } from "three/addons/lines/LineSegments2.js";

/** What the orb is doing this frame: its data-state and the voice level 0..1. */
export type CoreRead = () => { state: string; level: number };

type V3 = [number, number, number];

/** Deterministic, so the hologram looks the same every time it opens. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (n: number) => {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
};

const TAU = Math.PI * 2;
const onSphere = (r: number, lat: number, lon: number): V3 => [
  r * Math.cos(lat) * Math.cos(lon),
  r * Math.sin(lat),
  r * Math.cos(lat) * Math.sin(lon),
];
/** In the XZ plane (a dial lying flat). */
const flat = (r: number, a: number): V3 => [r * Math.cos(a), 0, r * Math.sin(a)];
/** In the XY plane (facing the camera). */
const facing = (r: number, a: number): V3 => [r * Math.cos(a), r * Math.sin(a), 0];

/** Segments for one layer; each carries a seed so it flashes on its own clock. */
class Lines {
  pos: number[] = [];
  seed: number[] = [];
  constructor(private rand: () => number) {}
  seg(a: V3, b: V3, s = this.rand()) {
    this.pos.push(...a, ...b);
    this.seed.push(s);
  }
  /** A path at(t), t 0..1, drawn as runs of segments with gaps between. */
  broken(at: (t: number) => V3, steps: number, fill: number, gap = 0.12) {
    let on = this.rand() < fill;
    let s = this.rand();
    let prev = at(0);
    for (let i = 1; i <= steps; i++) {
      const p = at(i / steps);
      if (on) this.seg(prev, p, s);
      prev = p;
      if (this.rand() < gap) {
        on = this.rand() < fill;
        s = this.rand();
      }
    }
  }
}

const POINT_VERT = `
attribute float seed;
uniform float uTime, uEnergy, uSize, uRatio;
varying float vA;
void main() {
  float r = fract(sin(seed * 91.7 + floor(uTime * (1.0 + uEnergy * 14.0) + seed * 17.0) * 12.9898) * 43758.5453);
  vA = mix(0.15, 1.0, step(0.55 - uEnergy * 0.35, r));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * uRatio * (0.4 + r * 1.2) * (0.7 + uEnergy * 0.8);
}`;
const POINT_FRAG = `
uniform vec3 uColor;
varying float vA;
void main() {
  float a = vA * smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uColor * a, a);
}`;
// Bloom drops alpha, so rebuild it from brightness: black reads as see-through.
const ALPHA_FRAG = `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  // Drop the faintest haze and fade to nothing before the canvas edge, so no square shows.
  vec3 c = max(texture2D(tDiffuse, vUv).rgb - 0.02, 0.0) * smoothstep(0.5, 0.34, length(vUv - 0.5));
  gl_FragColor = vec4(c.rgb, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
}`;

/** Mount the hologram in `host`; resolves with a function that tears it down. */
export async function showCore(host: HTMLElement, read: CoreRead): Promise<() => void> {
  const THREE = await import("three");
  const [{ LineSegments2 }, { LineSegmentsGeometry }, { LineMaterial }, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }, { ShaderPass }] =
    await Promise.all([
      import("three/addons/lines/LineSegments2.js"),
      import("three/addons/lines/LineSegmentsGeometry.js"),
      import("three/addons/lines/LineMaterial.js"),
      import("three/addons/postprocessing/EffectComposer.js"),
      import("three/addons/postprocessing/RenderPass.js"),
      import("three/addons/postprocessing/UnrealBloomPass.js"),
      import("three/addons/postprocessing/OutputPass.js"),
      import("three/addons/postprocessing/ShaderPass.js"),
    ]);
  const rand = rng(1009);
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true });
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(ratio);
  renderer.setClearColor(0x000000, 0);
  Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%" });
  host.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.7, 6.2);
  camera.lookAt(0, 0, 0);

  // ---- colour: white-gold at the core, gold, deep amber at the rim ----------
  const hot = new THREE.Color(0xfff1c8);
  const gold = new THREE.Color(0xffb347);
  const rim = new THREE.Color(0xd9661a);
  const tmp = new THREE.Color();
  const radial = (r: number) => (r < 0.6 ? tmp.copy(hot).lerp(gold, r / 0.6) : tmp.copy(gold).lerp(rim, Math.min(1, (r - 0.6) / 0.9)));

  // ---- layers ---------------------------------------------------------------
  interface Layer {
    obj: LineSegments2;
    base: Float32Array; // rgb, rgb per segment
    out: Float32Array; // the live colour buffer
    seed: Float32Array;
    gain: number;
    attr: import("three").InterleavedBuffer;
  }
  const layers: Layer[] = [];
  const materials: import("three").Material[] = [];
  const layer = (L: Lines, width: number, gain: number, parent: Object3D) => {
    const g = new LineSegmentsGeometry();
    g.setPositions(L.pos);
    const base = new Float32Array(L.seed.length * 6);
    for (let i = 0; i < L.pos.length; i += 3) {
      radial(Math.hypot(L.pos[i], L.pos[i + 1], L.pos[i + 2]));
      base.set([tmp.r, tmp.g, tmp.b], i);
    }
    g.setColors(base.slice()); // it keeps the array it is given; that one becomes the live buffer
    const m = new LineMaterial({ linewidth: width, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    materials.push(m);
    const obj = new LineSegments2(g, m);
    parent.add(obj);
    const attr = (g.getAttribute("instanceColorStart") as import("three").InterleavedBufferAttribute).data;
    layers.push({ obj, base, out: attr.array as Float32Array, seed: Float32Array.from(L.seed), gain, attr });
    return obj;
  };
  const group = (parent: Object3D = scene) => {
    const g = new THREE.Group();
    parent.add(g);
    return g;
  };

  // 1. Ribbed cage: meridian bands of close strands, broken.
  const cageG = group();
  const cage = new Lines(rand);
  for (let i = 0; i < 18; i++) {
    const lon = (i / 18) * TAU + rand() * 0.08;
    const strands = 3 + Math.floor(rand() * 2);
    for (let k = 0; k < strands; k++) {
      const off = lon + k * 0.018;
      const r = 1.0 + k * 0.012;
      cage.broken((t) => onSphere(r, (t - 0.5) * Math.PI * 0.94, off), 90, 0.62);
    }
  }
  layer(cage, 1.6, 0.85, cageG);

  // 2. Latitude rings with dial ticks, and a bright equator.
  const latG = group();
  const lat = new Lines(rand);
  for (const deg of [-58, -32, 0, 32, 58]) {
    const la = (deg * Math.PI) / 180;
    const strands = deg === 0 ? 3 : 1;
    for (let k = 0; k < strands; k++) lat.broken((t) => onSphere(1.0 + k * 0.012, la, t * TAU), 160, deg === 0 ? 0.85 : 0.6);
    for (let i = 0; i < 72; i++) {
      if (rand() < 0.4) continue;
      const lo = (i / 72) * TAU;
      lat.seg(onSphere(1.0, la, lo), onSphere(1.06, la, lo));
    }
  }
  layer(lat, 1.4, 0.9, latG);

  // 3. Two dial plates: concentric bands, radial data blocks, a tick rim.
  const dial = (rIn: number, rOut: number) => {
    const L = new Lines(rand);
    const bands = 8;
    for (let b = 0; b < bands; b++) {
      const r = rIn + ((rOut - rIn) * b) / (bands - 1);
      L.broken((t) => flat(r, t * TAU), 200, 0.6);
    }
    for (let i = 0; i < 260; i++) {
      const a = rand() * TAU;
      const r0 = rIn + rand() * (rOut - rIn - 0.08);
      const len = 0.03 + rand() * 0.09;
      for (let k = 0; k < 3; k++) L.seg(flat(r0, a + k * 0.006), flat(r0 + len, a + k * 0.006));
    }
    for (let i = 0; i < 240; i++) {
      const a = (i / 240) * TAU;
      L.seg(flat(rOut + 0.03, a), flat(rOut + (i % 10 === 0 ? 0.14 : 0.06), a));
    }
    return L;
  };
  const plateA = group();
  plateA.rotation.set(0.38, 0, 0.14);
  const spinA = group(plateA);
  layer(dial(0.55, 1.32), 1.5, 1, spinA);
  const plateB = group();
  plateB.rotation.set(1.25, 0.5, -0.35);
  const spinB = group(plateB);
  layer(dial(0.7, 1.18), 1.3, 0.75, spinB);

  // Thinking: a bright sweep arc riding plate A.
  const sweep = new Lines(rand);
  for (let b = 0; b < 4; b++) {
    const r = 1.0 + b * 0.09;
    for (let i = 0; i < 40; i++) sweep.seg(flat(r, (i / 40) * 0.9), flat(r, ((i + 1) / 40) * 0.9), 0.5);
  }
  const sweepG = group(plateA);
  const sweepObj = layer(sweep, 2.6, 0, sweepG);

  // 4. The eye: rings facing the camera with hash marks round a hot core.
  const eyeG = group();
  eyeG.lookAt(camera.position);
  const eyeSpin = [0.16, 0.24, 0.33].map((r, i) => {
    const L = new Lines(rand);
    L.broken((t) => facing(r, t * TAU), 90, 0.8);
    for (let k = 0; k < 48; k++) {
      if (rand() < 0.35) continue;
      const a = (k / 48) * TAU;
      L.seg(facing(r + 0.015, a), facing(r + 0.05 + (i === 2 ? 0.03 : 0), a));
    }
    const g = group(eyeG);
    layer(L, 2.2, 1.2, g);
    return g;
  });
  const cageEye = new Lines(rand);
  const edges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.11, 1));
  const ep = edges.getAttribute("position");
  for (let i = 0; i < ep.count; i += 2) cageEye.seg([ep.getX(i), ep.getY(i), ep.getZ(i)], [ep.getX(i + 1), ep.getY(i + 1), ep.getZ(i + 1)]);
  edges.dispose();
  const coreG = group();
  layer(cageEye, 2, 1.4, coreG);

  // 5. Fragments: short streaks along the sphere, and spark points.
  const fragG = group();
  const frag = new Lines(rand);
  const sparks: number[] = [];
  const sparkSeed: number[] = [];
  for (let i = 0; i < 650; i++) {
    const la = Math.asin(rand() * 2 - 1);
    const lo = rand() * TAU;
    const r = 0.45 + Math.sqrt(rand()) * 0.75;
    const along = rand() < 0.5;
    const len = 0.05 + rand() * 0.18;
    frag.seg(onSphere(r, la, lo), along ? onSphere(r, la, lo + len / r) : onSphere(r, la + len / r, lo));
    if (rand() < 0.35) {
      sparks.push(...onSphere(r, la, lo));
      sparkSeed.push(rand());
    }
  }
  layer(frag, 1.3, 0.9, fragG);

  // 6. Spikes: dashed rays from the core out past the shell.
  const spikeG = group();
  const spikes = new Lines(rand);
  for (let i = 0; i < 42; i++) {
    const la = Math.asin(rand() * 2 - 1);
    const lo = rand() * TAU;
    const end = 0.9 + rand() * 0.55;
    spikes.broken((t) => onSphere(0.14 + t * (end - 0.14), la, lo), 10, 0.75, 0.3);
  }
  layer(spikes, 1.2, 0.8, spikeG);

  // Spark points and the hot centre.
  const pointUniforms = { uTime: { value: 0 }, uEnergy: { value: 0.2 }, uRatio: { value: ratio }, uColor: { value: new THREE.Color(0xffe2a8) } };
  const points = (pos: number[], seed: number[], size: number, parent: Group) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { ...pointUniforms, uSize: { value: size } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    materials.push(m);
    parent.add(new THREE.Points(g, m));
  };
  points(sparks, sparkSeed, 3.5, fragG);
  const centre: number[] = [0, 0, 0];
  const centreSeed: number[] = [0.5];
  for (let i = 0; i < 40; i++) {
    centre.push(...onSphere(rand() * 0.08, Math.asin(rand() * 2 - 1), rand() * TAU));
    centreSeed.push(rand());
  }
  points(centre, centreSeed, 7, coreG);

  // ---- render pipeline: scene → bloom → colour out → alpha from brightness --
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(ratio);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.25, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(
    new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: ALPHA_FRAG,
    }),
  );

  const fit = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const m of materials) if (m instanceof LineMaterial) m.resolution.set(w, h);
  };
  const resize = new ResizeObserver(fit);
  resize.observe(host);
  fit();

  // ---- motion ---------------------------------------------------------------
  const pale = new THREE.Color(0xffe6bf);
  const alert = new THREE.Color(0xff3b30);
  const history = new Float32Array(32); // recent voice levels, newest first, for the ripple
  const clock = new THREE.Clock();
  let level = 0;
  let energy = 0.2;
  let sweepOn = 0;
  let raf = 0;
  const ripple = (frames: number) => history[Math.min(frames, history.length - 1)];

  const frame = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    const now = read();
    const s = now.state;
    level += (now.level - level) * 0.35;
    history.copyWithin(1, 0);
    history[0] = level;
    const target =
      s === "speaking" ? 0.4 + level * 1.3 : s === "thinking" ? 0.7 : s === "listening" ? 0.55 : s === "error" ? 0.25 : 0.18 + 0.04 * Math.sin(t * 1.8);
    energy += (target - energy) * 0.12;

    // Segment flashing: each re-rolls on its own clock; hotter means faster and more lit.
    const rate = s === "error" ? 0.8 : 1.2 + energy * 14;
    const lit = 0.5 - Math.min(energy, 1) * 0.35;
    const tint = s === "error" ? alert : s === "listening" ? pale : null;
    const mix = s === "error" ? 0.85 : 0.35;
    for (const L of layers) {
      // Many lines overlap additively, so each stays dim; bloom does the glowing.
      const gain = 0.32 * (L.obj === sweepObj ? sweepOn * 2 : L.gain * (0.6 + 0.6 * Math.min(energy, 1.2)));
      for (let i = 0; i < L.seed.length; i++) {
        const sd = L.seed[i];
        const r = hash(sd * 91.7 + Math.floor(t * rate + sd * 17) * 12.9898);
        const b = gain * (r > lit ? 0.75 + r * 0.45 : 0.22);
        for (let k = i * 6; k < i * 6 + 6; k += 3) {
          let cr = L.base[k];
          let cg = L.base[k + 1];
          let cb = L.base[k + 2];
          if (tint) {
            cr += (tint.r - cr) * mix;
            cg += (tint.g - cg) * mix;
            cb += (tint.b - cb) * mix;
          }
          L.out[k] = cr * b;
          L.out[k + 1] = cg * b;
          L.out[k + 2] = cb * b;
        }
      }
      L.attr.needsUpdate = true;
    }
    pointUniforms.uTime.value = t;
    pointUniforms.uEnergy.value = energy;
    pointUniforms.uColor.value.copy(s === "error" ? alert : pale);

    // The flash: bloom follows his voice.
    bloom.strength = 0.35 + energy * 0.45 + (s === "speaking" ? level * 0.6 : 0);

    // Nothing moves at rest. Speaking ripples outward and spins the plates; working spins harder.
    if (!calm) {
      const spin = s === "thinking" ? 1.0 : s === "speaking" ? 0.15 + level * 2.2 : s === "listening" ? 0.12 : 0;
      spinA.rotation.y += dt * spin;
      spinB.rotation.y -= dt * spin * 0.7;
      eyeSpin.forEach((g, i) => (g.rotation.z += dt * (spin * 1.8 + (s === "listening" ? 0.2 : 0)) * (i % 2 ? -1 : 1)));
      sweepG.rotation.y += dt * 2.4;
      coreG.scale.setScalar(1 + ripple(0) * 0.9 + (s === "idle" ? 0.05 * Math.sin(t * 1.8) : 0));
      eyeG.scale.setScalar(1 + ripple(2) * 0.25);
      plateA.scale.setScalar(1 + ripple(5) * 0.07);
      plateB.scale.setScalar(1 + ripple(5) * 0.07);
      cageG.scale.setScalar(1 + ripple(8) * 0.06);
      latG.scale.setScalar(1 + ripple(8) * 0.06);
      spikeG.scale.setScalar(0.95 + ripple(4) * 0.35);
      fragG.scale.setScalar(1 + ripple(11) * 0.14);
    }
    sweepOn += ((s === "thinking" ? 1 : 0) - sweepOn) * 0.08;

    composer.render();
    raf = requestAnimationFrame(frame);
  };
  frame();

  return () => {
    cancelAnimationFrame(raf);
    resize.disconnect();
    scene.traverse((o) => (o as import("three").Mesh).geometry?.dispose());
    for (const m of materials) m.dispose();
    composer.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
