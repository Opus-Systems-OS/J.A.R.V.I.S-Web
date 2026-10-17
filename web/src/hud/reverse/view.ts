// The Reverse tab: point Jarvis at something (a file, a link, a path in his
// sandbox), ask how it works, and he investigates it with REA in his cloud
// sandbox. Target on the left, the report in the middle, the run's live
// shell activity and recent runs on the right. A run is one silent `[rea]`
// turn on the conversation; its report renders here and its first line is
// spoken. Uploads go through `/bff/v1/files` like the chat's paperclip.
//
// Everything from Jarvis and the sandbox goes in with textContent; the
// skeleton is the only markup, and it goes through `html`.

import { html, setHtml } from "../../html";
import { Attachments, MAX_BYTES } from "../attach";
import { leadLine, renderBrief } from "../brief";
import { ago } from "../fleet";
import type { OutputFile, SessionEvent } from "../transcript";
import {
  doctorTask,
  followupTask,
  forget,
  isReaCommand,
  isRunOutput,
  loadHistory,
  problem,
  reaTask,
  remember,
  reportFilename,
  runId,
  targetLabel,
  toMarkdown,
  workflow,
  WORKFLOWS,
  type Run,
  type RunSpec,
  type TargetKind,
} from "./model";

/** A run gives up waiting after this long (Jarvis may still finish it). */
const RUN_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_LINES = 400;
const MAX_RESULT = 4_000;
const NOTE = "Runs in Jarvis's cloud sandbox with REA, static analysis only, on his conversation's budget.";

export interface ReverseHost {
  /** Ask Jarvis on the conversation, silently; resolves with his reply ("" on failure). */
  investigate(prompt: string, attachments: string[]): Promise<string>;
  /** Interrupt the turn in flight. */
  stop(): void;
  /** Say a line aloud (only the HUD with the mic speaks). */
  speak(text: string): void;
  /** The conversation's session, for the run's evidence files. */
  sessionId(): string | null;
  /** That session's output files. */
  outputs(sessionId: string): Promise<OutputFile[]>;
}

const KINDS: { id: TargetKind; label: string }[] = [
  { id: "upload", label: "File" },
  { id: "url", label: "Link" },
  { id: "path", label: "Sandbox" },
];

