// The conversation: one `jarvis` Managed Agents session per model, reused
// across page loads (its sandbox — cloned repos, a browser profile — lives
// as long as the session). Nothing here talks to Claude directly: turns are
// `/bff/v1/sessions*`, the reply arrives on the session's SSE stream, and
// custom tools declared here are answered from here.
//
// State in the browser is only a bookmark (session id + chosen model), as
// the Tauri app keeps one. The conversation itself is Anthropic's.

import { ApiError, get, post } from "../api";
import { TOOLS, runTool } from "./tools";
import type { Rendered, SessionEvent, Transcript } from "./transcript";

const SESSION_KEY = "jarvis.session";
const MODEL_KEY = "jarvis.model";

/** The web client's personality and context, appended to jarvis's prompt. */
const SYSTEM_SUFFIX = [
  "This session is the J.A.R.V.I.S. web HUD at jarvis.opustower.dev.",
  "The user is Mr. Walker (James), in Calabasas, California; use America/Los_Angeles for times and dates.",
  "Address him as Mr. Walker or sir, in the manner of the J.A.R.V.I.S. from the films: dry, courteous, quietly witty, never servile.",
  "Every reply is spoken aloud by a text-to-speech voice as soon as you send it, so: one to three short sentences unless he asks for detail,",
  "no markdown, no bullet points, no code unless he asks to see it, spell out symbols, and round numbers.",
  "Send one message per turn: say briefly what you are about to do only if it will take more than a few seconds.",
  "Use opus_status for anything about the state of his systems and fleet_usage for spend, rather than guessing.",
].join(" ");

export const MODELS: { id: string; label: string }[] = [
  { id: "", label: "Opus 5 · agent default" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
];

export type Phase = "idle" | "thinking" | "error";

export interface JarvisEvents {
  onPhase(phase: Phase, detail?: string): void;
  /** A finished reply to speak (never history). */
  onReply(text: string): void;
  onUsage(costCents: number | null, capCents: number | null): void;
  openPanel(tab: string): void;
  /** Every event of the conversation, for other views (the terminal). */
  onEvent?(e: SessionEvent, live: boolean): void;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the bookmark just doesn't survive a reload */
  }
}

export class Jarvis {
  private sessionId: string | null = load(SESSION_KEY);
  private modelId: string = load(MODEL_KEY) ?? "";
  private stream: EventSource | null = null;
  /** Replies that existed before this page started listening: never spoken. */
  private readonly silent = new Set<string>();
  private readonly answered = new Set<string>();
  private busy = false;
  /** A terminal command is running: its reply is shown, never spoken. */
  private silentTurn = false;

  constructor(
    private readonly transcript: Transcript,
    private readonly ev: JarvisEvents,
  ) {}

  get model(): string {
    return this.modelId;
  }

  get session(): string | null {
    return this.sessionId;
  }

  /** On unlock: reattach to the last session, if it is still usable. */
  async resume() {
    if (!this.sessionId) return;
    try {
      const s = await get<{ status?: string }>(`sessions/${this.sessionId}`);
      if (s.status === "terminated") throw new Error("terminated");
      await this.attach(true);
    } catch {
      this.forget();
    }
  }

  /** New conversation on another model (the model is fixed per session). */
  setModel(id: string) {
    if (id === this.modelId) return;
    this.modelId = id;
    save(MODEL_KEY, id || null);
    const label = MODELS.find((m) => m.id === id)?.label ?? id;
    this.forget();
    this.transcript.divider(`new conversation · ${label}`);
  }

  newConversation() {
    this.forget();
    this.transcript.divider("new conversation");
  }

