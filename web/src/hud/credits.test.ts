import { describe, expect, it, vi } from "vitest";
import { CreditWatch, creditLine, level, type Credits } from "./credits";
import { parseCsv, parseDollars, spendFromCsv } from "./usage";

function credits(over: { anthropic?: Partial<Credits["anthropic"]>; fish?: Partial<Credits["fish"]> } = {}): Credits {
  return {
    anthropic: {
      anchor_cents: 5000,
      anchored_at: "2026-09-24T10:00:00Z",
      spent_since_cents: 100,
      remaining_cents: 4900,
      warn_below_cents: 1000,
      low: false,
      exhausted: false,
      billing_error_at: null,
      estimate: true,
      error: null,
      ...over.anthropic,
    },
    fish: { credit_usd: "12.34", warn_below_cents: 200, low: false, error: null, ...over.fish },
  };
}

const low = credits({ anthropic: { remaining_cents: 840, low: true } });
const out = credits({ anthropic: { exhausted: true, billing_error_at: "2026-09-24T12:00:00Z" } });
const fishLow = credits({ fish: { credit_usd: "1.2", low: true } });

describe("creditLine", () => {
  it("says nothing when all is well, or when no balance is set", () => {
    expect(creditLine(credits())).toBeNull();
    expect(creditLine(credits({ anthropic: { anchor_cents: null, remaining_cents: null } }))).toBeNull();
  });

  it("warns with the estimate when low", () => {
    expect(creditLine(low)).toBe("A word of warning, sir: the Anthropic balance is down to about $8.40.");
    expect(creditLine(credits({ anthropic: { remaining_cents: -30, low: true } }))).toContain("by my ledger the Anthropic balance is spent");
  });

  it("says exhausted over low", () => {
    expect(creditLine(credits({ anthropic: { exhausted: true, low: true, remaining_cents: 5 } }))).toBe(
      "The Anthropic account is out of credit, sir; I can't think until it's topped up.",
    );
  });

  it("covers Fish, alone or alongside", () => {
    expect(creditLine(fishLow)).toBe("Voice credit is running low: $1.20 left.");
    const both = credits({ anthropic: { remaining_cents: 840, low: true }, fish: { credit_usd: "1.2", low: true } });
    expect(creditLine(both)).toMatch(/about \$8\.40\. Voice credit is running low/);
  });

  it("levels", () => {
    expect([credits(), low, fishLow, out].map(level)).toEqual(["ok", "low", "low", "exhausted"]);
  });
});

describe("CreditWatch", () => {
  const watch = () => {
    const warned: string[] = [];
    const w = new CreditWatch({ onCredits: vi.fn(), onWarn: (l) => warned.push(l) }, async () => credits());
    return { w, warned };
  };

  it("the first reading is only a baseline (the greeting spoke it)", () => {
    const { w, warned } = watch();
    w.observe(low);
    expect(warned).toEqual([]);
  });

  it("warns once per crossing, and again after a recovery", () => {
    const { w, warned } = watch();
    w.observe(credits());
    w.observe(low);
    w.observe(low);
    w.observe(credits({ anthropic: { remaining_cents: 700, low: true } }));
    expect(warned).toHaveLength(1);
    w.observe(out);
    expect(warned).toHaveLength(2);
    expect(warned[1]).toContain("out of credit");
    w.observe(credits()); // topped up, new balance set
    w.observe(low);
    expect(warned).toHaveLength(3);
  });

  it("a second balance going low still warns", () => {
    const { w, warned } = watch();
    w.observe(low);
    w.observe(credits({ anthropic: { remaining_cents: 840, low: true }, fish: { credit_usd: "1.2", low: true } }));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("Voice credit");
  });

  it("a billing error Jarvis already spoke is not repeated by the poll", () => {
    const { w, warned } = watch();
    w.observe(credits());
    w.markExhausted();
    w.observe(out);
    expect(warned).toEqual([]);
  });
});

describe("usage CSV", () => {
  const header =
    "session_id,agent_slug,environment_slug,list_cost_cents,input_tokens,output_tokens,active_seconds,budget_reached,last_event_type,observed_at,last_error";

  it("parses quoted fields", () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\n')).toEqual([
      ["a", "b"],
      ["1", 'x, "y"'],
    ]);
  });

  it("buckets by Pacific day and by agent over the window", () => {
    // 2026-09-24 12:00 Pacific.
    const now = new Date("2026-09-24T19:00:00Z");
    const csv = [
      header,
      "s1,jarvis,jarvis-lab,120,1,1,1,0,session.status_idle,2026-09-24T18:00:00Z,",
      // 02:00 UTC on the 24th is still the 23rd in Pacific time.
      "s2,gpu-compute,rig-gpu,300,1,1,1,1,session.status_idle,2026-09-24T02:00:00Z,",
      "s3,jarvis,jarvis-lab,,1,1,1,0,session.error,2026-09-23T20:00:00Z,\"billing_error: too low, sorry\"",
      // Outside a 7-day window.
      "s4,jarvis,jarvis-lab,999,1,1,1,0,session.status_idle,2026-09-10T20:00:00Z,",
    ].join("\n");
    const s = spendFromCsv(csv, 7, now);
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toMatchObject({ key: "2026-09-24", cents: 120, sessions: 1 });
    expect(s.days[5]).toMatchObject({ key: "2026-09-23", cents: 300, sessions: 2 });
    expect(s.totalCents).toBe(420);
    expect(s.agents).toEqual([
      { agent: "gpu-compute", cents: 300, sessions: 1, budgetHits: 1 },
      { agent: "jarvis", cents: 120, sessions: 2, budgetHits: 0 },
    ]);
  });

  it("an empty export is an empty window", () => {
    const s = spendFromCsv(header + "\n", 30, new Date("2026-09-24T19:00:00Z"));
    expect(s.days).toHaveLength(30);
    expect(s.totalCents).toBe(0);
    expect(s.agents).toEqual([]);
  });
});

describe("parseDollars", () => {
  it("reads what people type", () => {
    expect(parseDollars("9")).toBe(900);
    expect(parseDollars("$9.5")).toBe(950);
    expect(parseDollars(" 1,234.56 ")).toBe(123456);
    expect(parseDollars("9.999")).toBeNull();
    expect(parseDollars("-3")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});
