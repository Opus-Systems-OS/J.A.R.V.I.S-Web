import { describe, expect, it } from "vitest";
import { salutation, systemsLine } from "./greeting";
import { stripWake } from "./listener";
import { sentences } from "./speaker";

describe("stripWake", () => {
  it("takes what follows the wake word", () => {
    expect(stripWake("Jarvis, what time is it")).toEqual({ woke: true, rest: "what time is it" });
    expect(stripWake("hey jarvis open the usage tab")).toEqual({ woke: true, rest: "open the usage tab" });
    expect(stripWake("OK Jarvis. How are my systems?")).toEqual({ woke: true, rest: "How are my systems?" });
  });

  it("takes a short lead-in when nothing follows", () => {
    expect(stripWake("what time is it, Jarvis")).toEqual({ woke: true, rest: "what time is it" });
  });

  it("ignores long talk that merely ends in the name", () => {
    const long = "so yesterday I was telling my friend all about how the new assistant I built works and it is called Jarvis";
    expect(stripWake(long)).toEqual({ woke: true, rest: "" });
  });

  it("does not wake on other words", () => {
    expect(stripWake("pass me the jar, Travis").woke).toBe(false);
    expect(stripWake("the weather is nice").woke).toBe(false);
  });

  it("a bare wake word arms without a request", () => {
    expect(stripWake("Jarvis")).toEqual({ woke: true, rest: "" });
  });
});

describe("sentences", () => {
  it("splits on sentence ends and keeps short fragments together", () => {
    const out = sentences("Very good, sir. The droplet is healthy and all five containers are running. Tailscale reports the rig offline.");
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.join(" ")).toContain("Very good, sir.");
  });

  it("never reads code or markdown aloud", () => {
    const out = sentences("Here you are:\n```rust\nfn main() {}\n```\n**Done**.");
    expect(out.join(" ")).not.toMatch(/fn main|\*\*|```/);
  });

  it("caps chunk length", () => {
    const long = "word ".repeat(300);
    for (const s of sentences(long)) expect(s.length).toBeLessThanOrEqual(1600);
  });

  it("empty in, nothing out", () => {
    expect(sentences("   ")).toEqual([]);
  });
});

describe("greeting", () => {
  it("salutes by Calabasas time", () => {
    expect(salutation(new Date("2026-09-23T15:00:00Z"))).toBe("Good morning, Mr. Walker"); // 08:00 PDT
    expect(salutation(new Date("2026-09-23T21:00:00Z"))).toBe("Good afternoon, Mr. Walker"); // 14:00 PDT
    expect(salutation(new Date("2026-09-24T03:00:00Z"))).toBe("Good evening, Mr. Walker"); // 20:00 PDT
    expect(salutation(new Date("2026-09-24T09:00:00Z"))).toBe("Burning the midnight oil, Mr. Walker"); // 02:00 PDT
  });

  it("summarises the systems", () => {
    const ok = (service: string) => ({ service, state: "ok", headline: "" });
    expect(systemsLine([ok("GitHub"), ok("Docker")])).toBe("Both systems are online.");
    expect(systemsLine([ok("GitHub"), { service: "Tailscale", state: "warn", headline: "" }])).toBe(
      "One of two systems is online; Tailscale is reporting a warning.",
    );
    expect(systemsLine([ok("A"), ok("B"), ok("C")])).toBe("All three systems are online.");
    expect(systemsLine([])).toMatch(/can't reach/);
  });
});
