// The Reverse tab's model: what can be investigated, how, and the message
// that asks Jarvis to do it with REA (github.com/morluto/rea, the
// `rea-agents` npm package) in his cloud sandbox. Nothing here runs REA:
// the page has no shell. It writes a `[rea]` turn, Jarvis runs the CLI, and
// his report comes back as the turn's (silent) reply.

/** How the target reaches the sandbox. */
export type TargetKind = "upload" | "url" | "path";

export type WorkflowId = "auto" | "javascript" | "website" | "managed" | "native" | "go" | "rust" | "android" | "sqlite";

export interface Workflow {
  id: WorkflowId;
  label: string;
  /** One line under the picker. */
  hint: string;
  /** The REA commands Jarvis should reach for, in order. */
  plan: string;
}

/** The REA version the prompt's command names were checked against. */
export const REA_VERSION = "6.5.0";

export const WORKFLOWS: Workflow[] = [
  {
    id: "auto",
    label: "Identify it",
    hint: "Any file or package: REA works out what it is, then follows its own next probes.",
    plan:
      "Start with `rea inspect-artifact <path>`: it fingerprints the artifact (format, digests, contents, signatures) and proposes next probes. " +
      "Follow the probes that bear on the question with the matching REA commands below.",
  },
  {
    id: "javascript",
    label: "JavaScript / Electron app",
    hint: "An extracted app folder, an .asar, or an installer REA can unpack (.zip, .dmg, .AppImage).",
    plan:
      "If it is an installer or archive, unpack it with `rea extract-artifact` first and find the app directory or app.asar. " +
      "Then `rea analyze-javascript-application <dir-or-asar> --format json > $W/app.json` (it can be very large: never print it), " +
      "project it with `rea inspect-analysis-view` (a summary view first, then module pages or single modules), " +
      "and use `rea inspect-electron-fuses` for an Electron build. Trace the feature in the question through modules, imports, routes and IPC.",
  },
  {
    id: "website",
    label: "Website",
    hint: "A public page: its scripts, network calls and bundles, observed from a headless browser.",
    plan:
      "Launch headless Chromium from Python Playwright with `--remote-debugging-port=9222` and ignore_https_errors (the sandbox intercepts TLS), " +
      "keep it running, open the URL, then `rea list-browser-targets http://127.0.0.1:9222` for the target id. " +
      "Save `rea inspect-web-page <endpoint> <targetId> --include-json-body-shapes --include-script-sources --format json > $W/page.json`, " +
      "use `rea analyze-web-bundle <endpoint> <targetId> --fetch-source-maps`, and when the question needs the code, " +
      "`rea export-web-scripts $W/page.json $W/scripts` followed by `rea analyze-javascript-application $W/scripts`. " +
      "Observe passively: no logins, no form submissions, no load beyond loading the page.",
  },
  {
    id: "managed",
    label: ".NET assembly",
    hint: "A managed .dll or .exe: metadata, members, CIL and native boundaries, never loaded.",
    plan:
      "`rea inspect-managed-artifact <path>` for identity and deployment form, then `rea inspect-managed-members <path> --type <full name>` " +
      "for the types that matter (all members only if small), and `rea inspect-managed-native-boundaries <path>` for P/Invoke.",
  },
  {
    id: "native",
    label: "Native binary",
    hint: "ELF, Mach-O, PE or an .app bundle: layout, symbols, strings, resources.",
    plan:
      "`rea inspect-artifact <path>`, then `rea inspect-binary-layout <path>`; for Mach-O and .app bundles `rea inspect-macho`, `rea inspect-plist` " +
      "and `rea demangle-swift`; for PE `rea inspect-pe-resources`. Check `rea inspect-go-binary` and `rea inspect-rust-binary` for embedded build metadata. " +
      "Pseudocode needs a native engine (Ghidra): see the depth rule.",
  },
  {
    id: "go",
    label: "Go binary",
    hint: "Compiler version, modules, replacements and build settings embedded in the binary.",
    plan: "`rea inspect-go-binary <path>`, then `rea inspect-binary-layout <path>` if the question goes past the build metadata.",
  },
  {
    id: "rust",
    label: "Rust binary",
    hint: "The embedded cargo-auditable crate list: names, versions, sources and dependency edges.",
    plan: "`rea inspect-rust-binary <path>`, then `rea inspect-binary-layout <path>` if the question goes past the dependency list.",
  },
  {
    id: "android",
    label: "Android APK",
    hint: "Manifest declarations, permissions, components; Flutter build facts.",
    plan:
      "`rea inspect-android-package <apk>`, and `rea identify-flutter-build <apk>` / `rea inspect-dart-aot` for a Flutter app. " +
      "Class and method decompilation (`rea inspect-android-class`, `rea inspect-android-method`) needs JADX and a JDK: see the depth rule.",
  },
  {
    id: "sqlite",
    label: "SQLite database",
    hint: "Tables, columns, indexes, views and triggers, plus a bounded sample of rows.",
    plan: "`rea inspect-sqlite-database <path>`, then `--table <name> --row-limit 20` for the tables the question is about.",
  },
];

