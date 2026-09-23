// Tools the page declares on its own jarvis session and executes itself
// (session-local custom tools: the agent resource never sees them, other
// clients' sessions never get them). Each reads through /bff, so Jarvis can
// see exactly what this page can — and nothing it can't. All read-only
// except `open_panel`, which only moves the HUD.

import { get } from "../api";

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
  ui: { openPanel(tab: string): void },
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
