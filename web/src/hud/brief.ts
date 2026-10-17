// Jarvis's written replies for the tabs that show rather than speak them
// (Intel's briefs, Reverse's reports): a small markdown subset rendered as
// DOM — headings, bullets, paragraphs, fenced code, links — every piece of
// text by textContent. Nothing here builds markup from a string.

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** An http(s) link that opens in a new tab; anything else stays text. */
export function link(url: string, text: string, cls = "intel-link"): HTMLElement {
  if (!/^https?:\/\//.test(url)) return el("span", cls, text);
  const a = el<HTMLAnchorElement>("a", cls, text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** Inline text: links (bare or markdown), `code`; `**bold**` markers dropped. */
function inline(parent: HTMLElement, text: string, prefix: string) {
  const clean = text.replace(/\*\*(.+?)\*\*/g, "$1");
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (m.index > last) parent.append(clean.slice(last, m.index));
    if (m[4] !== undefined) parent.append(el("code", `${prefix}-brief-tt`, m[4]));
    else parent.append(link(m[2] ?? m[3], m[1] ?? m[3], `${prefix}-link`));
    last = m.index + m[0].length;
  }
  if (last < clean.length) parent.append(clean.slice(last));
}

/**
 * Markdown as DOM, into `root`. `prefix` names the classes
 * (`intel-brief-h`, `intel-brief-list`, `intel-brief-code`, …).
 */
export function renderBrief(root: HTMLElement, text: string, prefix = "intel") {
  root.replaceChildren();
  let list: HTMLElement | null = null;
  let code: string[] | null = null;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      if (code) {
        root.append(el("pre", `${prefix}-brief-code`, code.join("\n")));
        code = null;
      } else {
        code = [];
        list = null;
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    const line = raw.trim();
    if (!line || /^[-*_]{3,}$/.test(line)) {
      list = null;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      list = null;
      const h = el("h4", `${prefix}-brief-h`);
      inline(h, heading[1], prefix);
      root.append(h);
    } else if (bullet) {
      if (!list) {
        list = el("ul", `${prefix}-brief-list`);
        root.append(list);
      }
      const li = el("li");
      inline(li, bullet[1], prefix);
      list.append(li);
    } else {
      list = null;
      const p = el("p");
      inline(p, line, prefix);
      root.append(p);
    }
  }
  // An unclosed fence still shows what it held.
  if (code?.length) root.append(el("pre", `${prefix}-brief-code`, code.join("\n")));
}

/** The line read aloud: the brief's first plain sentence. */
export function leadLine(text: string): string {
  let fenced = false;
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => {
      if (l.startsWith("```")) fenced = !fenced;
      return !fenced && l && !l.startsWith("```") && !l.startsWith("#") && !/^[-*•]/.test(l);
    });
  if (!first) return "";
  const plain = first.replace(/\*\*|`|\[|\]\([^)]*\)/g, "");
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 320 ? `${sentence.slice(0, 317)}…` : sentence;
}