const SKELETON = html`
  <div class="rea">
    <section class="panel rea-target">
      <header class="panel-head"><span class="panel-title">Target</span><button class="btn-ghost btn-tiny" id="rea-doctor" type="button" title="Ask Jarvis whether REA is ready in his sandbox">Check sandbox</button></header>
      <form class="rea-form" id="rea-form" novalidate>
        <div class="rea-kinds" role="radiogroup" aria-label="Target">
          ${KINDS.map((k, i) => html`<button type="button" class="rea-kind" role="radio" data-kind="${k.id}" aria-checked="${i === 0}">${k.label}</button>`)}
        </div>
        <div class="rea-field" data-for="upload">
          <button type="button" class="rea-drop" id="rea-drop">
            <span class="rea-drop-title">Drop a file or choose one</span>
            <span class="rea-drop-sub">An app, archive, binary, assembly, APK or database · up to ${MAX_BYTES / 1024 / 1024} MB · larger: use a link</span>
          </button>
          <input id="rea-files" type="file" multiple hidden />
          <div class="ask-tray rea-tray" id="rea-tray" aria-label="Files to investigate" hidden></div>
        </div>
        <label class="rea-field" data-for="url" hidden>
          <span class="rea-label">Link</span>
          <input id="rea-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo, a release, or a website" />
        </label>
        <label class="rea-field" data-for="path" hidden>
          <span class="rea-label">Path in Jarvis's sandbox</span>
          <input id="rea-path" autocomplete="off" spellcheck="false" placeholder="/workspace/J.A.R.V.I.S-Web" />
        </label>
        <label class="rea-field">
          <span class="rea-label">Workflow</span>
          <span class="select-wrap rea-select"><select id="rea-workflow">${WORKFLOWS.map((w) => html`<option value="${w.id}">${w.label}</option>`)}</select></span>
          <span class="rea-hint" id="rea-hint"></span>
        </label>
        <label class="rea-field">
          <span class="rea-label">What do you want to understand?</span>
          <textarea id="rea-question" rows="4" maxlength="2000" placeholder="How does its search work, and how would I build the same thing?"></textarea>
        </label>
        <label class="rea-check">
          <input type="checkbox" id="rea-deep" />
          <span>Go deeper: may install Ghidra, JADX or a JDK for pseudocode (slower, costs more)</span>
        </label>
        <div class="rea-actions">
          <button class="btn-primary" id="rea-run" type="submit">Reverse engineer</button>
          <button class="btn-ghost" id="rea-stop" type="button" hidden>Stop</button>
        </div>
        <p class="rea-note" id="rea-note">${NOTE}</p>
      </form>
    </section>
    <section class="panel rea-report">
      <header class="panel-head"><span class="panel-title" id="rea-title">Report</span><span class="panel-tag" id="rea-tag">standby</span></header>
      <div class="rea-tools" id="rea-tools" hidden>
        <button class="btn-ghost btn-tiny" id="rea-copy" type="button" title="Copy the report and its follow-ups as Markdown">Copy</button>
        <button class="btn-ghost btn-tiny" id="rea-download" type="button" title="Download the report and its follow-ups as a Markdown file">Download .md</button>
        <button class="btn-ghost btn-tiny" id="rea-again" type="button" title="Investigate the same target with the same question again">Run again</button>
      </div>
      <div class="rea-report-body" id="rea-report"></div>
      <footer class="rea-files" id="rea-files-out" hidden></footer>
      <form class="rea-ask" id="rea-ask" novalidate hidden>
        <input id="rea-ask-input" autocomplete="off" spellcheck="true" maxlength="1000" placeholder="Ask a follow-up about this target" aria-label="Follow-up question" />
        <button class="btn-primary btn-small" id="rea-ask-send" type="submit">Ask</button>
      </form>
    </section>
    <section class="panel rea-side">
      <header class="panel-head"><span class="panel-title">Activity</span><span class="panel-tag" id="rea-activity-tag">idle</span></header>
      <pre class="rea-log" id="rea-log" aria-live="polite"></pre>
      <header class="panel-head rea-recent-head"><span class="panel-title">Recent</span></header>
      <ul class="rea-recent" id="rea-recent"></ul>
    </section>
  </div>`;

