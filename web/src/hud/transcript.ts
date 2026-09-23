// A session's events as a chat transcript, in the dock's drawer. Ported from
// Iron-Fleet app/src/transcript.ts: same event mapping, and `render` returns
// what an event meant so the caller can react (speak, flip the orb) without
// re-parsing it. Token previews (`event_start`/`event_delta`) stream into a
// placeholder that the persisted `agent.message` replaces.

export interface MoneyAmount {
  amount: string;
  currency: string;
}

export interface SessionEvent {
  type: string;
  id?: string;
  content?: ContentBlock[];
  name?: string;
  input?: unknown;
  stop_reason?: { type: string; event_ids?: string[] };
  error?: { message?: string; type?: string };
  usage?: { list_cost?: MoneyAmount };
  budget?: { max_list_cost?: MoneyAmount } | null;
  event?: { type: string; id: string };
  event_id?: string;
  delta?: { type: string; index: number; content?: ContentBlock };
  /** On `user.custom_tool_result`: which tool call it answers. */
  custom_tool_use_id?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
}

export type Rendered =
  | { kind: "user_message"; text: string }
  | { kind: "agent_message"; id?: string; text: string }
  | { kind: "custom_tool"; id: string; name: string; input: unknown }
  | { kind: "tool" }
  | { kind: "running" }
  | { kind: "idle"; stop_reason: string }
  | { kind: "error"; message: string; type?: string }
  | { kind: "usage"; costCents: number | null; capCents: number | null }
  | { kind: "other" };

export function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

const truncate = (v: string, max: number) => (v.length > max ? `${v.slice(0, max)}…` : v);
const cents = (m?: MoneyAmount | null) => (m?.amount && /^\d+$/.test(m.amount) ? Number(m.amount) : null);

export class Transcript {
  private readonly seen = new Set<string>();

  constructor(private readonly list: HTMLElement) {}

  clear() {
    this.list.innerHTML = "";
    this.seen.clear();
  }

  has(id: string | undefined): boolean {
    return !!id && this.seen.has(id);
  }

  /** A visual break: new session, model switch. */
  divider(text: string) {
    this.append("entry-divider", text);
    this.scroll(true);
  }

  note(text: string, alert = false) {
    this.append(`entry-system${alert ? " alert" : ""}`, text);
    this.scroll(true);
  }

  render(ev: SessionEvent): Rendered {
    if (ev.id) {
      if (this.seen.has(ev.id)) return { kind: "other" };
      if (ev.type !== "event_start" && ev.type !== "event_delta") this.seen.add(ev.id);
    }
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
    let out: Rendered = { kind: "other" };
    switch (ev.type) {
      case "user.message": {
        const text = textOf(ev.content);
        this.append("entry-user", text, ev.id);
        out = { kind: "user_message", text };
        break;
      }
      case "user.interrupt":
        this.append("entry-system", "interrupted", ev.id);
        break;
      case "agent.message": {
        this.pending(ev.id)?.remove();
        const text = textOf(ev.content);
        this.append("entry-agent", text, ev.id);
        out = { kind: "agent_message", id: ev.id, text };
        break;
      }
      case "event_start":
        if (ev.event?.type === "agent.message" && ev.event.id) this.pendingBubble(ev.event.id);
        break;
      case "event_delta":
        if (ev.event_id && ev.delta?.content?.type === "text" && ev.delta.content.text) {
          this.pendingBubble(ev.event_id).textContent += ev.delta.content.text;
        }
        break;
      case "agent.custom_tool_use":
        this.tool(`⚙ ${ev.name} ${truncate(JSON.stringify(ev.input ?? {}), 100)}`, "");
        out = { kind: "custom_tool", id: ev.id ?? "", name: ev.name ?? "", input: ev.input };
        break;
      case "agent.tool_use":
      case "agent.mcp_tool_use": {
        const input = ev.input === undefined ? "" : JSON.stringify(ev.input, null, 1);
        this.tool(`⚙ ${ev.name ?? ev.type} ${truncate(input.replace(/\s+/g, " "), 110)}`, input);
        out = { kind: "tool" };
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        const t = textOf(ev.content);
        this.tool(`↳ ${truncate(t.replace(/\s+/g, " "), 110)}`, t);
        out = { kind: "tool" };
        break;
      }
      case "session.status_running":
        out = { kind: "running" };
        break;
      case "session.status_idle": {
        const reason = ev.stop_reason?.type ?? "idle";
        if (reason === "budget_reached") this.append("entry-system alert", "session budget reached", ev.id);
        out = { kind: "idle", stop_reason: reason };
        break;
      }
      case "session.status_error":
      case "session.error": {
        const message = ev.error?.message ?? ev.type;
        this.append("entry-system alert", `error: ${message}`, ev.id);
        out = { kind: "error", message, type: ev.error?.type };
        break;
      }
      case "session.usage":
        out = { kind: "usage", costCents: cents(ev.usage?.list_cost), capCents: cents(ev.budget?.max_list_cost) };
        break;
      default:
        break; // spans, thinking, thread lifecycle: not for this view
    }
    this.scroll(atBottom);
    return out;
  }

  private scroll(force: boolean) {
    if (force) this.list.scrollTop = this.list.scrollHeight;
  }

  private append(className: string, text: string, id?: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `entry ${className}`;
    div.textContent = text;
    if (id) div.dataset.eventId = id;
    this.list.appendChild(div);
    return div;
  }

  private tool(summary: string, detail: string) {
    const d = document.createElement("details");
    d.className = "entry entry-tool";
    const s = document.createElement("summary");
    s.textContent = summary;
    d.appendChild(s);
    if (detail) {
      const pre = document.createElement("pre");
      pre.textContent = truncate(detail, 4000);
      d.appendChild(pre);
    }
    this.list.appendChild(d);
  }

  private pending(id?: string): HTMLDivElement | null {
    if (!id) return null;
    return this.list.querySelector<HTMLDivElement>(`.entry.pending[data-event-id="${CSS.escape(id)}"]`);
  }

  private pendingBubble(eventId: string): HTMLDivElement {
    return this.pending(eventId) ?? this.append("entry-agent pending", "", eventId);
  }
}
