// Jobs: sessions Jarvis dispatched to other fleet agents (BlueWeb, the rig).
// mcp-fleet tags every session it starts `iron_fleet_client=jarvis`, so the
// fleet's own session list is the source; the page keeps only when it last
// looked. When a job stops working, the HUD says so in a template line — no
// model call — and Jarvis relays the detail when asked (get_session_status).

import { get } from "../api";
import type { ContentBlock } from "./transcript";

export interface Job {
  id: string;
  agent: string;
  title: string;
  status: string;
  updatedAt?: string;
}

export type Outcome = "finished" | "question" | "budget" | "credit" | "error";

interface RawSession {
  id: string;
  status: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, string>;
}

interface RawEvent {
  type: string;
  content?: ContentBlock[];
  stop_reason?: { type?: string };
  error?: { type?: string };
}

const SEEN_KEY = "jarvis.jobs.seen";
const WORKING = new Set(["running", "rescheduling"]);

/** The sessions jarvis started for another agent, newest first. */
export function jobsFrom(sessions: RawSession[]): Job[] {
  return sessions
    .filter((s) => s.metadata?.iron_fleet_client === "jarvis" && s.metadata?.iron_fleet_agent !== "jarvis")
    .map((s) => ({
      id: s.id,
      agent: s.metadata?.iron_fleet_agent ?? "agent",
      title: s.title || s.id,
      status: s.status,
      updatedAt: s.updated_at ?? s.created_at,
    }));
}

/** "blueweb-ops" → "BlueWeb Ops". */
export function agentName(slug: string): string {
  const special: Record<string, string> = { blueweb: "BlueWeb", gpu: "GPU" };
  return slug
    .split("-")
    .map((w) => special[w] ?? `${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    .join(" ");
}

/** Jobs that were working at the last look and aren't now. */
export function stopped(prev: Map<string, string>, jobs: Job[]): Job[] {
  return jobs.filter((j) => WORKING.has(prev.get(j.id) ?? "") && !WORKING.has(j.status));
}

/** What a job's newest events say about why it stopped. */
export function outcomeOf(newestFirst: RawEvent[]): Outcome {
  const idle = newestFirst.find((e) => e.type === "session.status_idle");
  if (idle?.stop_reason?.type === "budget_reached") return "budget";
  const last = newestFirst.find((e) => e.type === "agent.message" || e.type === "session.error");
  if (last?.type === "session.error") return last.error?.type === "billing_error" ? "credit" : "error";
  const text = (last?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return text.endsWith("?") ? "question" : "finished";
}

export function announcement(job: Job, outcome: Outcome): string {
  const who = `the ${agentName(job.agent)} job`;
  switch (outcome) {
    case "question":
      return `Sir, ${who} has a question for you.`;
    case "budget":
      return `Sir, ${who} stopped at its budget.`;
    case "credit":
      return `Sir, ${who} stopped: the Anthropic account is out of credit.`;
    case "error":
      return `Sir, ${who} stopped on an error.`;
    default:
      return `Sir, ${who} has finished.`;
  }
}

/** One line for jobs that stopped while no HUD was watching. */
export function awayLine(jobs: Job[]): string | null {
  if (!jobs.length) return null;
  if (jobs.length === 1) return `While you were away, the ${agentName(jobs[0].agent)} job finished.`;
  return `While you were away, ${jobs.length} fleet jobs finished.`;
}

function loadSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}
function saveSeen(iso: string) {
  try {
    localStorage.setItem(SEEN_KEY, iso);
  } catch {
    /* private mode: the away line just repeats */
  }
}

export class JobWatch {
  private last = new Map<string, string>();
  private jobs: Job[] = [];
  private timer = 0;
  private first = true;

  constructor(
    private readonly on: {
      onJobs(jobs: Job[]): void;
      onAnnounce(line: string): void;
    },
  ) {}

  get current(): Job[] {
    return this.jobs;
  }

  start() {
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), 30_000);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  async poll() {
    let sessions: RawSession[];
    try {
      sessions = (await get<{ data: RawSession[] }>("sessions?limit=30&order=desc")).data;
    } catch {
      return;
    }
    const jobs = jobsFrom(sessions);
    if (this.first) {
      this.first = false;
      const seen = loadSeen();
      const away = seen
        ? jobs.filter((j) => !WORKING.has(j.status) && j.updatedAt && Date.parse(j.updatedAt) > Date.parse(seen))
        : [];
      const line = awayLine(away);
      if (line) this.on.onAnnounce(line);
    } else {
      for (const job of stopped(this.last, jobs)) {
        const events = await get<{ data: RawEvent[] }>(
          `sessions/${job.id}/events?order=desc&types=agent.message,session.error,session.status_idle&limit=3`,
        ).catch(() => ({ data: [] as RawEvent[] }));
        this.on.onAnnounce(announcement(job, outcomeOf(events.data)));
      }
    }
    saveSeen(new Date().toISOString());
    this.last = new Map(jobs.map((j) => [j.id, j.status]));
    this.jobs = jobs;
    this.on.onJobs(jobs);
  }
}

/** The `fleet_jobs` tool's answer: compact, newest first. */
export function compactJobs(jobs: Job[]): unknown {
  return jobs.slice(0, 12).map((j) => ({
    session_id: j.id,
    agent: j.agent,
    title: j.title,
    status: j.status,
    updated_at: j.updatedAt,
  }));
}
