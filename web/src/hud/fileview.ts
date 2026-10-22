// One file of a project, shown in the Projects tab: a doc (.md) rendered,
// code with line numbers, a 3D model in the spinning viewer, anything else
// as a download. Everything goes in as text nodes (`renderBrief` builds its
// markup the same way), so nothing in a file can run here.

import { renderBrief } from "./brief";
import { modelKind, showModel } from "./model3d";

export type FileKind = "model" | "doc" | "code" | "other";

/** Biggest file read as text; larger ones are a download. */
export const MAX_TEXT_BYTES = 1024 * 1024;

const CODE = new Set(
  (
    "ts tsx js jsx mjs cjs rs py go swift kt kts java c h cc cpp hpp cs rb php sh bash zsh fish ps1 lua pl r " +
    "json jsonc toml yaml yml ini cfg conf env html htm css scss sass less vue svelte sql graphql gql xml svg " +
    "txt csv tsv log gradle properties cmake proto dart scala ex exs erl hs ml clj zig nim tf hcl lock"
  ).split(" "),
);
const NAMED = new Set(["dockerfile", "makefile", "license", "procfile", "gemfile", "rakefile", ".gitignore", ".editorconfig"]);

export function kindOf(path: string): FileKind {
  const name = path.split("/").pop() ?? path;
  if (modelKind(name)) return "model";
  const lower = name.toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower)) return "doc";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (CODE.has(ext) || NAMED.has(lower)) return "code";
  return "other";
}

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** `[number, line]` pairs, numbers padded to one width; CRLF and a final newline dropped. */
export function numberLines(text: string): [string, string][] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const width = String(lines.length).length;
  return lines.map((line, i) => [String(i + 1).padStart(width, " "), line]);
}

/** Code as numbered lines, text nodes only. */
export function codeView(text: string): HTMLElement {
  const pre = el("pre", "code-view");
  for (const [n, line] of numberLines(text)) {
    const row = el("span", "code-line");
    row.append(el("span", "code-n", n), el("span", "code-t", line || " "));
    pre.append(row);
  }
  return pre;
}

/**
 * Show `path` in `box`. `load` fetches its bytes (from this origin), `url`
 * is where to download it. Resolves with a teardown for a 3D model, else
 * nothing to stop.
 */
export async function renderFile(
  box: HTMLElement,
  path: string,
  size: number | undefined,
  load: () => Promise<ArrayBuffer>,
  url: string,
): Promise<(() => void) | null> {
  const name = path.split("/").pop() ?? path;
  const kind = kindOf(path);
  const download = () => {
    const a = el<HTMLAnchorElement>("a", "btn-ghost btn-small", `Download ${name}`);
    a.href = url;
    a.download = name;
    return a;
  };
  if (kind === "other" || ((kind === "doc" || kind === "code") && (size ?? 0) > MAX_TEXT_BYTES)) {
    box.replaceChildren(el("p", "panel-empty", kind === "other" ? "No preview for this kind of file." : "Too large to show here."), download());
    return null;
  }
  box.replaceChildren(el("p", "intel-hint", `Loading ${name}…`));
  const data = await load();
  if (!box.isConnected) return null;
  if (kind === "model") {
    const stage = el("div", "projects-stage");
    box.replaceChildren(stage, el("p", "intel-hint", `${name} · drag to turn, scroll to zoom`));
    return showModel(stage, data, modelKind(name)!);
  }
  const text = new TextDecoder().decode(data);
  if (kind === "doc") {
    const doc = el("div", "intel-brief project-doc");
    renderBrief(doc, text);
    box.replaceChildren(doc);
  } else {
    box.replaceChildren(codeView(text));
  }
  box.append(download());
  return null;
}
