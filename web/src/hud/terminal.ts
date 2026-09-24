// The Terminal tab: Jarvis's cloud sandbox as a shell. There is no API to run
// a command without the model, so this is a view of the conversation's bash
// tool calls (the command, then its output) plus a prompt that asks Jarvis
// to run exactly what was typed. Each command is one model turn; the pane
// says so. Nothing here reaches the droplet or the rig — only the sandbox.

import type { SessionEvent } from "./transcript";

const MAX_OUTPUT = 20_000;

export interface TerminalHost {
  run(command: string): void;
  sessionId(): string | null;
}

function textOf(e: SessionEvent): string {
  return (e.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** The message that asks Jarvis to act as the shell. */
export function terminalTask(command: string): string {
  return (
    `[terminal] Run exactly this command with your bash tool, unchanged, then reply with only "done" ` +
    `(or the one-line error) — the output is shown on screen, not read aloud:\n${command}`
  );
}

export class TerminalView {
  private readonly out: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly bashIds = new Set<string>();
  private readonly history: string[] = [];
  private cursor = 0;

  constructor(
    root: HTMLElement,
    private readonly host: TerminalHost,
  ) {
    root.innerHTML = `
      <div class="term">
        <header class="term-head">
          <span class="panel-title">Terminal</span>
          <span class="term-note">Jarvis's cloud sandbox · each command is one Jarvis turn (about 1–3¢) · repos under /workspace</span>
        </header>
        <pre class="term-out" id="term-out" aria-live="polite"></pre>
        <form class="term-line" id="term-form">
          <span class="term-prompt" aria-hidden="true">jarvis@sandbox:~$</span>
          <input id="term-input" autocomplete="off" spellcheck="false" aria-label="Command" placeholder="ls /workspace" />
        </form>
      </div>`;
    this.out = root.querySelector("#term-out") as HTMLElement;
    this.input = root.querySelector("#term-input") as HTMLInputElement;
    (root.querySelector("#term-form") as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      const cmd = this.input.value.trim();
      if (!cmd) return;
      this.history.push(cmd);
      this.cursor = this.history.length;
      this.input.value = "";
      this.line("term-typed", `$ ${cmd}`);
      this.host.run(cmd);
    };
    this.input.onkeydown = (e) => {
      if (e.key === "ArrowUp" && this.cursor > 0) {
        this.input.value = this.history[--this.cursor];
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        this.cursor = Math.min(this.cursor + 1, this.history.length);
        this.input.value = this.history[this.cursor] ?? "";
        e.preventDefault();
      }
    };
    this.line("term-dim", "Commands you type run in Jarvis's sandbox. His own bash calls appear here too.");
  }

  focus() {
    this.input.focus();
  }

  clear() {
    this.out.textContent = "";
    this.bashIds.clear();
  }

  /** Every conversation event passes through; only bash calls and results render. */
  feed(e: SessionEvent) {
    if (e.type === "agent.tool_use" && e.name === "bash" && e.id) {
      this.bashIds.add(e.id);
      const input = (e.input ?? {}) as { command?: string; restart?: boolean };
      if (input.restart) this.line("term-dim", "[shell restarted]");
      else if (input.command) this.line("term-cmd", `$ ${input.command}`);
    } else if (e.type === "agent.tool_result" && e.tool_use_id && this.bashIds.has(e.tool_use_id)) {
      let text = textOf(e);
      if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)`;
      this.line("term-result", text || "(no output)");
    }
  }

  private line(cls: string, text: string) {
    const atBottom = this.out.scrollHeight - this.out.scrollTop - this.out.clientHeight < 40;
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text.endsWith("\n") ? text : `${text}\n`;
    this.out.appendChild(span);
    if (atBottom || cls === "term-typed") this.out.scrollTop = this.out.scrollHeight;
  }
}
