import { describe, expect, it } from "vitest";
import { currentModel, MODELS } from "./jarvis";

describe("models", () => {
  it("offers the 5.5 family and moves retired picks to their successor", () => {
    expect(MODELS.map((m) => m.id)).toEqual(["", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
    expect(currentModel("claude-sonnet-5")).toBe("claude-sonnet-5-5");
    expect(currentModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-5-5");
    expect(currentModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(currentModel("")).toBe("");
    for (const id of ["claude-sonnet-5", "claude-haiku-4-5-20251001"]) expect(MODELS.some((m) => m.id === currentModel(id))).toBe(true);
  });
});