export const workflow = (id: string): Workflow => WORKFLOWS.find((w) => w.id === id) ?? WORKFLOWS[0];

/** One investigation as the form describes it. */
export interface RunSpec {
  /** Short and unique; names the run's files in the sandbox. */
  id: string;
  workflow: WorkflowId;
  kind: TargetKind;
  /** The link or sandbox path (empty for an upload). */
  target: string;
  /** Names of the uploaded files (for the label; the sandbox lists the real paths). */
  files: string[];
  question: string;
  /** May install heavy engines (Ghidra, JADX, a JDK). */
  deep: boolean;
}

/** A fresh run id: time-ordered, filename-safe. */
export function runId(now = Date.now()): string {
  return `${now.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")}`;
}

/** Why the form can't run yet, or null. */
export function problem(spec: Pick<RunSpec, "kind" | "target" | "files">): string | null {
  const t = spec.target.trim();
  if (spec.kind === "upload") return spec.files.length ? null : "Attach the file to investigate";
  if (spec.kind === "url") {
    if (!t) return "Give a link";
    if (/\s/.test(t) || !/^https?:\/\/[^/\s]+/i.test(t)) return "A link must start with http:// or https://";
    return null;
  }
  if (!t) return "Give a path in the sandbox";
  if (!t.startsWith("/") || /[\n\r]/.test(t)) return "A sandbox path is absolute, e.g. /workspace/app";
  return null;
}

/** What the run is called in the report header and history. */
export function targetLabel(spec: Pick<RunSpec, "kind" | "target" | "files">): string {
  if (spec.kind === "upload") return spec.files.length > 1 ? `${spec.files[0]} +${spec.files.length - 1}` : (spec.files[0] ?? "upload");
  if (spec.kind === "url") return spec.target.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return spec.target.split("/").filter(Boolean).pop() ?? spec.target;
}

function targetLine(spec: RunSpec): string {
  if (spec.kind === "upload") {
    return "Target: the file(s) attached to this message (listed below it, under /mnt/session/uploads/). Copy them into $W before unpacking anything.";
  }
  if (spec.kind === "path") return `Target: ${spec.target} in your sandbox (read it in place; write only under $W).`;
  if (spec.workflow === "website") return `Target: the website ${spec.target}`;
  return (
    `Target: ${spec.target} — download it into $W (for a GitHub repository, clone it shallowly; for a release or package page, fetch the ` +
    "artifact it offers for Linux or the platform the question names; for an npm package, `npm pack` it). Never run what you download."
  );
}

