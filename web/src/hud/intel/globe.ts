// The Intel globe: an orthographic Earth drawn on a canvas in the HUD's
// orange: atmosphere, graticule, lit coastlines and US state lines, and
// one pulsing node per place in the feed. Drag to turn,
// wheel or pinch to zoom; it drifts on its own when left alone and flies
// to whatever is selected. Map data is bundled (world-atlas, us-atlas), so
// nothing is fetched from anywhere.

import { geoDistance, geoGraticule10, geoInterpolate, geoOrthographic, geoPath, type GeoPermissibleObjects } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldData from "world-atlas/countries-110m.json";
import statesData from "us-atlas/states-10m.json";

export interface GlobeNode {
  key: string;
  lat: number;
  lon: number;
  color: string;
  /** 0–1. */
  weight: number;
  label: string;
  count: number;
}

export interface GlobeEvents {
  onSelect(key: string | null): void;
}

const USA: [number, number] = [-98, 38];
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 9;
const IDLE_MS = 5000;

const world = worldData as unknown as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
const states = statesData as unknown as Topology<{ states: GeometryCollection; nation: GeometryCollection }>;
const LAND = feature(world, world.objects.land);
const BORDERS = mesh(world, world.objects.countries, (a, b) => a !== b);
const STATE_LINES = mesh(states, states.objects.states, (a, b) => a !== b);
const GRATICULE = geoGraticule10();

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Projected {
  node: GlobeNode;
  x: number;
  y: number;
  r: number;
}

