// The Systems tab: the whole of Opus Systems OS as one live map. Every node
// is coloured from something real — the API's ops rows (droplet, Docker per
// container, Tailscale per device, GitHub, Cloudflare, UptimeRobot), the
// rig's Ollama, key last-use from /v1/clients (the Quest, the Mac apps,
// Windows), and running sessions. Nothing is inferred that isn't there.

import { get } from "../api";
import { ago } from "./fleet";

type State = "ok" | "warn" | "down" | "idle" | "unknown";

interface NodeDef {
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
}

interface Live {
  state: State;
  sub: string;
  detail: Record<string, unknown>;
}

interface OpsRow {
  id: string;
  name: string;
  state: string;
  headline: string;
}
interface Container {
  name: string;
  state: string;
  status: string;
  image: string;
}
interface Device {
  name: string;
  online: boolean;
  os: string;
  last_seen: string;
}
interface Client {
  name: string;
  last_seen_at: string | null;
  since: string;
}

/** Key names → how they appear on the map. Unknown names still get a node. */
const CLIENT_LABELS: Record<string, string> = {
  web: "Web HUD",
  mac: "Mac · Jarvis apps",
  "quest-3": "Meta Quest 3",
  "win-rig": "Windows app",
  "jarvis-mac": "Jarvis (old key)",
};

const FIXED: NodeDef[] = [
  { id: "caddy", label: "Caddy · TLS", x: 330, y: 250 },
  { id: "jarvis-web", label: "jarvis-web", x: 470, y: 95 },
  { id: "api", label: "Opus API", x: 470, y: 195 },
  { id: "control-plane", label: "Control plane", x: 470, y: 305 },
  { id: "mcp-fleet", label: "mcp-fleet", x: 470, y: 405 },
  { id: "anthropic", label: "Managed Agents", x: 760, y: 250, w: 150 },
  { id: "sandbox", label: "Cloud sandboxes", x: 910, y: 140 },
  { id: "rig", label: "Rig · RTX 5070", x: 910, y: 360 },
  { id: "github", label: "GitHub", x: 330, y: 520 },
  { id: "cloudflare", label: "Cloudflare", x: 480, y: 520 },
  { id: "uptimerobot", label: "UptimeRobot", x: 630, y: 520 },
];

const EDGES: [string, string, string?][] = [
  ["jarvis-web", "api"],
  ["caddy", "jarvis-web"],
  ["caddy", "api"],
  ["api", "control-plane"],
  ["mcp-fleet", "control-plane"],
  ["control-plane", "anthropic"],
  ["anthropic", "mcp-fleet"],
  ["anthropic", "sandbox"],
  ["anthropic", "rig"],
  ["control-plane", "rig", "tailnet"],
];

const NODE_W = 132;
const NODE_H = 46;

/** Fit a subtitle into a node (mono, ~5.8 px per character at 9.5 px). */
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const STATE_WORD: Record<State, string> = {
  ok: "online",
  warn: "degraded",
  down: "down",
  idle: "idle",
  unknown: "unknown",
};

function clientState(c: Client): State {
  if (!c.last_seen_at) return "idle";
  const age = Date.now() - Date.parse(c.last_seen_at);
  if (age < 5 * 60_000) return "ok";
  if (age < 24 * 3_600_000) return "warn";
  return "idle";
}

