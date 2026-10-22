import { describe, expect, it } from "vitest";
import { modelKind } from "./model3d";
import { findProject, type Listing } from "./projects";

const listing: Listing = {
  github: {
    login: "jpwalker",
    repos: [
      { owner: "Opus-Systems-OS", name: "J.A.R.V.I.S-Web", private: false, description: null, language: "Rust", pushed_at: null, html_url: "", default_branch: "main" },
      { owner: "jpwalker", name: "iron-suit", private: true, description: null, language: null, pushed_at: null, html_url: "", default_branch: "main" },
    ],
  },
  local: [{ id: 3, name: "Iron Suit", description: "Mk II", session_id: "sesn_1", created_at: 0 }],
};

describe("projects", () => {
  it("finds a project by name, Jarvis projects first", () => {
    expect(findProject(listing, "iron suit")).toBe("local:3");
    expect(findProject(listing, "jarvis-web")).toBeNull();
    expect(findProject(listing, "J.A.R.V.I.S-Web")).toBe("gh:Opus-Systems-OS/J.A.R.V.I.S-Web");
    expect(findProject(listing, "opus-systems-os/j.a.r.v.i.s-web")).toBe("gh:Opus-Systems-OS/J.A.R.V.I.S-Web");
    expect(findProject({ github: null, local: [] }, "x")).toBeNull();
  });

  it("knows which files are models", () => {
    expect(modelKind("assets/Suit.GLB")).toBe("glb");
    expect(modelKind("helmet.stl")).toBe("stl");
    expect(modelKind("scene.gltf")).toBe("gltf");
    expect(modelKind("README.md")).toBeNull();
  });
});
