// The Intel globe: an orthographic Earth drawn on a canvas in the HUD's
// orange: atmosphere, graticule, lit coastlines and US state lines, and
// one pulsing node per place in the feed, plus optional layers of small
// marks (aircraft, ships, satellites, temperature cells) that move live.
// Drag to turn,
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
  /** Layer marks only: how to draw it, and where it is now (live motion). */
  shape?: "plane" | "ship" | "sat" | "cell" | "base" | "dot";
  /** Heading, degrees clockwise from north (planes). */
  track?: number | null;
  pos?: (now: number) => [number, number] | null;
}

/** A layer mark plus its cached trig and last screen position. */
interface Mark extends GlobeNode {
  sinLat: number;
  cosLat: number;
  sinLon: number;
  cosLon: number;
  x: number;
  y: number;
  vis: boolean;
}

const RAD = Math.PI / 180;

function place(m: Mark, lat: number, lon: number) {
  m.lat = lat;
  m.lon = lon;
  m.sinLat = Math.sin(lat * RAD);
  m.cosLat = Math.cos(lat * RAD);
  m.sinLon = Math.sin(lon * RAD);
  m.cosLon = Math.cos(lon * RAD);
}

/**
 * Orthographic projection of a mark for the view centred on (lat0, lon0),
 * from its cached trig: d3's maths without its per-point allocations, so
 * ten thousand aircraft stay cheap. Null when it is on the far side.
 */
export function orthographic(
  lat: number,
  lon: number,
  lat0: number,
  lon0: number,
  scale: number,
  cx: number,
  cy: number,
): [number, number] | null {
  const m = { sinLat: Math.sin(lat * RAD), cosLat: Math.cos(lat * RAD), sinLon: Math.sin(lon * RAD), cosLon: Math.cos(lon * RAD) };
  const v = view(lat0, lon0);
  return project(m, v, scale, cx, cy);
}

type View = { s0: number; c0: number; sl0: number; cl0: number };
const view = (lat0: number, lon0: number): View => ({ s0: Math.sin(lat0 * RAD), c0: Math.cos(lat0 * RAD), sl0: Math.sin(lon0 * RAD), cl0: Math.cos(lon0 * RAD) });

function project(m: Pick<Mark, "sinLat" | "cosLat" | "sinLon" | "cosLon">, v: View, scale: number, cx: number, cy: number): [number, number] | null {
  const cosD = m.cosLon * v.cl0 + m.sinLon * v.sl0; // cos(lon - lon0)
  const sinD = m.sinLon * v.cl0 - m.cosLon * v.sl0;
  if (v.s0 * m.sinLat + v.c0 * m.cosLat * cosD < 0.02) return null;
  return [cx + scale * m.cosLat * sinD, cy - scale * (v.c0 * m.sinLat - v.s0 * m.cosLat * cosD)];
}

export interface GlobeEvents {
  onSelect(key: string | null): void;
}

const USA: [number, number] = [-98, 38];
const MIN_ZOOM = 0.75;
/** About 250 km across: a metro area. Past this, 1:50m coastlines turn to
 * straight segments; going deeper needs the 1:10m map (3.6 MB). */
const MAX_ZOOM = 60;
/** Past this, the 1:50m coastlines and borders load and are drawn instead. */
const DETAIL_ZOOM = 2.5;
const IDLE_MS = 5000;

const world = worldData as unknown as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
const states = statesData as unknown as Topology<{ states: GeometryCollection; nation: GeometryCollection }>;
const LAND = feature(world, world.objects.land);
const BORDERS = mesh(world, world.objects.countries, (a, b) => a !== b);

type Outline = { land: GeoPermissibleObjects; borders: GeoPermissibleObjects };
/** The finer map, loaded the first time anyone zooms in (≈0.75 MB). */
let fine: Outline | null = null;
let fineLoading = false;
function loadFine() {
  if (fine || fineLoading) return;
  fineLoading = true;
  // By URL, not as a module: a typed 0.75 MB import stalls the type checker.
  void import("world-atlas/countries-50m.json?url")
    .then((m) => fetch(m.default))
    .then((r) => r.json())
    .then((json) => {
      const w = json as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
      fine = { land: feature(w, w.objects.land), borders: mesh(w, w.objects.countries, (a, b) => a !== b) };
    })
    .catch(() => (fineLoading = false));
}

/** Wheel zoom about the cursor: the view centre moves toward the point under
 * it by the share of the view the zoom takes away, so that point stays put. */