  async ask(text: string, opts: { silent?: boolean } = {}) {
    const task = text.trim();
    if (!task) return;
    this.busy = true;
    this.silentTurn = !!opts.silent;
    this.ev.onPhase("thinking", task);
    try {
      if (this.sessionId) {
        try {
          await post(`sessions/${this.sessionId}/events`, { task });
          return;
        } catch (e) {
          // A session that can no longer take messages: start afresh below.
          if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 409 && e.status !== 400)) throw e;
          this.forget();
          this.transcript.divider("previous session ended · new conversation");
        }
      }
      const created = await post<{ session_id: string }>("sessions", {
        agent_slug: "jarvis",
        task,
        client: "web",
        system_suffix: SYSTEM_SUFFIX,
        tools: TOOLS,
        ...(this.modelId ? { model: this.modelId } : {}),
      });
      this.sessionId = created.session_id;
      save(SESSION_KEY, this.sessionId);
      await this.attach(false);
    } catch (e) {
      this.busy = false;
      const msg = e instanceof ApiError ? e.message : "cannot reach the tower";
      this.transcript.note(`could not send: ${msg}`, true);
      this.ev.onPhase("error", msg);
    }
  }

  async interrupt() {
    if (!this.sessionId || !this.busy) return;
    await post(`sessions/${this.sessionId}/interrupt`).catch(() => undefined);
  }

  detach() {
    this.stream?.close();
    this.stream = null;
  }

  private forget() {
    this.detach();
    this.sessionId = null;
    this.busy = false;
    save(SESSION_KEY, null);
  }

  /**
   * Open the live stream, then fill in history (the stream only carries
   * events emitted after it opened; the transcript de-dupes on event id).
   * `quiet`: everything already in the history is shown but not spoken.
   */
  private async attach(quiet: boolean) {
    const id = this.sessionId;
    if (!id) return;
    this.detach();
    const es = new EventSource(`/bff/v1/sessions/${id}/stream?event_deltas=agent.message`);
    this.stream = es;
    es.onmessage = (m) => {
      if (this.sessionId !== id) return;
      try {
        this.handle(JSON.parse(m.data) as SessionEvent, true);
      } catch {
        /* keep-alive or a frame we don't model */
      }
    };
    await new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, 3000);
      es.onopen = () => {
        window.clearTimeout(t);
        resolve();
      };
    });
    const page = await get<{ data?: SessionEvent[] }>(`sessions/${id}/events?limit=100&order=desc`).catch(() => ({
      data: [],
    }));
    const history = (page.data ?? []).slice().reverse();
    for (const e of history) {
      if (quiet && e.type === "agent.message" && e.id) this.silent.add(e.id);
      // Tool calls answered earlier (by this page before a reload) stay
      // answered; one left hanging when the page closed is answered now.
      if (e.type === "user.custom_tool_result" && e.custom_tool_use_id) this.answered.add(e.custom_tool_use_id);
    }
    for (const e of history) this.handle(e, !quiet);
  }

  /**
   * `live`: the event happened while this page was listening, so it may
   * speak, flip the orb or end the session. Replayed history only renders —
   * except a tool call nobody answered, which is answered now.
   */
  private handle(e: SessionEvent, live = true) {
    const fresh = !this.transcript.has(e.id);
    const r: Rendered = this.transcript.render(e);
    if (fresh) this.ev.onEvent?.(e, live);
    if (!live) {
      if (r.kind === "custom_tool") void this.answer(r.id, r.name, r.input);
      return;
    }
    switch (r.kind) {
      case "agent_message":
        if (r.id && this.silent.has(r.id)) break;
        if (this.silentTurn) break;
        if (r.text.trim()) this.ev.onReply(r.text);
        break;
      case "custom_tool":
        void this.answer(r.id, r.name, r.input);
        break;
      case "running":
        this.busy = true;
        this.ev.onPhase("thinking");
        break;
      case "idle":
        if (r.stop_reason === "requires_action") break; // our tool answer is on its way
        this.busy = false;
        this.silentTurn = false;
        if (r.stop_reason === "budget_reached") {
          this.ev.onReply("This conversation has reached its budget, sir. I'll start a fresh one next time you ask.");
          this.forget();
        }
        this.ev.onPhase("idle");
        break;
      case "error":
        this.busy = false;
        if (r.type === "billing_error") {
          this.ev.onReply("I'm afraid the Anthropic account is out of credit, sir. I can't think until it's topped up.");
        }
        this.ev.onPhase("error", r.message);
        break;
      case "usage":
        this.ev.onUsage(r.costCents, r.capCents);
        break;
    }
  }

  private async answer(toolUseId: string, name: string, input: unknown) {
    if (!toolUseId || this.answered.has(toolUseId) || !this.sessionId) return;
    this.answered.add(toolUseId);
    const result = await runTool(name, input, { openPanel: (t) => this.ev.openPanel(t) });
    await post(`sessions/${this.sessionId}/tool-results`, {
      results: [{ custom_tool_use_id: toolUseId, content: result.content, ...(result.is_error ? { is_error: true } : {}) }],
    }).catch((e) => this.transcript.note(`tool result not delivered: ${String(e)}`, true));
  }
}
