// The conversation: one `jarvis` Managed Agents session per model, reused
// across page loads (its sandbox — cloned repos, a browser profile — lives
// as long as the session). Nothing here talks to Claude directly: turns are
// `/bff/v1/sessions*`, the reply arrives on the session's SSE stream, and
// custom tools declared here are answered from here.
//
// State in the browser is only a bookmark (session id + chosen model), as
// the Tauri app keeps one. The conversation itself is Anthropic's.

import { ApiError, get, post, type Profile } from "../api";
import type { Job } from "./jobs";
import { whereLine } from "./location";
import type { Route } from "./route";
import { runTool, toolsFor } from "./tools";
import type { OutputFile, Rendered, SessionEvent, Transcript } from "./transcript";

/** Where this browser keeps a profile's bookmark. Mr. Walker's keys are the
 * ones from before profiles, so his conversation carries on. */
const storageKey = (profile: Profile, what: "session" | "model" | "where") =>
  profile.full ? `jarvis.${what}` : `jarvis.${profile.id}.${what}`;

/** Marks the line that tells a running conversation he has moved. */
export const WHERE_TAG = "[location]";
/** Marks the line that tells a conversation which project it is working on. */
export const PROJECT_TAG = "[project]";

/** The line that starts work on a Jarvis project in its conversation. */
export function projectNote(p: { name: string; description?: string }): string {
  const about = p.description?.trim() ? `: ${p.description.trim()}` : "";
  return `${PROJECT_TAG} Working on "${p.name}"${about}. Save its files to /mnt/session/outputs/.`;
}

/** The web client's personality and context, appended to the agent's prompt.
 * `where`: the sentence saying where he is (`location.whereLine`). */
export function systemSuffix(profile: Profile, where = whereLine()): string {
  const located = [
    where,
    `When he says he is somewhere else, call set_location. A line beginning ${WHERE_TAG} in his message is the HUD saying where he is now; it replaces what you knew, and needs no reply of its own.`,
  ];
  const shared = [
    "This session is the J.A.R.V.I.S. web HUD at jarvis.opustower.dev.",
    "Every reply is spoken aloud by a text-to-speech voice as soon as you send it, so: one to three short sentences unless he asks for detail,",
    "no markdown, no bullet points, no code unless he asks to see it, spell out symbols, and round numbers.",
    "Send one message per turn: say briefly what you are about to do only if it will take more than a few seconds.",
    `A line beginning ${PROJECT_TAG} in his message names the project this conversation is working on: keep its files (code, docs as .md, 3D models as .glb or .stl) in /mnt/session/outputs/ so they appear in his Projects tab; the line needs no reply of its own.`,
  ];
  if (profile.full) {
    return [
      shared[0],
      "The user is Mr. Walker (James).",
      ...located,
      "Address him as Mr. Walker or sir, in the manner of the J.A.R.V.I.S. from the films: dry, courteous, quietly witty, never servile.",
      ...shared.slice(1),
      "Use opus_status for anything about the state of his systems and fleet_usage for spend, rather than guessing.",
      "Use fleet_jobs to find the jobs you dispatched; the HUD announces when one finishes or has a question.",
      "Use briefing for his day (weather, calendar, email, YouTube, WHOOP, Buffer) and set_reminder when he asks to be reminded.",
      "Use intel_feed for what is happening in the news and natural hazards right now, in the US and the world (the Intel tab's live feeds).",
      "A message beginning [intel] comes from the Intel tab: its reply is shown there, not spoken, so follow that message's format instead.",
      "To reverse-engineer an app, binary, package or website, use REA in your sandbox (the rea-agents npm package, CLI `rea`; static analysis only, never run the target).",
      "A message beginning [rea] comes from the Reverse tab: likewise shown there, not spoken, so follow its format.",
    ].join(" ");
  }
  return [
    shared[0],
    `The user is ${profile.name}.`,
    ...located,
    `Address him as ${profile.name} or sir, in the manner of the J.A.R.V.I.S. from the films: dry, courteous, quietly witty, never servile.`,
    ...shared.slice(1),
    "Use fleet_usage for what his sessions have cost, rather than guessing, and set_reminder when he asks to be reminded.",
  ].join(" ");
}