export class Globe {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly projection = geoOrthographic().clipAngle(90).precision(0.4);
  private readonly path;
  private nodes: GlobeNode[] = [];
  private projected: Projected[] = [];
  private rotation: [number, number] = [-USA[0], -USA[1]];
  private zoom = 1.1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private running = false;
  private last = 0;
  private lastInput = 0;
  private selected: string | null = null;
  private hover: Projected | null = null;
  private flight: { from: [number, number]; to: [number, number]; z0: number; z1: number; t0: number; ms: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; rot: [number, number]; moved: boolean } | null = null;
  private pinch: { d: number; zoom: number } | null = null;
  private readonly resize: ResizeObserver;
  private readonly off: (() => void)[] = [];
  private dim = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ev: GlobeEvents,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    this.ctx = ctx;
    this.path = geoPath(this.projection, ctx);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.fit();
    this.bind();
  }

  setNodes(nodes: GlobeNode[]) {
    this.nodes = nodes;
    if (this.selected && !nodes.some((n) => n.key === this.selected)) this.selected = null;
  }

  /** Fade the base layer (a search is showing its own nodes). */
  setDim(dim: boolean) {
    this.dim = dim;
  }

  select(key: string | null, fly = true) {
    this.selected = key;
    const n = key ? this.nodes.find((x) => x.key === key) : null;
    if (n && fly) this.flyTo(n.lat, n.lon, Math.max(this.zoom, 2.4));
  }

  flyTo(lat: number, lon: number, zoom = this.zoom) {
    this.lastInput = performance.now();
    const from = this.rotation.slice() as [number, number];
    this.flight = { from, to: [-lon, -lat], z0: this.zoom, z1: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)), t0: performance.now(), ms: 1100 };
  }

  home(world = false) {
    this.selected = null;
    if (world) this.flyTo(25, -40, 0.95);
    else this.flyTo(USA[1], USA[0], 1.1);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.fit();
    const frame = (t: number) => {
      if (!this.running) return;
      this.step(t);
      this.draw(t);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.resize.disconnect();
    this.off.forEach((f) => f());
  }

  // ---- input -----------------------------------------------------------------

  private bind() {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => c.removeEventListener(type, fn as EventListener));
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    on("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      this.flight = null;
      this.lastInput = performance.now();
      if (this.pointers.size === 1) this.drag = { ...p, rot: this.rotation.slice() as [number, number], moved: false };
      else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
        this.drag = null;
      }
    });
    on("pointermove", (e) => {
      const p = local(e);
      if (!this.pointers.has(e.pointerId)) {
        this.hover = this.hit(p.x, p.y);
        c.style.cursor = this.hover ? "pointer" : "grab";
        return;
      }
      this.pointers.set(e.pointerId, p);
      this.lastInput = performance.now();
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.setZoom(this.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, this.pinch.d)));
      } else if (this.drag) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
        const k = 90 / this.projection.scale();
        this.rotation = [this.drag.rot[0] + dx * k * 0.9, Math.max(-85, Math.min(85, this.drag.rot[1] - dy * k * 0.9))];
        c.style.cursor = "grabbing";
      }
    });
    const end = (e: PointerEvent) => {
      const p = local(e);
      const wasClick = this.drag && !this.drag.moved && this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (wasClick) {
        const h = this.hit(p.x, p.y);
        this.selected = h?.node.key ?? null;
        this.ev.onSelect(this.selected);
        if (h) this.flyTo(h.node.lat, h.node.lon, Math.max(this.zoom, 2.4));
      }
      if (!this.pointers.size) {
        this.drag = null;
        c.style.cursor = "grab";
      }
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("pointerleave", () => (this.hover = null));
    on(
      "wheel",
      (e) => {
        e.preventDefault();
        this.flight = null;
        this.lastInput = performance.now();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    c.style.cursor = "grab";
    c.style.touchAction = "none";
  }

  private setZoom(z: number) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  private hit(x: number, y: number): Projected | null {
    let best: Projected | null = null;
    let bestD = Infinity;
    for (const p of this.projected) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.max(10, p.r + 6) && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  // ---- frame -----------------------------------------------------------------

  private fit() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    const w = Math.round(this.width * this.dpr);
    const h = Math.round(this.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private step(t: number) {
    const dt = Math.min(64, t - this.last);
    this.last = t;
    if (this.flight) {
      const f = this.flight;
      const k = ease(Math.min(1, (t - f.t0) / f.ms));
      // Great-circle path between the two view centres.
      const centre = geoInterpolate([-f.from[0], -f.from[1]], [-f.to[0], -f.to[1]])(k);
      this.rotation = [-centre[0], -centre[1]];
      this.zoom = f.z0 + (f.z1 - f.z0) * k;
      if (k >= 1) this.flight = null;
    } else if (!this.drag && !this.pinch && !this.selected && t - this.lastInput > IDLE_MS) {
      this.rotation = [this.rotation[0] + dt * 0.004, this.rotation[1]];
    }
  }

  private draw(t: number) {
    const { ctx, width: w, height: h, dpr } = this;
    const base = Math.min(w, h) * 0.42;
    const r = base * this.zoom;
    const cx = w / 2;
    const cy = h / 2;
    this.projection.translate([cx, cy]).scale(r).rotate([this.rotation[0], this.rotation[1], 0]);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Atmosphere.
    const halo = ctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.28);
    halo.addColorStop(0, "rgba(255, 122, 26, 0.32)");
    halo.addColorStop(0.35, "rgba(255, 122, 26, 0.10)");
    halo.addColorStop(1, "rgba(255, 122, 26, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.28, 0, Math.PI * 2);
    ctx.fill();

    // Ocean.
    const sea = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    sea.addColorStop(0, "rgba(60, 26, 6, 0.95)");
    sea.addColorStop(1, "rgba(14, 6, 2, 0.98)");
    ctx.fillStyle = sea;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    const dim = this.dim ? 0.45 : 1;
    const stroke = (obj: GeoPermissibleObjects, style: string, width: number) => {
      ctx.beginPath();
      this.path(obj);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    stroke(GRATICULE, `rgba(255, 122, 26, ${0.09 * dim})`, 0.6);

    ctx.beginPath();
    this.path(LAND);
    ctx.fillStyle = `rgba(255, 122, 26, ${0.13 * dim})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 168, 80, ${0.75 * dim})`;
    ctx.lineWidth = 0.9;
    ctx.shadowColor = "rgba(255, 122, 26, 0.8)";
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
    stroke(BORDERS, `rgba(255, 150, 60, ${0.35 * dim})`, 0.6);
    stroke(STATE_LINES, `rgba(255, 178, 92, ${0.22 * dim})`, 0.5);

    // Rim.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 140, 50, 0.85)";
    ctx.lineWidth = 1.2;
    ctx.shadowColor = "rgba(255, 122, 26, 0.9)";
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;
    this.ticks(cx, cy, r * 1.1);

    this.drawNodes(t);
    this.readout(w, h);
  }

  private ticks(cx: number, cy: number, r: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255, 122, 26, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2 + this.rotation[0] * (Math.PI / 180);
      const len = i % 6 === 0 ? 7 : 3;
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * (r + len), cy + Math.sin(a) * (r + len));
    }
    ctx.stroke();
  }

  private drawNodes(t: number) {
    const ctx = this.ctx;
    const centre: [number, number] = [-this.rotation[0], -this.rotation[1]];
    const out: Projected[] = [];
    let selected: Projected | null = null;
    for (const node of this.nodes) {
      if (geoDistance([node.lon, node.lat], centre) > Math.PI / 2 - 0.03) continue;
      const p = this.projection([node.lon, node.lat]);
      if (!p) continue;
      const r = Math.min(13, 2.6 + node.weight * 7 + Math.sqrt(node.count) * 0.8) * Math.min(1.5, 0.75 + this.zoom * 0.2);
      const pr = { node, x: p[0], y: p[1], r };
      out.push(pr);
      if (node.key === this.selected) selected = pr;
    }
    this.projected = out;

    for (const { node, x, y, r } of out) {
      // Glow.
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
      g.addColorStop(0, hexA(node.color, 0.55));
      g.addColorStop(1, hexA(node.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
      // Pulse: louder nodes ring more often.
      const period = 2600 - node.weight * 1400;
      const phase = ((t + hashPhase(node.key) * period) % period) / period;
      ctx.beginPath();
      ctx.arc(x, y, r + phase * r * 2.6, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(node.color, 0.7 * (1 - phase));
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Core.
      ctx.beginPath();
      ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = "#fff6ea";
      ctx.fill();
    }

    if (selected) this.reticle(selected, t);
    const label = this.hover && this.hover !== selected ? this.hover : null;
    if (label) this.tag(label, false);
  }

  private reticle(p: Projected, t: number) {
    const ctx = this.ctx;
    const s = p.r + 10;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.strokeStyle = "#ffd9a8";
    ctx.lineWidth = 1.4;
    ctx.shadowColor = "rgba(255, 178, 92, 0.9)";
    ctx.shadowBlur = 8;
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(s, s - 6);
      ctx.lineTo(s, s);
      ctx.lineTo(s - 6, s);
      ctx.stroke();
    }
    ctx.rotate(t / 900);
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.arc(0, 0, s + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    this.tag(p, true);
  }

  private tag(p: Projected, strong: boolean) {
    const ctx = this.ctx;
    const text = `${p.node.label.toUpperCase()}${p.node.count > 1 ? `  ·  ${p.node.count}` : ""}`;
    ctx.font = `600 ${strong ? 13 : 12}px Rajdhani, sans-serif`;
    const w = ctx.measureText(text).width + 14;
    let x = p.x + p.r + 16;
    if (x + w > this.width - 6) x = p.x - p.r - 16 - w;
    const y = p.y - 10;
    ctx.fillStyle = "rgba(18, 8, 2, 0.88)";
    ctx.fillRect(x, y, w, 20);
    ctx.strokeStyle = strong ? "rgba(255, 217, 168, 0.9)" : "rgba(255, 122, 26, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 19);
    ctx.fillStyle = strong ? "#ffe6cc" : "rgba(255, 214, 170, 0.85)";
    ctx.fillText(text, x + 7, y + 14);
    ctx.beginPath();
    ctx.moveTo(p.x + (x > p.x ? p.r + 2 : -p.r - 2), p.y);
    ctx.lineTo(x > p.x ? x : x + w, y + 10);
    ctx.stroke();
  }

  private readout(w: number, h: number) {
    const ctx = this.ctx;
    const lat = -this.rotation[1];
    let lon = -this.rotation[0];
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = "rgba(255, 214, 170, 0.55)";
    const line = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}  ·  ×${this.zoom.toFixed(1)}  ·  ${this.projected.length} IN VIEW`;
    ctx.fillText(line, 12, h - 12);
    if (w < 520) return;
    ctx.textAlign = "right";
    ctx.fillText("ORTHO · WGS84", w - 12, h - 12);
    ctx.textAlign = "left";
  }
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function hashPhase(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}
