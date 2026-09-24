// The Fleet tab: every agent and session, with the controls the Tauri app
// has — start a session, send it a message, interrupt it — over the same
// /v1 routes. Sessions and their history are Anthropic's; this view holds
// only which one is selected.

import { ApiError, get, post } from "../api";
import { Transcript, type SessionEvent } from "./transcript";

interface Agent {
  slug: string;
  max_list_cost_cents: string;
  effort: string;
  default_environment: string;
  agent_version: number;
}

interface Session {
  id: string;
  status: string;
  title?: string;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, string>;
  usage?: { list_cost?: { amount: string } };
  budget?: { max_list_cost?: { amount: string } };
}

/** Environments an agent may be pointed at from here. */
const ENVIRONMENTS = ["cloud-default", "jarvis-lab", "blueweb-web", "rig-gpu"];

const dollars = (c?: string) => (c && /^\d+$/.test(c) ? `$${(Number(c) / 100).toFixed(2)}` : "—");

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class FleetView {
  private agents: Agent[] = [];
  private filter = "";
  private selected: string | null = null;
  private stream: EventSource | null = null;
  private transcript: Transcript;
  private timer: number | undefined;
  private readonly $ = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="fleet">
        <section class="panel fleet-agents">
          <header class="panel-head"><span class="panel-title">Agents</span><span class="panel-tag" id="fleet-agent-count"></span></header>
          <div class="panel-body"><ul class="agent-list" id="agent-list"></ul></div>
          <form class="start" id="start-form" hidden>
            <div class="start-head"><span class="panel-title" id="start-title"></span><button type="button" class="btn-ghost" id="start-cancel">Cancel</button></div>
            <textarea id="start-task" rows="4" placeholder="What should it do?" required></textarea>
            <div class="start-row">
              <label class="select-wrap"><span class="sr-only">Environment</span><select id="start-env"></select></label>
              <button class="btn-primary btn-small" type="submit">Start</button>
            </div>
            <p class="start-status" id="start-status"></p>
          </form>
        </section>
        <section class="panel fleet-sessions">
          <header class="panel-head">
            <span class="panel-title">Sessions</span>
            <label class="select-wrap"><span class="sr-only">Agent</span><select id="session-filter"><option value="">all agents</option></select></label>
          </header>
          <div class="panel-body"><ul class="session-list" id="session-list"><li class="panel-empty">Loading…</li></ul></div>
        </section>
        <section class="panel fleet-detail">
          <header class="panel-head">
            <span class="panel-title" id="detail-title">Select a session</span>
            <span class="detail-actions">
              <span class="panel-tag" id="detail-meta"></span>
              <button class="btn-ghost" id="detail-interrupt" hidden>Interrupt</button>
            </span>
          </header>
          <div class="transcript detail-transcript" id="detail-transcript"></div>
          <form class="ask" id="detail-form" hidden>
            <input id="detail-input" autocomplete="off" placeholder="Message this session" aria-label="Message this session" />
            <button class="btn-primary btn-small" type="submit">Send</button>
          </form>
        </section>
      </div>`;
    this.transcript = new Transcript(this.$("#detail-transcript"));
    this.$<HTMLSelectElement>("#session-filter").onchange = (e) => {
      this.filter = (e.target as HTMLSelectElement).value;
      void this.refreshSessions();
    };
    this.$<HTMLButtonElement>("#start-cancel").onclick = () => (this.$<HTMLFormElement>("#start-form").hidden = true);
    this.$<HTMLFormElement>("#start-form").onsubmit = (e) => {
      e.preventDefault();
      void this.start();
    };
    this.$<HTMLFormElement>("#detail-form").onsubmit = (e) => {
      e.preventDefault();
      void this.send();
    };
    this.$<HTMLButtonElement>("#detail-interrupt").onclick = () => void this.interrupt();
  }

  /** The tab became visible: load, and poll the list while shown. */
  show() {
    void this.refreshAgents();
    void this.refreshSessions();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.refreshSessions(), 15_000);
  }

  hide() {
    window.clearInterval(this.timer);
  }

  dispose() {
    this.hide();
    this.stream?.close();
  }

  // ---- agents ---------------------------------------------------------------

  private async refreshAgents() {
    try {
      this.agents = (await get<{ data: Agent[] }>("fleet/agents")).data;
    } catch {
      return;
    }
    const list = this.$<HTMLUListElement>("#agent-list");
    list.replaceChildren(
      ...this.agents.map((a) => {
        const li = el("li", "agent");
        const name = el("div", "agent-name", a.slug);
        const meta = el("div", "agent-meta", `${dollars(a.max_list_cost_cents)} cap · ${a.effort} · ${a.default_environment} · v${a.agent_version}`);
        const btn = el("button", "btn-ghost", "Start") as HTMLButtonElement;
        btn.onclick = () => this.openStart(a);
        li.append(el("div", "agent-text"), btn);
        (li.firstChild as HTMLElement).append(name, meta);
        return li;
      }),
    );
    this.$("#fleet-agent-count").textContent = `${this.agents.length}`;
    const filter = this.$<HTMLSelectElement>("#session-filter");
    const keep = filter.value;
    filter.replaceChildren(el("option", undefined, "all agents"), ...this.agents.map((a) => el("option", undefined, a.slug)));
    (filter.options[0] as HTMLOptionElement).value = "";
    filter.value = keep;
  }

  private openStart(a: Agent) {
    const form = this.$<HTMLFormElement>("#start-form");
    form.hidden = false;
    form.dataset.slug = a.slug;
    this.$("#start-title").textContent = `Start ${a.slug}`;
    const env = this.$<HTMLSelectElement>("#start-env");
    env.replaceChildren(
      ...[a.default_environment, ...ENVIRONMENTS.filter((e) => e !== a.default_environment)].map((e, i) => {
        const o = el("option", undefined, i === 0 ? `${e} (default)` : e) as HTMLOptionElement;
        o.value = i === 0 ? "" : e;
        return o;
      }),
    );
    this.$("#start-status").textContent = a.default_environment === "rig-gpu" ? "Runs on the rig; queues while it's off." : "";
    this.$<HTMLTextAreaElement>("#start-task").focus();
  }

  private async start() {
    const form = this.$<HTMLFormElement>("#start-form");
    const task = this.$<HTMLTextAreaElement>("#start-task").value.trim();
    const environment = this.$<HTMLSelectElement>("#start-env").value;
    const status = this.$("#start-status");
    if (!task) return;
    status.textContent = "Starting…";
    try {
      const created = await post<{ session_id: string }>("sessions", {
        agent_slug: form.dataset.slug,
        task,
        client: "web",
        ...(environment ? { environment } : {}),
      });
      this.$<HTMLTextAreaElement>("#start-task").value = "";
      form.hidden = true;
      status.textContent = "";
      await this.refreshSessions();
      this.select(created.session_id);
    } catch (e) {
      status.textContent = e instanceof ApiError ? e.message : "Could not start";
    }
  }

  // ---- sessions -------------------------------------------------------------

  private async refreshSessions() {
    const q = this.filter ? `&agent_slug=${encodeURIComponent(this.filter)}` : "";
    let sessions: Session[];
    try {
      sessions = (await get<{ data: Session[] }>(`sessions?limit=30&order=desc${q}`)).data;
    } catch {
      return;
    }
    const list = this.$<HTMLUListElement>("#session-list");
    if (!sessions.length) {
      list.innerHTML = `<li class="panel-empty">No sessions</li>`;
      return;
    }
    list.replaceChildren(
      ...sessions.map((s) => {
        const li = el("li", "session");
        li.dataset.status = s.status;
        li.dataset.id = s.id;
        li.classList.toggle("selected", s.id === this.selected);
        const agent = s.metadata?.iron_fleet_agent ?? "?";
        const client = s.metadata?.iron_fleet_client;
        li.append(
          el("div", "session-title", s.title || s.id),
          el(
            "div",
            "session-meta",
            [agent, client && `via ${client}`, s.status, `${dollars(s.usage?.list_cost?.amount)} / ${dollars(s.budget?.max_list_cost?.amount)}`, ago(s.updated_at ?? s.created_at)]
              .filter(Boolean)
              .join(" · "),
          ),
        );
        li.onclick = () => this.select(s.id);
        return li;
      }),
    );
  }

  private select(id: string) {
    if (this.selected === id) return;
    this.selected = id;
    this.stream?.close();
    this.transcript.clear();
    this.root.querySelectorAll(".session").forEach((n) => n.classList.toggle("selected", (n as HTMLElement).dataset.id === id));
    this.$("#detail-title").textContent = id;
    this.$<HTMLFormElement>("#detail-form").hidden = false;
    void this.load(id);
  }

  private async load(id: string) {
    const es = new EventSource(`/bff/v1/sessions/${id}/stream?event_deltas=agent.message`);
    this.stream = es;
    es.onmessage = (m) => {
      if (this.selected !== id) return;
      try {
        this.onEvent(JSON.parse(m.data) as SessionEvent);
      } catch {
        /* keep-alive */
      }
    };
    try {
      const s = await get<Session>(`sessions/${id}`);
      this.$("#detail-title").textContent = s.title || id;
      this.renderMeta(s);
      const page = await get<{ data?: SessionEvent[] }>(`sessions/${id}/events?limit=100&order=desc`);
      for (const e of (page.data ?? []).slice().reverse()) this.onEvent(e);
    } catch (e) {
      this.transcript.note(`could not load: ${e instanceof ApiError ? e.message : String(e)}`, true);
    }
  }

  private renderMeta(s: Session) {
    this.$("#detail-meta").textContent = `${s.status} · ${dollars(s.usage?.list_cost?.amount)} of ${dollars(s.budget?.max_list_cost?.amount)}`;
    this.$<HTMLButtonElement>("#detail-interrupt").hidden = s.status !== "running";
  }

  private onEvent(e: SessionEvent) {
    const r = this.transcript.render(e);
    if (r.kind === "running") this.$<HTMLButtonElement>("#detail-interrupt").hidden = false;
    if (r.kind === "idle" || r.kind === "error") this.$<HTMLButtonElement>("#detail-interrupt").hidden = true;
  }

  private async send() {
    const input = this.$<HTMLInputElement>("#detail-input");
    const task = input.value.trim();
    if (!task || !this.selected) return;
    input.value = "";
    try {
      await post(`sessions/${this.selected}/events`, { task });
    } catch (e) {
      this.transcript.note(`not sent: ${e instanceof ApiError ? e.message : String(e)}`, true);
    }
  }

  private async interrupt() {
    if (!this.selected) return;
    await post(`sessions/${this.selected}/interrupt`).catch(() => undefined);
  }
}
