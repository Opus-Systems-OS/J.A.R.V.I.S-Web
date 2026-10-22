import { describe, expect, it } from "vitest";
import { kindOf, numberLines } from "./fileview";

describe("file kinds", () => {
  it("sorts files into models, docs, code and the rest", () => {
    expect(kindOf("assets/suit.glb")).toBe("model");
    expect(kindOf("docs/README.md")).toBe("doc");
    expect(kindOf("server/src/main.rs")).toBe("code");
    expect(kindOf("Dockerfile")).toBe("code");
    expect(kindOf("web/package.json")).toBe("code");
    expect(kindOf("photo.png")).toBe("other");
    expect(kindOf("binary")).toBe("other");
  });

  it("numbers code lines, padded, keeping the text as it is", () => {
    expect(numberLines("fn main() {\r\n  <b>x</b>\n}\n")).toEqual([
      ["1", "fn main() {"],
      ["2", "  <b>x</b>"],
      ["3", "}"],
    ]);
    expect(numberLines(Array(10).fill("x").join("\n"))[0][0]).toBe(" 1");
  });
});
