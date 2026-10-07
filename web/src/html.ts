// The one way markup reaches the DOM. The server's CSP says
// `require-trusted-types-for 'script'; trusted-types jarvis`, so the
// browser refuses any plain string assigned to `innerHTML` and friends; the
// only policy allowed to make markup is the one below, and the only thing
// it ever sees is an `Html`, which only `html` builds. `html` escapes every
// value it interpolates — text and attributes alike — unless that value is
// itself an `Html` (a nested template) or a list of them.
//
// Text from anywhere else (the API, the agent, a file name) still goes in
// with `textContent`; this is for the views' fixed skeletons.

/** Markup built by `html`, and nothing else. */
export class Html {
  /** @internal Use `html`. */
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

interface Policy {
  createHTML(input: string): unknown;
}
interface TrustedTypes {
  createPolicy(name: string, rules: { createHTML(input: string): string }): Policy;
}

// Where the browser has no Trusted Types (Firefox, tests) the escaping in
// `html` is the defense on its own.
const policy: Policy | null = (() => {
  const tt = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes;
  return tt ? tt.createPolicy("jarvis", { createHTML: (s) => s }) : null;
})();

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined) return "";
  return escapeHtml(String(v));
}

/** A template whose interpolations are escaped (nested `Html` is kept). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** Replace `el`'s children with `markup`. */
export function setHtml(el: Element, markup: Html): void {
  el.innerHTML = (policy ? policy.createHTML(markup.value) : markup.value) as string;
}
