import { describe, expect, it } from "vitest";
import { doctorTask, followupTask, isReaCommand, isRunOutput, problem, reaTask, remember, reportFilename, targetLabel, toMarkdown, WORKFLOWS, type Run, type RunSpec } from "./model";

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  id: "abc123",
  workflow: "auto",
  kind: "upload",
  target: "",
  files: ["Notes.asar"],
  question: "How does search work?",
  deep: false,
  ...over,
});

describe("problem", () => {
  it("needs a file, a link or an absolute path", () => {
    expect(problem(spec({ files: [] }))).toMatch(/Attach/);
    expect(problem(spec())).toBeNull();
    expect(problem(spec({ kind: "url", target: "example.com" }))).toMatch(/http/);
    expect(problem(spec({ kind: "url", target: "https://example.com/a b" }))).toMatch(/http/);
    expect(problem(spec({ kind: "url", target: "https://github.com/morluto/rea" }))).toBeNull();
    expect(problem(spec({ kind: "path", target: "workspace/app" }))).toMatch(/absolute/);
    expect(problem(spec({ kind: "path", target: "/workspace/app" }))).toBeNull();
  });
});

describe("targetLabel", () => {
  it("names the run after what was investigated", () => {
    expect(targetLabel(spec({ files: ["a.dll", "b.dll"] }))).toBe("a.dll +1");
    expect(targetLabel(spec({ kind: "url", target: "https://example.com/" }))).toBe("example.com");
    expect(targetLabel(spec({ kind: "path", target: "/workspace/Iron-Fleet/" }))).toBe("Iron-Fleet");
  });
});

describe("reaTask", () => {
  it("is a [rea] turn with the target, plan, question and run directory", () => {
    const p = reaTask(spec({ workflow: "javascript" }));
    expect(p.startsWith("[rea]")).toBe(true);
    expect(p).toContain("W=/tmp/rea/abc123");
    expect(p).toContain("attached to this message");
    expect(p).toContain("rea analyze-javascript-application");
    expect(p).toContain("Question: How does search work?");
    expect(p).toContain("/mnt/session/outputs/rea-abc123-<name>.json");
  });

  it("stays static and keeps secrets out of the report", () => {
    const p = reaTask(spec());
    expect(p).toContain("Static analysis only");
    expect(p).toContain("never their values");
    expect(p).toContain("Do not help bypass licensing");
  });

  it("installs heavy engines only when allowed", () => {
    expect(reaTask(spec())).toContain("do not install Ghidra");
    expect(reaTask(spec({ deep: true }))).toContain("you may install a heavier engine");
  });

  it("downloads a link unless it is a website to observe", () => {
    expect(reaTask(spec({ kind: "url", target: "https://github.com/x/y" }))).toContain("download it into $W");
    expect(reaTask(spec({ kind: "url", workflow: "website", target: "https://example.com" }))).toContain("Target: the website https://example.com");
  });

  it("falls back to a general question", () => {
    expect(reaTask(spec({ question: "  " }))).toContain("Question: What is this, how is it built");
  });

  it("every workflow names real REA commands", () => {
    for (const w of WORKFLOWS) expect(w.plan).toMatch(/`rea [a-z-]+/);
  });
});

describe("helpers", () => {
  it("spots REA in the activity log", () => {
    expect(isReaCommand("rea inspect-artifact /tmp/x")).toBe(true);
    expect(isReaCommand("cd /tmp && rea doctor --format json")).toBe(true);
    expect(isReaCommand("npm install -g rea-agents@6.5.0")).toBe(true);
    expect(isReaCommand("cat area.txt")).toBe(false);
  });

  it("matches the run's evidence files", () => {
    expect(isRunOutput("rea-abc123-app.json", "abc123")).toBe(true);
    expect(isRunOutput("rea-zzz-app.json", "abc123")).toBe(false);
  });

  it("doctor checks readiness without analyzing anything", () => {
    expect(doctorTask()).toContain("rea doctor --format json");
  });

  it("history keeps the newest runs, one per id", () => {
    const run = (id: string): Run => ({ id, label: id, workflow: "auto", question: "", at: "", report: "x", session: null });
    let h: Run[] = [];
    for (let i = 0; i < 15; i++) h = remember(run(String(i)), h);
    h = remember(run("3"), h);
    expect(h.length).toBe(12);
    expect(h[0].id).toBe("3");
    expect(h.filter((r) => r.id === "3").length).toBe(1);
  });
});

describe("follow-ups", () => {
  const run: Run = {
    id: "abc123",
    label: "Notes.asar",
    workflow: "javascript",
    question: "How does search work?",
    at: "2026-10-17T20:00:00.000Z",
    report: "It uses FTS5.\n# How it works\n- a worker",
    session: "sesn_1",
    spec: { workflow: "javascript", kind: "url", target: "https://example.com/notes.zip", files: [], question: "How does search work?", deep: false },
  };

  it("builds on the sandbox work in the same conversation", () => {
    const p = followupTask(run, "How is ranking done?", true);
    expect(p.startsWith("[rea] Follow-up on Reverse run abc123 (Notes.asar)")).toBe(true);
    expect(p).toContain("Question: How is ranking done?");
    expect(p).toContain("W=/tmp/rea/abc123 and your report is earlier");
    expect(p).not.toContain("<<<");
    expect(p).toContain("Static analysis only");
  });

  it("carries the target and the report into a new conversation", () => {
    const p = followupTask(run, "How is ranking done?", false);
    expect(p).toContain("new conversation");
    expect(p).toContain("Target: https://example.com/notes.zip");
    expect(p).toContain("<<<\nIt uses FTS5.");
    expect(p).toContain("Node 24.15");
  });

  it("cuts a long report short", () => {
    const p = followupTask({ ...run, report: "x".repeat(20_000) }, "q", false);
    expect(p).toContain("(report cut short)");
    expect(p.length).toBeLessThan(14_000);
  });

  it("exports the run with its follow-ups as Markdown", () => {
    const md = toMarkdown({ ...run, followups: [{ q: "Ranking?", a: "BM25.", at: "" }] });
    expect(md.startsWith("# Notes.asar\n")).toBe(true);
    expect(md).toContain("- Question: How does search work?");
    expect(md).toContain("It uses FTS5.");
    expect(md).toContain("## Follow-up: Ranking?\n\nBM25.");
    expect(reportFilename(run)).toBe("rea-notes-asar-abc123.md");
  });

  it("history keeps the latest ten follow-ups", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ q: String(i), a: "a", at: "" }));
    const [kept] = remember({ ...run, followups: many }, []);
    expect(kept.followups?.length).toBe(10);
    expect(kept.followups?.[0].q).toBe("4");
  });
});