export function zoomCentre(centre: [number, number], cursor: [number, number], z0: number, z1: number): [number, number] {
  return geoInterpolate(centre, cursor)(Math.max(0, 1 - z0 / z1));
}
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
  private readonly layers = new Map<string, Mark[]>();
  private lastMove = 0;
  private route: { type: "LineString"; coordinates: [number, number][] } | null = null;

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

  /** Show (or with null, clear) a layer of marks. Same-coloured marks
   * next to each other draw in one path, so callers group them. */
  setLayer(name: string, marks: GlobeNode[] | null) {
    if (!marks) {
      this.layers.delete(name);
      return;
    }
    const now = Date.now();
    this.layers.set(
      name,
      marks.map((n) => {
        const m = { ...n, sinLat: 0, cosLat: 1, sinLon: 0, cosLon: 1, x: 0, y: 0, vis: false };
        const at = n.pos?.(now) ?? [n.lat, n.lon];
        place(m, at[0], at[1]);
        return m;
      }),
    );
  }

  private findMark(key: string): Mark | undefined {
    for (const marks of this.layers.values()) {
      const m = marks.find((x) => x.key === key);
      if (m) return m;
    }
    return undefined;
  }

  /** Fade the base layer (a search is showing its own nodes). */
  setDim(dim: boolean) {
    this.dim = dim;
  }

  select(key: string | null, fly = true) {
    this.selected = key;
    const n = key ? (this.nodes.find((x) => x.key === key) ?? this.findMark(key)) : null;
    if (n && fly) this.flyTo(n.lat, n.lon, Math.max(this.zoom, 2.4));
  }

  flyTo(lat: number, lon: number, zoom = this.zoom) {
    this.lastInput = performance.now();
    const from = this.rotation.slice() as [number, number];
    this.flight = { from, to: [-lon, -lat], z0: this.zoom, z1: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)), t0: performance.now(), ms: 1100 };
  }

  /** The centre of the view and how far from it (degrees of arc) the
   * frame's shorter side reaches: the whole visible hemisphere at most. */
  view(): { lat: number; lon: number; radiusDeg: number } {
    const lon = ((((-this.rotation[0] + 180) % 360) + 360) % 360) - 180;
    const half = Math.min(this.width, this.height) / 2;
    return { lat: -this.rotation[1], lon, radiusDeg: Math.asin(Math.min(1, half / this.projection.scale())) / RAD };
  }

  /** Draw a route (`[lon, lat]` pairs) and fly to it; null clears it. */
  setRoute(line: [number, number][] | null) {
    this.route = line && line.length > 1 ? { type: "LineString", coordinates: line } : null;
    if (!this.route || !line) return;
    const [a, b] = [line[0], line[line.length - 1]];
    const [lon, lat] = geoInterpolate(a, b)(0.5);
    // The whole drive in view: the farther apart, the less zoom.
    this.flyTo(lat, lon, 0.35 / Math.max(geoDistance(a, b), 0.001));
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
        const z0 = this.zoom;
        this.setZoom(z0 * Math.exp(-e.deltaY * 0.0015));
        // Zooming in heads for what's under the cursor; out just widens.
        const p = local(e);
        const at = this.zoom > z0 ? this.projection.invert?.([p.x, p.y]) : null;
        if (at) {
          const c = zoomCentre([-this.rotation[0], -this.rotation[1]], at, z0, this.zoom);
          this.rotation = [-c[0], Math.max(-85, Math.min(85, -c[1]))];
        }
      },
      { passive: false },
    );
    c.style.cursor = "grab";
    c.style.touchAction = "none";
  }

  private setZoom(z: number) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (this.zoom > DETAIL_ZOOM) loadFine();
  }

  /** Zoom by `factor` about the view's centre (the + and − buttons). */
  zoomBy(factor: number) {
    this.flyTo(-this.rotation[1], -this.rotation[0], this.zoom * factor);
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
    if (best) return best;
    // Then small layer marks, then temperature cells (big, so last).
    for (const cells of [false, true]) {
      for (const marks of this.layers.values()) {
        if ((marks[0]?.shape === "cell") !== cells) continue;
        const reach = cells ? this.cellRadius() : 7;
        for (const m of marks) {
          const d = m.vis ? Math.hypot(m.x - x, m.y - y) : Infinity;
          if (d < reach && d < bestD) {
            best = { node: m, x: m.x, y: m.y, r: 4 };
            bestD = d;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  private cellRadius(): number {
    return this.projection.scale() * 10 * RAD * 0.42;
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
    if (t - this.lastMove > 1000) {
      this.lastMove = t;
      const now = Date.now();
      for (const marks of this.layers.values())
        for (const m of marks) {
          const at = m.pos?.(now);
          if (at) place(m, at[0], at[1]);
        }
    }
    if (this.flight) {
      const f = this.flight;
      const k = ease(Math.min(1, (t - f.t0) / f.ms));
      // Great-circle path between the two view centres.
      const centre = geoInterpolate([-f.from[0], -f.from[1]], [-f.to[0], -f.to[1]])(k);
      this.rotation = [-centre[0], -centre[1]];
      // Geometric, so a long zoom feels even all the way in.
      this.zoom = f.z0 * Math.pow(f.z1 / f.z0, k);
      if (this.zoom > DETAIL_ZOOM) loadFine();
      if (k >= 1) this.flight = null;
    } else if (!this.drag && !this.pinch && !this.selected && t - this.lastInput > IDLE_MS) {
      // The idle drift slows as you zoom, so the ground never races past.
      this.rotation = [this.rotation[0] + (dt * 0.004) / Math.max(1, this.zoom), this.rotation[1]];
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
    this.path(this.zoom > DETAIL_ZOOM && fine ? fine.land : LAND);
    ctx.fillStyle = `rgba(255, 122, 26, ${0.13 * dim})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 168, 80, ${0.75 * dim})`;
    ctx.lineWidth = 0.9;
    ctx.shadowColor = "rgba(255, 122, 26, 0.8)";
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
    stroke(this.zoom > DETAIL_ZOOM && fine ? fine.borders : BORDERS, `rgba(255, 150, 60, ${0.35 * dim})`, 0.6);
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

    this.drawMarks(true, dim);
    this.drawMarks(false, dim);
    if (this.route) {
      ctx.shadowColor = "rgba(127, 214, 255, 0.9)";
      ctx.shadowBlur = 10;
      stroke(this.route, "rgba(155, 231, 255, 0.95)", 2.6);
      ctx.shadowBlur = 0;
      const ends = this.route.coordinates;
      for (const [i, p] of [ends[0], ends[ends.length - 1]].entries()) {
        const xy = this.projection(p);
        if (!xy || geoDistance(p, [-this.rotation[0], -this.rotation[1]]) > Math.PI / 2) continue;
        ctx.beginPath();
        ctx.arc(xy[0], xy[1], i ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i ? "#ffd9a8" : "#9be7ff";
        ctx.fill();
      }
    }
    this.drawNodes(t);
    this.readout(w, h);
  }

  /** One layer pass: temperature cells (under everything) or the rest. */
  private drawMarks(cells: boolean, dim: number) {
    const ctx = this.ctx;
    const [cx, cy] = this.projection.translate();
    const scale = this.projection.scale();
    const v = view(-this.rotation[1], -this.rotation[0]);
    const size = Math.min(1.6, 0.8 + this.zoom * 0.15);
    const cellR = this.cellRadius();
    ctx.globalAlpha = dim;
    for (const marks of this.layers.values()) {
      if (!marks.length || (marks[0].shape === "cell") !== cells) continue;
      let colour = "";
      for (const m of marks) {
        const p = project(m, v, scale, cx, cy);
        m.vis = !!p;
        if (!p) continue;
        [m.x, m.y] = p;
        if (m.color !== colour) {
          if (colour) ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = colour = m.color;
        }
        if (m.shape === "plane") {
          // A dart along the heading (north is up on screen near the centre).
          const a = ((m.track ?? 0) - 90) * RAD;
          const [ca, sa] = [Math.cos(a) * size, Math.sin(a) * size];
          ctx.moveTo(m.x + ca * 4.5, m.y + sa * 4.5);
          ctx.lineTo(m.x - ca * 3 - sa * 2.6, m.y - sa * 3 + ca * 2.6);
          ctx.lineTo(m.x - ca * 1.6, m.y - sa * 1.6);
          ctx.lineTo(m.x - ca * 3 + sa * 2.6, m.y - sa * 3 - ca * 2.6);
          ctx.closePath();
        } else if (m.shape === "base") {
          const d = 3.2 * size;
          ctx.moveTo(m.x, m.y - d);
          ctx.lineTo(m.x + d, m.y);
          ctx.lineTo(m.x, m.y + d);
          ctx.lineTo(m.x - d, m.y);
          ctx.closePath();
        } else if (m.shape === "cell") {
          ctx.moveTo(m.x + cellR, m.y);
          ctx.arc(m.x, m.y, cellR, 0, Math.PI * 2);
        } else {
          const half = (m.shape === "sat" ? 2.2 : 1.6) * size;
          ctx.rect(m.x - half, m.y - half, half * 2, half * 2);
        }
      }
      if (colour) ctx.fill();
    }
    ctx.globalAlpha = 1;
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
    if (!selected && this.selected) {
      const m = this.findMark(this.selected);
      if (m?.vis) selected = { node: m, x: m.x, y: m.y, r: 4 };
    }

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
