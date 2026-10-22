import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  webGet: vi.fn(),
  web: vi.fn(),
  get: vi.fn(),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), ...api }));

import { runTool } from "./tools";

const repo = { owner: "jpwalker", name: "iron-suit", private: true, description: null, language: null, pushed_at: null, html_url: "", default_branch: "main" };

const ui = (approve: boolean) => ({
  openPanel: () => undefined,
  showRoute: () => undefined,
  openProject: async () => true,
  continueProject: async () => "none" as const,
  approve: vi.fn(async () => approve),
  session: "sesn_1",
  jobs: () => [],
  full: true,
});

describe("project file tools", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.webGet.mockImplementation(async (path: string) =>
      path === "projects"
        ? { github: { login: "jpwalker", repos: [repo] }, local: [{ id: 1, name: "Mark II", description: "", session_id: null, created_at: 0 }] }
        : { files: [{ path: "docs/spec.md", size: 10 }], truncated: false },
    );
    api.web.mockResolvedValue({ path: "docs/spec.md", from: "docs/spec.md", to: "spec.md", commit: "abcdef1234" });
  });

  it("writes nothing until he approves", async () => {
    const no = ui(false);
    const r = await runTool("project_write_file", { project: "iron-suit", path: "docs/spec.md", content: "v2" }, no);
    expect(no.approve).toHaveBeenCalledWith("Replace docs/spec.md in jpwalker/iron-suit?", "v2");
    expect(r.content).toContain("declined");
    expect(api.web).not.toHaveBeenCalled();

    const yes = ui(true);
    await runTool("project_write_file", { project: "iron-suit", path: "docs/spec.md", content: "v2" }, yes);
    expect(api.web).toHaveBeenCalledWith("projects/github/jpwalker/iron-suit/write", { path: "docs/spec.md", content: "v2", message: undefined });
  });

  it("moves only after approval, and never in a Jarvis project", async () => {
    const no = ui(false);
    await runTool("project_move_file", { project: "iron-suit", from: "docs/spec.md", to: "spec.md" }, no);
    expect(api.web).not.toHaveBeenCalled();
    const r = await runTool("project_move_file", { project: "Mark II", from: "a", to: "b" }, ui(true));
    expect(r.is_error).toBe(true);
    expect(api.web).not.toHaveBeenCalled();
  });

  it("lists which files are in a project", async () => {
    const r = await runTool("project_files", { project: "iron-suit", filter: "spec" }, ui(false));
    expect(JSON.parse(r.content)).toMatchObject({ project: "jpwalker/iron-suit", kind: "github", files: [{ path: "docs/spec.md", size: 10 }] });
  });
});
