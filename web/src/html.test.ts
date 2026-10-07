import { describe, expect, it } from "vitest";
import { escapeHtml, html, Html } from "./html";

describe("html", () => {
  it("escapes what it interpolates, in text and in attributes", () => {
    const evil = `"><img src=x onerror=alert(1)>'&`;
    const out = html`<p title="${evil}">${evil}</p>`.value;
    expect(out).not.toContain("<img");
    expect(out).toBe(
      `<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;</p>`,
    );
  });

  it("keeps the template's own markup and nested templates", () => {
    const inner = html`<b>${"<i>"}</b>`;
    const out = html`<div>${inner}${[html`<br>`, "<x>"]}</div>`;
    expect(out).toBeInstanceOf(Html);
    expect(out.value).toBe("<div><b>&lt;i&gt;</b><br>&lt;x&gt;</div>");
  });

  it("drops absent values and stringifies the rest", () => {
    expect(html`${null}${undefined}${false}${0}${true}`.value).toBe("false0true");
    expect(html`<b aria-selected="${Number("1") === 2}">`.value).toBe(`<b aria-selected="false">`);
  });

  it("a plain string is never mistaken for markup", () => {
    // Only `html` makes an `Html`; an object that looks like one is text.
    const fake = { value: "<script>" } as unknown as Html;
    expect(html`${fake}`.value).toBe("[object Object]");
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });
});