/** The `[rea]` message: setup, the plan, the rules and the report's shape. */
export function reaTask(spec: RunSpec): string {
  const w = workflow(spec.workflow);
  const question = spec.question.trim() || "What is this, how is it built, and how do its main features work?";
  return [
    "[rea] Reverse-engineer this for the Reverse panel with REA. Your reply is shown on screen, not spoken, so ignore the short",
    "spoken-reply rules and follow this message.",
    "",
    "Setup: REA is the `rea-agents` npm package (github.com/morluto/rea). It needs Node 24.15 or newer here: if `node -v` is older, download",
    "the official linux-x64 tarball from https://nodejs.org/dist/latest-v24.x/ into ~/.rea/node and put its bin first on PATH. Then",
    `\`npm install -g rea-agents@${REA_VERSION}\` (or later) once, and call it as \`rea\`. \`rea <command> --help\` shows a command's options.`,
    `Work in W=/tmp/rea/${spec.id} (mkdir -p it).`,
    "",
    targetLine(spec),
    `Workflow: ${w.label}. ${w.plan}`,
    `Question: ${question}`,
    "",
    "Rules:",
    "- Static analysis only: never execute, install or launch the target, and never use capture-process, Frida, GDB, Rizin debugging or LLDB.",
    "- Keep output small, your budget is shared with the conversation: check `--token-count` before printing a result, cut it down with",
    "  `--filter-output` or `rea inspect-analysis-view`, or save `--format json` to a file under $W and read it with jq. Never cat a large result.",
    "- Save the evidence worth keeping (at most five files, each under 20 MB) as /mnt/session/outputs/rea-" + spec.id + "-<name>.json so they can be downloaded.",
    spec.deep
      ? "- Depth: you may install a heavier engine when the question needs it (Ghidra with a JDK 21 for native pseudocode via `--provider ghidra`, JADX for APK classes, binutils for objdump). Say what you installed."
      : "- Depth: do not install Ghidra, JADX, a JDK or other heavy engines. If the question needs pseudocode or decompiled classes, say so under Unknowns and limits.",
    "- Explain how it works so Mr. Walker can understand it or build his own version. Do not help bypass licensing, DRM, anti-cheat or",
    "  copy protection, and if you find embedded secrets (API keys, tokens, passwords), say that they exist and where, never their values.",
    "- If REA cannot install or a command fails, report the error and what you could still establish instead of guessing.",
    "",
    "Reply in plain markdown (# headings, - bullets, fenced code where code helps, no tables), beginning with one plain sentence that answers",
    "the question (that line alone is read aloud). Then these sections:",
    "# Identity — name, format, architecture, size, SHA-256, toolchain and notable dependencies.",
    "# How it works — the answer to the question, step by step.",
    "# Evidence — what REA observed that supports each claim: modules, functions, symbols, strings, offsets, with the command that showed it.",
    "# Unknowns and limits — what is inferred rather than observed, and what REA could not see.",
    "# Build your own — how to implement the same behavior, with a short code sketch (only when the question is about a feature).",
    "# Commands — the REA commands you ran, in one fenced block.",
  ].join("\n");
}

/** The sandbox health check: REA's own readiness report, nothing analyzed. */
export function doctorTask(): string {
  return [
    "[rea] Check whether REA is ready in your sandbox, for the Reverse panel (shown on screen, not spoken).",
    "Report `node -v`; if it is older than 24.15, install the official linux-x64 Node 24 tarball from https://nodejs.org/dist/latest-v24.x/",
    `into ~/.rea/node and put it first on PATH. Install \`rea-agents@${REA_VERSION}\` (or later) globally if \`rea --version\` fails, then run`,
    "`rea doctor --format json` and `rea capabilities --format json`, keeping their output small with --filter-output or jq.",
    "Reply in plain markdown beginning with one plain sentence on whether REA is ready, then: # Versions, # Ready (the workflows that will",
    "work: static JavaScript/Electron, websites via headless Chromium, .NET, Go, Rust, binary layout, APK manifests, SQLite),",
    "# Not available (and what each would need), # Commands (one fenced block).",
  ].join("\n");
}

/** Bash commands in the run's activity that are REA itself (highlighted). */
export const isReaCommand = (cmd: string): boolean => /(^|[\s;&|(/])(rea|rea-agents)(\s|$)/.test(cmd) || /rea-agents@/.test(cmd);

/** Evidence the run saved for download: `rea-<id>-*.json` in the session's outputs. */
export const isRunOutput = (filename: string, id: string): boolean => filename.startsWith(`rea-${id}-`);

// ---- history (this browser only: a convenience, not a record) ---------------

export interface Run {
  id: string;
  label: string;
  workflow: WorkflowId;
  question: string;
  at: string;
  report: string;
  /** The session the run's evidence files belong to. */
  session: string | null;
}

const HISTORY_KEY = "jarvis.rea.history";
const MAX_RUNS = 12;
const MAX_REPORT = 60_000;

export function loadHistory(): Run[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is Run => !!r && typeof r === "object" && typeof (r as Run).id === "string" && typeof (r as Run).report === "string");
  } catch {
    return [];
  }
}

/** Newest first, capped; returns what is now kept. */
export function remember(run: Run, history: Run[]): Run[] {
  const kept = [{ ...run, report: run.report.slice(0, MAX_REPORT) }, ...history.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
  } catch {
    /* private mode or full: the list just doesn't survive a reload */
  }
  return kept;
}

export function forget(id: string, history: Run[]): Run[] {
  const kept = history.filter((r) => r.id !== id);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
  } catch {
    /* fine */
  }
  return kept;
}
