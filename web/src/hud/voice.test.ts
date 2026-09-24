import { afterEach, describe, expect, it, vi } from "vitest";
import { salutation, systemsLine } from "./greeting";
import { ASSEMBLE_MS, Listener, stripWake } from "./listener";
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

describe("listener gating (no ambient chains)", () => {
  const make = () => {
    vi.useFakeTimers();
    const commands: string[] = [];
    const l = new Listener({ onCommand: (t) => commands.push(t), onHearing: () => {}, onState: () => {} });
    const hear = (text: string) => {
      (l as unknown as { onFinal(t: string): void }).onFinal(text);
      vi.advanceTimersByTime(ASSEMBLE_MS + 10); // a pause long enough to end the request
    };
    return { l, commands, hear };
  };
  afterEach(() => vi.useRealTimers());

  it("ignores speech without the wake word", () => {
    const { commands, hear } = make();
    hear("two plus three makes five");
    expect(commands).toEqual([]);
  });

  it("no follow-up after a statement or the greeting", () => {
    const { l, commands, hear } = make();
    l.resumeAfterSpeech(false);
    hear("well now I add in columns");
    expect(commands).toEqual([]);
  });

  it("one follow-up after a question, then the wake word again", () => {
    const { l, commands, hear } = make();
    hear("Jarvis, start the build");
    l.resumeAfterSpeech(true); // "Shall I use the rig?"
    hear("yes use the rig");
    expect(commands).toEqual(["start the build", "yes use the rig"]);
    l.resumeAfterSpeech(true); // he asks again — but that turn was a follow-up
    hear("put that over to the side");
    expect(commands).toHaveLength(2);
    hear("Jarvis, status");
    expect(commands).toEqual(["start the build", "yes use the rig", "status"]);
  });

  it("a one-word follow-up is not an answer", () => {
    const { l, commands, hear } = make();
    hear("Jarvis, deploy?");
    l.resumeAfterSpeech(true);
    hear("yeah");
    expect(commands).toEqual(["deploy?"]);
  });
});

describe("request assembly (long sentences)", () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    vi.useFakeTimers();
    const commands: string[] = [];
    const l = new Listener({ onCommand: (t) => commands.push(t), onHearing: () => {}, onState: () => {} });
    const final = (t: string) => (l as unknown as { onFinal(t: string): void }).onFinal(t);
    return { l, commands, final };
  };

  it("joins the pieces of a sentence split at a pause", () => {
    const { commands, final } = setup();
    final("Jarvis, I just conducted research");
    vi.advanceTimersByTime(800); // a thinking pause, shorter than the window
    final("on black widow venom");
    vi.advanceTimersByTime(600);
    final("and found significant overlap with other spiders");
    expect(commands).toEqual([]); // still assembling
    vi.advanceTimersByTime(ASSEMBLE_MS + 10);
    expect(commands).toEqual([
      "I just conducted research on black widow venom and found significant overlap with other spiders",
    ]);
  });

  it("speech still in progress holds the request open", () => {
    const { l, commands, final } = setup();
    final("Jarvis, summarise the control plane");
    const interim = (t: string) =>
      (l as unknown as { onResult(e: unknown): void }).onResult({
        resultIndex: 0,
        results: [{ isFinal: false, 0: { transcript: t } }],
      });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      interim("and its sessions module"); // still talking
    }
    expect(commands).toEqual([]);
    final("and its sessions module");
    vi.advanceTimersByTime(ASSEMBLE_MS + 10);
    expect(commands).toEqual(["summarise the control plane and its sessions module"]);
  });

  it("cloud ears: a request never closes while the next phrase is being spoken", () => {
    const { l, commands, final } = setup();
    const hearing = (active: boolean) => (l as unknown as { speaking: boolean }).speaking = active;
    hearing(true); // phrase 2 already under way…
    final("Jarvis, compare the two genomes"); // …when phrase 1's text comes back
    vi.advanceTimersByTime(5_000);
    expect(commands).toEqual([]);
    hearing(false);
    (l as unknown as { scheduleFlush(): void }).scheduleFlush(); // what the engine's hearing(false) does
    final("for venom genes"); // phrase 2's text
    vi.advanceTimersByTime(ASSEMBLE_MS + 10);
    expect(commands).toEqual(["compare the two genomes for venom genes"]);
  });

  it("the same request twice in a row is sent once", () => {
    const { commands, final } = setup();
    final("Jarvis, this is a test");
    vi.advanceTimersByTime(ASSEMBLE_MS + 10);
    final("Jarvis, this is a test");
    vi.advanceTimersByTime(ASSEMBLE_MS + 10);
    expect(commands).toEqual(["this is a test"]);
  });
});

describe("listener on a browser without the speech service (Arc)", () => {
  it("stops after three failed starts instead of flickering forever", async () => {
    vi.useFakeTimers();
    let starts = 0;
    class FailingRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onresult: (() => void) | null = null;
      start() {
        starts++;
        queueMicrotask(() => {
          this.onstart?.();
          this.onerror?.({ error: "network" });
          this.onend?.();
        });
      }
      stop() {}
      abort() {}
    }
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = globalThis;
    g.webkitSpeechRecognition = FailingRecognition;
    const states: string[] = [];
    const l = new Listener({ onCommand: () => {}, onHearing: () => {}, onState: (s) => states.push(s) });
    l.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toBe(3);
    expect(states.at(-1)).toBe("unavailable");
    // Jarvis speaking afterwards must not bring the loop back.
    l.resumeAfterSpeech(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(starts).toBe(3);
    delete g.webkitSpeechRecognition;
    vi.useRealTimers();
  });
});

describe("ago", () => {
  it("rounds to the largest sensible unit", async () => {
    const { ago } = await import("./fleet");
    const now = Date.parse("2026-09-24T03:00:00Z");
    expect(ago("2026-09-24T02:59:30Z", now)).toBe("30s ago");
    expect(ago("2026-09-24T02:45:00Z", now)).toBe("15m ago");
    expect(ago("2026-09-23T22:00:00Z", now)).toBe("5h ago");
    expect(ago("2026-09-21T03:00:00Z", now)).toBe("3d ago");
    expect(ago(undefined, now)).toBe("");
  });
});