/** What the report shows before any run: what REA can look at. */
const INTRO = html`
  <div class="rea-intro">
    <p class="rea-intro-lead">See a feature you like. Understand how it works, down to the binary.</p>
    <p>Give Jarvis a target and a question. He installs <a class="rea-link" href="https://github.com/morluto/rea" target="_blank" rel="noopener noreferrer">REA</a> in his sandbox, inspects the target without running it, and reports how it works, the evidence behind each claim, what stays unknown, and how to build your own.</p>
    <ul class="rea-brief-list">
      <li>JavaScript and Electron apps: modules, imports, routes, IPC, source maps</li>
      <li>Websites: scripts, network calls and bundles from a headless browser</li>
      <li>.NET assemblies, Go and Rust binaries, native layout, symbols and resources</li>
      <li>Android APKs, Flutter builds and SQLite databases</li>
    </ul>
    <p class="rea-hint">Pseudocode from native binaries needs Ghidra: tick “Go deeper”.</p>
  </div>`;

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function textOf(e: SessionEvent): string {
  return (e.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export class ReverseView {
  private readonly $: <T extends HTMLElement>(sel: string) => T;
  private readonly attachments: Attachments;
  private kind: TargetKind = "upload";
  private files: string[] = [];
  private history: Run[] = loadHistory();
  /** The run in flight. */
  private running: { id: string; kind: "run" | "doctor" | "followup" } | null = null;
  private stopped = false;
  private readonly bashIds = new Set<string>();
  private shown: string | null = null;
  private visible = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: ReverseHost,
  ) {
    setHtml(root, SKELETON);
    this.$ = <T extends HTMLElement>(sel: string) => {
      const found = root.querySelector(sel);
      if (!found) throw new Error(`missing ${sel}`);
      return found as T;
    };
    this.attachments = new Attachments(this.$("#rea-tray"), (t) => this.note(t, true));

    root.querySelectorAll<HTMLButtonElement>(".rea-kind").forEach((b) => (b.onclick = () => this.setKind(b.dataset.kind as TargetKind)));

    const picker = this.$<HTMLInputElement>("#rea-files");
    const drop = this.$<HTMLButtonElement>("#rea-drop");
    drop.onclick = () => picker.click();
    picker.onchange = () => {
      if (picker.files) this.addFiles(Array.from(picker.files));
      picker.value = "";
    };
    // Files dropped here are this tab's, not the chat's (the HUD's own drop
    // handler on window never sees them).
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    drop.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      drop.dataset.over = "true";
    });
    drop.addEventListener("dragleave", () => delete drop.dataset.over);
    drop.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      delete drop.dataset.over;
      this.addFiles(Array.from(e.dataTransfer?.files ?? []));
    });

    const select = this.$<HTMLSelectElement>("#rea-workflow");
    select.onchange = () => this.renderHint();
    this.renderHint();

    this.$<HTMLFormElement>("#rea-form").onsubmit = (e) => {
      e.preventDefault();
      void this.run();
    };
    this.$<HTMLButtonElement>("#rea-stop").onclick = () => {
      this.stopped = true;
      this.host.stop();
    };
    this.$<HTMLButtonElement>("#rea-doctor").onclick = () => void this.doctor();
    this.$<HTMLButtonElement>("#rea-copy").onclick = () => void this.copy();
    this.$<HTMLButtonElement>("#rea-download").onclick = () => this.download();
    this.$<HTMLButtonElement>("#rea-again").onclick = () => void this.again();
    this.$<HTMLFormElement>("#rea-ask").onsubmit = (e) => {
      e.preventDefault();
      void this.followup();
    };

    this.showIntro();
    this.renderRecent();
    this.logLine("rea-dim", "Jarvis's shell activity during a run appears here.");
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  dispose() {
    this.hide();
  }

  /** Every conversation event passes through; during a run, bash calls and results are logged. */
  feed(e: SessionEvent) {
    if (!this.running) return;
    if (e.type === "agent.tool_use" && e.name === "bash" && e.id) {
      this.bashIds.add(e.id);
      const cmd = ((e.input ?? {}) as { command?: string }).command;
      if (cmd) this.logLine(isReaCommand(cmd) ? "rea-cmd rea-cmd-rea" : "rea-cmd", `$ ${cmd}`);
    } else if (e.type === "agent.tool_result" && e.tool_use_id && this.bashIds.has(e.tool_use_id)) {
      let text = textOf(e);
      if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters)`;
      this.logLine("rea-result", text || "(no output)");
    } else if (e.type === "agent.tool_use" && e.name) {
      this.logLine("rea-dim", `· ${e.name}`);
    }
  }

  // ---- the form ---------------------------------------------------------------

  private setKind(kind: TargetKind) {
    this.kind = kind;
    this.root.querySelectorAll<HTMLButtonElement>(".rea-kind").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.kind === kind)));
    this.root.querySelectorAll<HTMLElement>(".rea-field[data-for]").forEach((f) => (f.hidden = f.dataset.for !== kind));
    const select = this.$<HTMLSelectElement>("#rea-workflow");
    if (kind === "url" && select.value === "auto") select.value = "website";
    else if (kind !== "url" && select.value === "website") select.value = "auto";
    this.renderHint();
    if (kind === "url") this.$<HTMLInputElement>("#rea-url").focus();
    if (kind === "path") this.$<HTMLInputElement>("#rea-path").focus();
  }

  private addFiles(files: File[]) {
    if (!files.length) return;
    if (!this.attachments.count) this.files = [];
    this.attachments.add(files);
    this.files.push(...files.map((f) => f.name));
    if (this.kind !== "upload") this.setKind("upload");
  }

  private renderHint() {
    this.$("#rea-hint").textContent = workflow(this.$<HTMLSelectElement>("#rea-workflow").value).hint;
  }

  private note(text: string, warn = false) {
    const n = this.$("#rea-note");
    n.textContent = text;
    n.dataset.warn = String(warn);
  }

  private spec(): RunSpec {
    const target = this.kind === "url" ? this.$<HTMLInputElement>("#rea-url").value.trim() : this.kind === "path" ? this.$<HTMLInputElement>("#rea-path").value.trim() : "";
    return {
      id: runId(),
      workflow: workflow(this.$<HTMLSelectElement>("#rea-workflow").value).id,
      kind: this.kind,
      target,
      files: this.kind === "upload" && this.attachments.count ? this.files.slice() : [],
      question: this.$<HTMLTextAreaElement>("#rea-question").value,
      deep: this.$<HTMLInputElement>("#rea-deep").checked,
    };
  }

  // ---- runs -------------------------------------------------------------------

  private async run() {
    if (this.running) return;
    const spec = this.spec();
    const why = problem(spec);
    if (why) {
      this.note(why, true);
      return;
    }
    const ids = spec.kind === "upload" ? await this.attachments.take() : [];
    this.files = [];
    if (spec.kind === "upload" && !ids.length) {
      this.note("The upload failed, so there is nothing to investigate. Try again.", true);
      return;
    }
    const { id, ...asked } = spec;
    await this.investigate(id, targetLabel(spec), reaTask(spec), ids, asked);
  }

  private async doctor() {
    if (this.running) return;
    await this.investigate(runId(), "Sandbox check", doctorTask(), [], null);
  }

  /** The shown run again, as a new run: same target (uploads re-attached), same question. */
  private async again() {
    const run = this.current();
    if (this.running || !run) return;
    if (!run.spec) {
      await this.doctor();
      return;
    }
    const id = runId();
    await this.investigate(id, run.label, reaTask({ ...run.spec, id }), run.attachments ?? [], run.spec);
  }

  /** The run being shown, as history now has it. */
  private current(): Run | null {
    return this.history.find((r) => r.id === this.shown) ?? null;
  }

  /** One silent turn with the busy state, the timeout and Stop; resolves with the reply ("" if none). */
  private async turn(prompt: string, attachments: string[]): Promise<string> {
    this.stopped = false;
    this.bashIds.clear();
    this.setBusy(true);
    let timer = 0;
    try {
      return await Promise.race([
        this.host.investigate(prompt, attachments),
        new Promise<string>((resolve) => (timer = window.setTimeout(() => resolve(""), RUN_TIMEOUT_MS))),
      ]);
    } finally {
      window.clearTimeout(timer);
      this.running = null;
      this.setBusy(false);
    }
  }

  private analyzing(text: string): HTMLElement {
    const status = el("div", "intel-analyzing");
    status.append(el("span", "intel-analyzing-bars"), el("span", "", text));
    return status;
  }

  /** Nothing came back: say why where the reply would have gone. */
  private failed(where: HTMLElement, what: string) {
    where.replaceChildren(
      el("p", "rea-hint", this.stopped ? "Stopped. Whatever Jarvis found so far is in the transcript." : `No ${what} came back. See the transcript and the activity log, then try again.`),
    );
    this.note(this.stopped ? "Stopped." : `No ${what} came back.`, !this.stopped);
  }

  /** `asked`: the form behind the run, or null for the sandbox check. */
  private async investigate(id: string, label: string, prompt: string, attachments: string[], asked: Omit<RunSpec, "id"> | null) {
    this.running = { id, kind: asked ? "run" : "doctor" };
    this.shown = id;
    this.$("#rea-title").textContent = label;
    this.$("#rea-tag").textContent = "investigating";
    this.$("#rea-files-out").hidden = true;
    this.$("#rea-tools").hidden = true;
    this.$("#rea-ask").hidden = true;
    const out = this.$("#rea-report");
    out.replaceChildren(this.analyzing(asked ? "Jarvis is investigating. Several minutes for a large target" : "Checking REA in the sandbox"));
    this.$("#rea-log").replaceChildren();
    this.logLine("rea-dim", `run ${id} · ${label}`);
    this.note(asked ? "Running. Stop interrupts Jarvis; the report stays empty." : "Checking the sandbox…");
    this.renderRecent();

    const text = await this.turn(prompt, attachments);
    if (!text.trim()) {
      if (this.shown !== id) return;
      this.$("#rea-tag").textContent = this.stopped ? "stopped" : "no report";
      this.failed(out, "report");
      return;
    }
    const run: Run = {
      id,
      label,
      workflow: asked?.workflow ?? "auto",
      question: asked ? asked.question.trim() : "Is REA ready?",
      at: new Date().toISOString(),
      report: text,
      session: this.host.sessionId(),
      ...(asked ? { spec: asked } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    this.history = remember(run, this.history);
    this.note(NOTE);
    if (this.shown === id) this.showRun(run);
    else this.renderRecent();
    const lead = leadLine(text);
    if (lead && this.visible) this.host.speak(lead);
  }

  /** A follow-up question on the shown run; the answer is kept with it. */
  private async followup() {
    const run = this.current();
    const input = this.$<HTMLInputElement>("#rea-ask-input");
    const q = input.value.trim();
    if (this.running || !run || !q) return;
    input.value = "";
    // Same conversation: the sandbox still has the work. Otherwise the
    // target comes again (uploads re-attached) with the report as context.
    const sameSession = !!run.session && run.session === this.host.sessionId();
    this.running = { id: run.id, kind: "followup" };
    const block = this.followupBlock(q, null);
    const answer = block.querySelector(".rea-answer") as HTMLElement;
    answer.replaceChildren(this.analyzing("Jarvis is looking into it"));
    const out = this.$("#rea-report");
    out.append(block);
    block.scrollIntoView({ block: "start", behavior: "smooth" });
    this.$("#rea-log").replaceChildren();
    this.logLine("rea-dim", `follow-up · ${run.label}`);
    this.note(sameSession ? "Asking. Stop interrupts Jarvis." : "Asking in a new conversation: Jarvis fetches the target again first.");

    const text = await this.turn(followupTask(run, q, sameSession), sameSession ? [] : (run.attachments ?? []));
    if (!text.trim()) {
      if (answer.isConnected) this.failed(answer, "answer");
      return;
    }
    const latest = this.history.find((r) => r.id === run.id) ?? run;
    this.history = remember({ ...latest, followups: [...(latest.followups ?? []), { q, a: text, at: new Date().toISOString() }] }, this.history);
    this.renderRecent();
    this.note(NOTE);
    if (answer.isConnected) renderBrief(answer, text, "rea");
    const lead = leadLine(text);
    if (lead && this.visible) this.host.speak(lead);
  }

  /** A follow-up as it sits under the report: the question, then the answer. */
  private followupBlock(q: string, a: string | null): HTMLElement {
    const box = el("section", "rea-followup");
    box.append(el("h4", "rea-followup-q", q));
    const answer = el("div", "rea-answer");
    if (a) renderBrief(answer, a, "rea");
    box.append(answer);
    return box;
  }

  private async copy() {
    const run = this.current();
    if (!run) return;
    try {
      await navigator.clipboard.writeText(toMarkdown(run));
      this.note("Report copied as Markdown.");
    } catch {
      this.note("The browser would not copy. Use Download .md instead.", true);
    }
  }

  private download() {
    const run = this.current();
    if (!run) return;
    const url = URL.createObjectURL(new Blob([toMarkdown(run)], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFilename(run);
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  private setBusy(busy: boolean) {
    this.$<HTMLButtonElement>("#rea-run").disabled = busy;
    this.$<HTMLButtonElement>("#rea-doctor").disabled = busy;
    this.$<HTMLButtonElement>("#rea-again").disabled = busy;
    this.$<HTMLButtonElement>("#rea-ask-send").disabled = busy;
    this.$<HTMLButtonElement>("#rea-stop").hidden = !busy;
    this.$("#rea-activity-tag").textContent = busy ? "live" : "idle";
  }

  // ---- report -----------------------------------------------------------------

  private showIntro() {
    this.shown = null;
    this.$("#rea-title").textContent = "Report";
    this.$("#rea-tag").textContent = "standby";
    this.$("#rea-tools").hidden = true;
    this.$("#rea-ask").hidden = true;
    this.$("#rea-files-out").hidden = true;
    setHtml(this.$("#rea-report"), INTRO);
  }

  private showRun(run: Run) {
    this.shown = run.id;
    this.$("#rea-title").textContent = run.label;
    this.$("#rea-tag").textContent = `${workflow(run.workflow).label} · ${ago(run.at)}`;
    const out = this.$("#rea-report");
    renderBrief(out, run.report, "rea");
    for (const f of run.followups ?? []) out.append(this.followupBlock(f.q, f.a));
    out.scrollTop = 0;
    this.$("#rea-tools").hidden = false;
    this.$<HTMLButtonElement>("#rea-again").title = run.spec ? "Investigate the same target with the same question again" : "Check the sandbox again";
    this.$("#rea-ask").hidden = false;
    this.renderRecent();
    void this.renderFiles(run);
  }

  /** The evidence the run saved in the sandbox's outputs, as downloads. */
  private async renderFiles(run: Run) {
    const box = this.$("#rea-files-out");
    box.hidden = true;
    if (!run.session) return;
    const files = await this.host.outputs(run.session).catch(() => [] as OutputFile[]);
    if (this.shown !== run.id) return;
    const mine = files.filter((f) => f.downloadable && isRunOutput(f.filename, run.id));
    if (!mine.length) return;
    box.replaceChildren(
      el("span", "rea-label", "Evidence"),
      ...mine.map((f) => {
        const a = el<HTMLAnchorElement>("a", "file-chip file-chip-out", f.filename.slice(`rea-${run.id}-`.length) || f.filename);
        a.href = `/bff/v1/files/${encodeURIComponent(f.id)}/content?session=${encodeURIComponent(run.session ?? "")}`;
        a.download = f.filename;
        a.title = `Download ${f.filename}`;
        return a;
      }),
    );
    box.hidden = false;
  }

  private renderRecent() {
    const list = this.$<HTMLUListElement>("#rea-recent");
    if (!this.history.length) {
      list.replaceChildren(el("li", "panel-empty", "No investigations yet"));
      return;
    }
    list.replaceChildren(
      ...this.history.map((r) => {
        const li = el("li", "rea-recent-row");
        li.dataset.current = String(r.id === this.shown);
        const open = el<HTMLButtonElement>("button", "rea-recent-open");
        open.type = "button";
        open.append(el("span", "rea-recent-name", r.label), el("span", "rea-recent-meta", [workflow(r.workflow).label, ago(r.at)].join(" · ")));
        if (r.question) open.title = r.question;
        open.onclick = () => this.showRun(r);
        const x = el<HTMLButtonElement>("button", "rea-recent-x", "×");
        x.type = "button";
        x.setAttribute("aria-label", `Forget ${r.label}`);
        x.onclick = () => {
          this.history = forget(r.id, this.history);
          if (this.shown === r.id && !this.running) this.showIntro();
          this.renderRecent();
        };
        li.append(open, x);
        return li;
      }),
    );
  }

  private logLine(cls: string, text: string) {
    const log = this.$("#rea-log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const span = el("span", cls, text.endsWith("\n") ? text : `${text}\n`);
    log.append(span);
    while (log.childElementCount > MAX_LOG_LINES) log.firstElementChild?.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}
