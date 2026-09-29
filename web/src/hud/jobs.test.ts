import { describe, expect, it } from "vitest";
import { agentName, announcement, awayLine, jobsFrom, outcomeOf, stopped, type Job } from "./jobs";

const session = (id: string, status: string, client?: string, agent = "blueweb-ops") => ({
  id,
  status,
  title: `job ${id}`,
  updated_at: "2026-09-28T10:00:00Z",
  metadata: { iron_fleet_agent: agent, ...(client ? { iron_fleet_client: client } : {}) },
});

describe("jobs", () => {
  it("are the sessions jarvis started for other agents", () => {
    const jobs = jobsFrom([
      session("a", "running", "jarvis"),
      session("b", "idle", "web", "jarvis"),
      session("c", "idle"),
      session("d", "idle", "jarvis", "jarvis"),
    ]);
    expect(jobs.map((j) => j.id)).toEqual(["a"]);
    expect(jobs[0]).toMatchObject({ agent: "blueweb-ops", title: "job a", status: "running" });
  });

  it("names agents the way they are spoken", () => {
    expect(agentName("blueweb-ops")).toBe("BlueWeb Ops");
    expect(agentName("blueweb-client")).toBe("BlueWeb Client");
    expect(agentName("gpu-compute")).toBe("GPU Compute");
  });

  it("notices a job that stopped working since the last look", () => {
    const prev = new Map([
      ["a", "running"],
      ["b", "idle"],
      ["c", "rescheduling"],
    ]);
    const now: Job[] = [
      { id: "a", agent: "x", title: "", status: "idle" },
      { id: "b", agent: "x", title: "", status: "idle" },
      { id: "c", agent: "x", title: "", status: "running" },
      { id: "new", agent: "x", title: "", status: "idle" },
    ];
    expect(stopped(prev, now).map((j) => j.id)).toEqual(["a"]);
  });

  it("reads why it stopped from its newest events", () => {
    const msg = (text: string) => ({ type: "agent.message", content: [{ type: "text", text }] });
    const idle = (type: string) => ({ type: "session.status_idle", stop_reason: { type } });
    expect(outcomeOf([idle("end_turn"), msg("Done. The site is live.")])).toBe("finished");
    expect(outcomeOf([idle("end_turn"), msg("Which domain should it use?")])).toBe("question");
    expect(outcomeOf([idle("budget_reached"), msg("Working on it")])).toBe("budget");
    expect(outcomeOf([idle("retries_exhausted"), { type: "session.error", error: { type: "billing_error" } }])).toBe("credit");
    expect(outcomeOf([{ type: "session.error", error: { type: "overloaded_error" } }])).toBe("error");
    expect(outcomeOf([])).toBe("finished");
  });

  it("announces in one line", () => {
    const job: Job = { id: "a", agent: "blueweb-ops", title: "", status: "idle" };
    expect(announcement(job, "finished")).toBe("Sir, the BlueWeb Ops job has finished.");
    expect(announcement(job, "question")).toBe("Sir, the BlueWeb Ops job has a question for you.");
    expect(awayLine([])).toBeNull();
    expect(awayLine([job])).toBe("While you were away, the BlueWeb Ops job finished.");
    expect(awayLine([job, job])).toBe("While you were away, 2 fleet jobs finished.");
  });
});