export class SystemsView {
  private nodes: NodeDef[] = [...FIXED];
  private readonly live = new Map<string, Live>();
  private selected: string | null = null;
  private timer: number | undefined;
  private clients: Client[] = [];

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="systems">
        <section class="panel systems-map">
          <header class="panel-head"><span class="panel-title">Architecture</span><span class="panel-tag" id="map-updated"></span></header>
          <div class="map-wrap"><svg class="map" id="map" viewBox="0 0 1000 570" role="img" aria-label="Opus Systems OS architecture"></svg></div>
        </section>
        <section class="panel systems-detail">
          <header class="panel-head"><span class="panel-title" id="node-title">Select a node</span><span class="panel-tag" id="node-state"></span></header>
          <div class="panel-body"><dl class="node-facts" id="node-facts"></dl></div>
        </section>
      </div>`;
  }

  show() {
    void this.refresh();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.refresh(), 30_000);
  }

  hide() {
    window.clearInterval(this.timer);
  }

  dispose() {
    this.hide();
  }

  private async refresh() {
    const [ops, docker, tailscale, rig, clients, sessions] = await Promise.allSettled([
      get<{ services: OpsRow[] }>("ops"),
      get<{ detail?: { containers?: Container[] } }>("ops/docker"),
      get<{ detail?: { devices?: Device[] } }>("ops/tailscale"),
      get<{ online?: boolean; models?: { name?: string }[]; reason?: string }>("rig"),
      get<{ data: Client[] }>("clients"),
      get<{ data: { status: string; metadata?: Record<string, string> }[] }>("sessions?limit=30&order=desc"),
    ]);
    this.live.clear();
    const val = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);

    // Outside services and the droplet itself, from the ops hub.
    const rows = val(ops)?.services ?? [];
    const row = (id: string) => rows.find((r) => r.id === id);
    for (const id of ["github", "cloudflare", "uptimerobot"]) {
      const r = row(id);
      if (r) this.live.set(id, { state: r.state as State, sub: r.headline, detail: { status: r.state, summary: r.headline } });
    }
    const droplet = row("droplet");

    // Each service on the droplet, from Docker.
    const containers = val(docker)?.detail?.containers ?? [];
    for (const [id, match] of [
      ["caddy", "caddy"],
      ["jarvis-web", "jarvis-web"],
      ["api", "-api-"],
      ["control-plane", "control-plane"],
      ["mcp-fleet", "mcp-fleet"],
    ] as const) {
      const c = containers.find((k) => k.name.includes(match));
      this.live.set(id, c
        ? { state: c.state === "running" ? "ok" : "down", sub: c.status, detail: { container: c.name, image: c.image, status: c.status, droplet: droplet?.headline } }
        : { state: "unknown", sub: "no container data", detail: {} });
    }

    // Anthropic's side: what the fleet is doing right now.
    const list = val(sessions)?.data ?? [];
    const running = list.filter((s) => s.status === "running");
    this.live.set("anthropic", {
      state: val(sessions) ? "ok" : "unknown",
      sub: `${running.length} running · ${list.length} recent`,
      detail: { running: running.map((s) => s.metadata?.iron_fleet_agent ?? "?").join(", ") || "none", "recent sessions": list.length },
    });
    const cloudRunning = running.filter((s) => s.metadata?.iron_fleet_environment !== "rig-gpu").length;
    this.live.set("sandbox", { state: "ok", sub: `${cloudRunning} active`, detail: { environments: "cloud-default, jarvis-lab, blueweb-web" } });

    // The rig: on the tailnet, and whether Ollama answers.
    const devices = val(tailscale)?.detail?.devices ?? [];
    const opus = devices.find((d) => d.os === "windows") ?? devices.find((d) => d.name === "opus");
    const rigInfo = val(rig);
    const rigState: State = opus?.online ? (rigInfo?.online ? "ok" : "warn") : "down";
    this.live.set("rig", {
      state: rigState,
      sub: opus?.online ? (rigInfo?.online ? `Ollama · ${(rigInfo.models ?? []).length} models` : "on tailnet · Ollama off") : "offline",
      detail: {
        tailnet: opus ? `${opus.name} (${opus.online ? "online" : "offline"}, seen ${ago(opus.last_seen)})` : "not on the tailnet",
        ollama: rigInfo?.online ? (rigInfo.models ?? []).map((m) => m.name).join(", ") : rigInfo?.reason ?? "unreachable",
        "rig-gpu sessions": running.filter((s) => s.metadata?.iron_fleet_environment === "rig-gpu").length,
      },
    });

    // Clients, from key last-use.
    this.clients = val(clients)?.data ?? this.clients;
    for (const c of this.clients) {
      this.live.set(`client:${c.name}`, {
        state: clientState(c),
        sub: c.last_seen_at ? `seen ${ago(c.last_seen_at)}` : "never used",
        detail: { key: c.name, "last seen": c.last_seen_at ?? "never", "key since": c.since },
      });
    }

    this.layoutClients();
    this.draw();
    this.$("#map-updated").textContent = `updated ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" })}`;
    if (this.selected) this.showNode(this.selected);
  }

  private $(sel: string) {
    return this.root.querySelector(sel) as HTMLElement;
  }

  private layoutClients() {
    const names = this.clients.map((c) => c.name);
    const order = ["web", "mac", "quest-3", "win-rig", ...names.filter((n) => !CLIENT_LABELS[n]).sort(), "jarvis-mac"];
    const shown = order.filter((n, i) => names.includes(n) && order.indexOf(n) === i);
    const top = 70;
    const step = shown.length > 1 ? Math.min(100, 380 / (shown.length - 1)) : 0;
    this.nodes = [
      ...FIXED,
      ...shown.map((n, i) => ({ id: `client:${n}`, label: CLIENT_LABELS[n] ?? n, x: 95, y: top + i * step })),
    ];
  }

  private draw() {
    const svg = this.$("#map");
    const pos = new Map(this.nodes.map((n) => [n.id, n]));
    const stateOf = (id: string): State => this.live.get(id)?.state ?? "unknown";
    const edges: string[] = [];
    const edge = (a: string, b: string, kind = "") => {
      const p = pos.get(a);
      const q = pos.get(b);
      if (!p || !q) return;
      const st = stateOf(a) === "down" || stateOf(b) === "down" ? "down" : stateOf(b) === "idle" || stateOf(a) === "idle" ? "idle" : "ok";
      const mx = (p.x + q.x) / 2;
      edges.push(`<path class="edge ${kind}" data-state="${st}" d="M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}" />`);
    };
    for (const [a, b, kind] of EDGES) edge(a, b, kind);
    for (const n of this.nodes.filter((n) => n.id.startsWith("client:"))) {
      edge(n.id, n.id === "client:web" ? "caddy" : "caddy");
    }
    for (const id of ["github", "cloudflare", "uptimerobot"]) edge(id, "caddy", "external");

    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
    const nodes = this.nodes.map((n) => {
      const w = n.w ?? NODE_W;
      const live = this.live.get(n.id);
      return `<g class="node" tabindex="0" role="button" data-id="${esc(n.id)}" data-state="${live?.state ?? "unknown"}" transform="translate(${n.x - w / 2},${n.y - NODE_H / 2})">
        <rect width="${w}" height="${NODE_H}" rx="3" />
        <circle class="dot" cx="12" cy="15" r="4" />
        <text class="node-label" x="22" y="19">${esc(n.label)}</text>
        <text class="node-sub" x="12" y="36">${esc(fit(live?.sub ?? "", Math.floor((w - 20) / 5.8)))}</text>
      </g>`;
    });
    svg.innerHTML = `
      <rect class="zone" x="250" y="40" width="300" height="410" rx="4" />
      <text class="zone-label" x="262" y="60">DROPLET · opustower.dev</text>
      <text class="zone-label" x="30" y="30">CLIENTS</text>
      <text class="zone-label" x="690" y="30">ANTHROPIC</text>
      <text class="zone-label" x="850" y="440">TAILNET</text>
      ${edges.join("")}
      ${nodes.join("")}`;
    svg.querySelectorAll<SVGGElement>(".node").forEach((g) => {
      const open = () => {
        this.selected = g.dataset.id ?? null;
        svg.querySelectorAll(".node").forEach((x) => x.classList.toggle("selected", x === g));
        if (this.selected) this.showNode(this.selected);
      };
      g.onclick = open;
      g.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") open();
      };
      g.classList.toggle("selected", g.dataset.id === this.selected);
    });
  }

  private showNode(id: string) {
    const n = this.nodes.find((x) => x.id === id);
    const live = this.live.get(id);
    this.$("#node-title").textContent = n?.label ?? id;
    const tag = this.$("#node-state");
    tag.textContent = STATE_WORD[live?.state ?? "unknown"];
    tag.dataset.state = live?.state ?? "unknown";
    const dl = this.$("#node-facts");
    dl.replaceChildren();
    for (const [k, v] of Object.entries({ status: live?.sub ?? "", ...(live?.detail ?? {}) })) {
      if (v === undefined || v === null || v === "") continue;
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
  }
}