export const MODELS: { id: string; label: string }[] = [
  { id: "", label: "Opus 5 · agent default" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
];

/** Picks no longer offered → their successor, so nobody is left on a hidden option. */
const RETIRED: Record<string, string> = {
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001": "claude-haiku-5-5",
};
export const currentModel = (id: string) => RETIRED[id] ?? id;

export type Phase = "idle" | "thinking" | "error";

export interface JarvisEvents {
  onPhase(phase: Phase, detail?: string): void;
  /** A finished reply to speak (never history). */
  onReply(text: string): void;
  onUsage(costCents: number | null, capCents: number | null): void;
  /** This session hit Anthropic's billing error (credit exhausted). */
  onBillingError?(): void;
  openPanel(tab: string): void;
  /** `show_route`: hand a route to Apple Maps (a tappable link) or the globe. */
  showRoute(route: Route, where: "apple_maps" | "here"): void;
  /** `project_open`: the Projects tab on a project; false when there's none. */
  openProject(name: string): Promise<boolean>;
  /** `project_continue`: back into a Jarvis project's conversation. */
  continueProject(name: string): Promise<"continued" | "repo" | "none">;
  /** The jobs this HUD is watching (for the `fleet_jobs` tool). */
  jobs(): Job[];
  /** Every event of the conversation, for other views (the terminal). */
  onEvent?(e: SessionEvent, live: boolean): void;
  /** A reply in a silent turn (shown, not spoken), with the turn's tag. */
  onSilentReply?(text: string, tag: string): void;
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
  private sessionId: string | null;
  private modelId: string;
  private stream: EventSource | null = null;
  /** Replies that existed before this page started listening: never spoken. */
  private readonly silent = new Set<string>();
  private readonly answered = new Set<string>();
  private busy = false;
  /** `projectNote` for the next spoken message, after `continueProject`. */
  private pendingProject: string | null = null;
  /** Ties a project to the conversation its next message starts. */
  private onNewSession: ((id: string) => void) | null = null;
  /** A terminal command or Intel brief is running: its reply is shown, never spoken. */
  private silentTurn = false;
  /** Who asked for the silent turn ("terminal", "intel"). */
  private turnTag = "";

  constructor(
    private readonly transcript: Transcript,
    private readonly ev: JarvisEvents,
    private readonly profile: Profile,
  ) {
    this.sessionId = load(storageKey(profile, "session"));
    const stored = load(storageKey(profile, "model")) ?? "";
    this.modelId = currentModel(stored);
    if (this.modelId !== stored) {
      // The old session is on the retired model: the next message starts one on its successor.
      save(storageKey(profile, "model"), this.modelId);
      save(storageKey(profile, "session"), null);
      this.sessionId = null;
    }
  }

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
    save(storageKey(this.profile, "model"), id || null);
    const label = MODELS.find((m) => m.id === id)?.label ?? id;
    this.leaveProject();
    this.forget();
    this.transcript.divider(`new conversation · ${label}`);
  }

  newConversation() {
    this.leaveProject();
    this.forget();
    this.transcript.divider("new conversation");
  }

  /**
   * Work on a Jarvis project: back into its conversation if that is still
   * open (its history shown, not spoken), else a fresh one that `onSession`
   * ties to the project once it exists. The next spoken message tells
   * Jarvis which project it is.
   */
  async continueProject(p: { name: string; description: string; session_id: string | null }, onSession: (id: string) => void) {
    this.leaveProject();
    this.pendingProject = projectNote(p);
    this.transcript.clear();
    if (p.session_id) {
      const alive = await get<{ status?: string }>(`sessions/${encodeURIComponent(p.session_id)}`)
        .then((s) => s.status !== "terminated")
        .catch(() => false);
      if (alive) {
        this.forget();
        this.sessionId = p.session_id;
        save(storageKey(this.profile, "session"), this.sessionId);
        this.transcript.divider(`project · ${p.name}`);
        await this.attach(true);
        return;
      }
    }
    this.forget();
    this.onNewSession = onSession;
    this.transcript.divider(`project · ${p.name} · new conversation`);
  }

  private leaveProject() {
    this.pendingProject = null;
    this.onNewSession = null;
  }

  /**
   * `attachments`: ids from `/files` (the chat's tray). A message may be
   * files alone; the control plane then supplies the words.
   */
  async ask(text: string, opts: { silent?: boolean; tag?: string; attachments?: string[] } = {}) {
    let task = text.trim();
    const attachments = opts.attachments ?? [];
    if (!task && !attachments.length) return;
    const files = attachments.length ? { attachments } : {};
    this.busy = true;
    this.silentTurn = !!opts.silent;
    this.turnTag = opts.tag ?? "";
    this.ev.onPhase("thinking", task || "looking at the attached files");
    try {
      const where = whereLine();
      // The project line rides on the next spoken message only.
      const project = !opts.silent ? this.pendingProject : null;
      if (project) task = `${task}\n${project}`.trim();
      if (this.sessionId) {
        // A spoken turn tells a conversation that started elsewhere (or before
        // the HUD knew) where he is now.
        const moved = !opts.silent && load(storageKey(this.profile, "where")) !== where;
        try {
          await post(`sessions/${this.sessionId}/events`, { task: moved ? `${task}\n${WHERE_TAG} ${where}` : task, ...files });
          if (moved) save(storageKey(this.profile, "where"), where);
          if (project) this.pendingProject = null;
          return;
        } catch (e) {
          // A session that can no longer take messages: start afresh below.
          if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 409 && e.status !== 400)) throw e;
          this.forget();
          this.transcript.divider("previous session ended · new conversation");
        }
      }
      const created = await post<{ session_id: string }>("sessions", {
        agent_slug: this.profile.agent,
        task,
        client: "web",
        system_suffix: systemSuffix(this.profile, where),
        tools: toolsFor(this.profile.full),
        ...files,
        ...(this.modelId ? { model: this.modelId } : {}),
      });
      this.sessionId = created.session_id;
      save(storageKey(this.profile, "session"), this.sessionId);
      if (project) this.pendingProject = null;
      this.onNewSession?.(created.session_id);
      this.onNewSession = null;
      save(storageKey(this.profile, "where"), where);
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
    save(storageKey(this.profile, "session"), null);
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
    void this.outputs(id);
  }

  /**
   * Files the agent wrote to /mnt/session/outputs/ appear in the Files API
   * shortly after it writes them — sometimes a few seconds after the turn
   * ends — so look at the end of a turn and once more a little later.
   */
  private async outputs(id: string, again = false) {
    const page = await get<{ data?: OutputFile[] }>(`sessions/${id}/files`).catch(() => null);
    if (this.sessionId !== id) return;
    if (page?.data) this.transcript.outputs(page.data, id);
    if (again) window.setTimeout(() => void this.outputs(id), 4000);
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
        if (this.silentTurn) {
          if (r.text.trim()) this.ev.onSilentReply?.(r.text, this.turnTag);
          break;
        }
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
        this.turnTag = "";
        if (this.sessionId) void this.outputs(this.sessionId, true);
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
          this.ev.onBillingError?.();
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
    // The conversation that asked: a tool (project_continue) may switch away.
    const asked = this.sessionId;
    const result = await runTool(name, input, {
      openPanel: (t) => this.ev.openPanel(t),
      showRoute: (r, w) => this.ev.showRoute(r, w),
      openProject: (n) => this.ev.openProject(n),
      continueProject: (n) => this.ev.continueProject(n),
      session: this.sessionId,
      jobs: () => this.ev.jobs(),
      full: this.profile.full,
    });
    // He told this conversation himself; no need to tell it again.
    if (name === "set_location" && !result.is_error) save(storageKey(this.profile, "where"), whereLine());
    await post(`sessions/${asked}/tool-results`, {
      results: [{ custom_tool_use_id: toolUseId, content: result.content, ...(result.is_error ? { is_error: true } : {}) }],
    }).catch((e) => this.transcript.note(`tool result not delivered: ${String(e)}`, true));
  }
}
