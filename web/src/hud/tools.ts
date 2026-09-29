// Tools the page declares on its own jarvis session and executes itself
// (session-local custom tools: the agent resource never sees them, other
// clients' sessions never get them). Each reads through /bff, so Jarvis can
// see exactly what this page can — and nothing it can't. All read-only
// except `open_panel`, which only moves the HUD.

import { get } from "../api";
import { compactBriefing, type Briefing } from "./briefing";
import { compactJobs, type Job } from "./jobs";
import * as reminders from "./reminders";

export interface ToolDef {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TABS = ["HUD", "Fleet", "Systems", "Usage", "Terminal"];

export const TOOLS: ToolDef[] = [
  {
    type: "custom",
    name: "opus_status",
    description:
      "Live status of every Opus Systems OS service: the GitHub org, UptimeRobot monitors, the droplet (DigitalOcean), " +
      "its Docker containers, the Tailscale tailnet (the rig, the Mac), Cloudflare, and whether the RTX rig's local " +
      "models are online. Use it whenever the user asks how things are, whether something is up, or before you " +
      "diagnose a problem. Returns compact JSON rows (service, state ok/warn/down, headline).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "fleet_usage",
    description:
      "Spend by the fleet's agents at list price, from the control plane's usage rollups: totals per agent and the most " +
      "recent sessions with their cost. Use for 'how much have I spent', 'what did that cost', or which agent is " +
      "expensive. Optional `since` is an RFC 3339 time or YYYY-MM-DD date.",
    input_schema: {
      type: "object",
      properties: { since: { type: "string", description: "Start of the window, e.g. 2026-09-01" } },
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "fleet_jobs",
    description:
      "The jobs you dispatched to other fleet agents with start_session (BlueWeb, the rig), newest first: session_id, " +
      "agent, title, status (running, idle, terminated) and when it last changed. Use it to find a job's session_id " +
      "when he asks how a job is going, then get_session_status for what it said. Works across conversations.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "briefing",
    description:
      "His day right now: weather in Calabasas, today's calendar, unread Gmail (newest senders and subjects), YouTube " +
      "views this week against last, WHOOP recovery, sleep and strain, and the Buffer posting queue. Each source is a " +
      "row with state ok/warn/down; a down row says why (e.g. not connected yet). Use it for 'how's my day', 'any " +
      "email', 'what's on today', 'how did I sleep', and before summarizing his morning.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "set_reminder",
    description:
      "Set a reminder that the HUD speaks when it is due (or at his next unlock if no HUD is open). Give either " +
      "in_minutes, or at as Calabasas wall time 'YYYY-MM-DDTHH:MM' (or RFC 3339 with an offset). If you don't know " +
      "today's date, call list_reminders first: it returns the current time. Confirm the time back to him in words.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind him of, as it should be said: 'call Josh about the invoice'" },
        at: { type: "string", description: "Calabasas wall time, e.g. 2026-09-29T09:00" },
        in_minutes: { type: "number", description: "Minutes from now, instead of at" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "list_reminders",
    description: "The reminders not yet spoken (id, text, due_at, due), and the current time in Calabasas as `now`.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "cancel_reminder",
    description: "Cancel a reminder by the id list_reminders gave.",
    input_schema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "open_panel",
    description:
      "Switch the HUD the user is looking at to one of its tabs: HUD (the orb), Fleet (agents and sessions), Systems " +
      "(the architecture map), Usage (spend and credits), Terminal. Use when the user says 'show me …' or 'open …'.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", enum: TABS } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

type Json = Record<string, unknown>;

/** `/v1/ops` → `{services: [{id, name, state, headline, checked_at}]}`, trimmed. */
export function compactOps(ops: Json): { service: string; state: string; headline: string }[] {
  const rows = Array.isArray(ops.services) ? (ops.services as Json[]) : [];
  return rows.map((r) => ({
    service: String(r.name ?? r.id ?? "?"),
    state: String(r.state ?? "unknown"),
    headline: String(r.headline ?? ""),
  }));
}

/** `/v1/usage` → per-agent totals and the last few sessions, in dollars. */
function compactUsage(u: Json): unknown {
  const dollars = (c: unknown) => (Number(c) / 100).toFixed(2);
  const byAgent = Array.isArray(u.by_agent) ? (u.by_agent as Json[]) : [];
  const recent = Array.isArray(u.recent) ? (u.recent as Json[]).slice(0, 8) : [];
  return {
    window: u.window,
    by_agent: byAgent.map((a) => ({
      agent: a.agent_slug,
      sessions: a.session_count,
      usd: dollars(a.total_list_cost_cents),
      budget_reached: a.budget_reached_count,
    })),
    recent: recent.map((r) => ({
      agent: r.agent_slug,
      usd: dollars(r.list_cost_cents),
      at: r.observed_at,
      error: r.last_error ?? undefined,
    })),
  };
}

export async function runTool(
  name: string,
  input: unknown,
  ui: { openPanel(tab: string): void; jobs(): Job[] },
): Promise<{ content: string; is_error?: boolean }> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "opus_status": {
        const [ops, rig] = await Promise.allSettled([get<Json>("ops"), get<Json>("rig")]);
        return {
          content: JSON.stringify({
            services: ops.status === "fulfilled" ? compactOps(ops.value) : `unavailable: ${String(ops.reason)}`,
            rig: rig.status === "fulfilled" ? rig.value : "offline",
          }),
        };
      }
      case "fleet_usage": {
        const since = typeof args.since === "string" && args.since ? `?since=${encodeURIComponent(args.since)}` : "";
        const usage = await get<Json>(`usage${since}`);
        return { content: JSON.stringify(compactUsage(usage)) };
      }
      case "briefing": {
        const b = await get<Briefing>("briefing");
        return { content: JSON.stringify(compactBriefing(b)) };
      }
      case "set_reminder": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        const at = reminders.resolveAt(args);
        if (!text || !at) {
          return {
            content: `need text and either in_minutes or at as YYYY-MM-DDTHH:MM (Calabasas); it is now ${reminders.laNow()}`,
            is_error: true,
          };
        }
        const r = await reminders.create(text, at);
        return { content: JSON.stringify({ set: { id: r.id, text: r.text, due_at: reminders.laIso(new Date(r.due_at)) }, now: reminders.laNow() }) };
      }
      case "list_reminders": {
        const list = await reminders.pending();
        return {
          content: JSON.stringify({
            now: reminders.laNow(),
            reminders: list.map((r) => ({ id: r.id, text: r.text, due_at: reminders.laIso(new Date(r.due_at)), due: r.due })),
          }),
        };
      }
      case "cancel_reminder": {
        const id = Number(args.id);
        if (!Number.isInteger(id)) return { content: "id must be a reminder id from list_reminders", is_error: true };
        await reminders.cancel(id);
        return { content: `cancelled reminder ${id}` };
      }
      case "fleet_jobs":
        return { content: JSON.stringify(compactJobs(ui.jobs())) };
      case "open_panel": {
        const tab = String(args.name ?? "");
        if (!TABS.includes(tab)) return { content: `unknown panel ${tab}`, is_error: true };
        ui.openPanel(tab);
        return { content: `showing ${tab}` };
      }
      default:
        return { content: `this page has no tool named ${name}`, is_error: true };
    }
  } catch (e) {
    return { content: `tool failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
  }
}
