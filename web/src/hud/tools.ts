// Tools the page declares on its own jarvis session and executes itself
// (session-local custom tools: the agent resource never sees them, other
// clients' sessions never get them). Each reads through /bff, so Jarvis can
// see exactly what this page can — and nothing it can't. All read-only
// except `open_panel`, which only moves the HUD, `set_location`, which only
// changes where this browser thinks he is, and the reminders.

import { get, webGet } from "../api";
import { compactBriefing, withLocalWeather, type Briefing } from "./briefing";
import { compactJobs, type Job } from "./jobs";
import * as location from "./location";
import * as reminders from "./reminders";
import { createProject, listProjects } from "./projects";
import { miles, minutes, shortName, type Route } from "./route";
import * as watch from "./intel/watch";

export interface ToolDef {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The HUD's tabs: the owner's, and everyone else's (no Systems). */
export const TABS_FULL = ["HUD", "Fleet", "Projects", "Intel", "Reverse", "Systems", "Usage", "Terminal"];
export const TABS_LIMITED = ["HUD", "Fleet", "Projects", "Intel", "Reverse", "Systems", "Usage", "Terminal"];
export const tabsFor = (full: boolean) => (full ? TABS_FULL : TABS_LIMITED);

/** The owner's alone: the services, his day, the jobs he dispatched. */
const OWNER_ONLY = new Set(["fleet_jobs", "briefing"]);

const openPanelTool = (tabs: string[]): ToolDef => ({
  type: "custom",
  name: "open_panel",
  description:
    `Switch the HUD the user is looking at to one of its tabs: ${tabs.join(", ")}. HUD is the orb, Fleet the agents and ` +
    "sessions, Projects his GitHub repos and Jarvis projects (with their 3D models), Usage spend, Terminal the sandbox" +
    (tabs.includes("Systems") ? ", Systems the architecture map" : "") +
    (tabs.includes("Intel") ? ", Intel the live news and hazards globe" : "") +
    (tabs.includes("Reverse") ? ", Reverse the reverse-engineering bench (REA)" : "") +
    ". Use when the user says 'show me …' or 'open …'.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", enum: tabs } },
    required: ["name"],
    additionalProperties: false,
  },
});

/** What a profile's session declares: everything for the owner; for anyone
 * else, no systems, briefing or jobs (their key can't read them anyway). */
export function toolsFor(full: boolean): ToolDef[] {
  return [...TOOLS.filter((t) => full || !OWNER_ONLY.has(t.name)), openPanelTool(tabsFor(full))];
}

const TOOLS: ToolDef[] = [
  {
    type: "custom",
    name: "location",
    description:
      "Where he is right now, as this HUD knows it (from his browser's location, or a place he told you): place, " +
      "region, country, time zone, his local time as `now`, and the current weather there. Use it for 'what's the " +
      "weather', 'what time is it', or anything that depends on where he is. `known: false` means ask him.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "set_location",
    description:
      "Set where he is when he tells you ('I'm in Austin', 'I'm back home in Calabasas'). Give the place as a city, " +
      "optionally with its state or country: 'Austin, TX', 'London, UK'. Times, reminders and weather follow it. " +
      "It holds for a few hours over what his device reports, then his device's location takes over again.",
    input_schema: {
      type: "object",
      properties: { place: { type: "string", description: "City, with state or country if ambiguous, e.g. Austin, TX" } },
      required: ["place"],
      additionalProperties: false,
    },
  },
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
      "His day right now: the weather where he is, today's calendar, unread Gmail (newest senders and subjects), YouTube " +
      "views this week against last, WHOOP recovery, sleep and strain, and the Buffer posting queue. Each source is a " +
      "row with state ok/warn/down; a down row says why (e.g. not connected yet). Use it for 'how's my day', 'any " +
      "email', 'what's on today', 'how did I sleep', and before summarizing his morning.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "intel_feed",
    description:
      "What is happening right now, from the Intel tab's live feeds: US and world news wires (Google News, NPR, BBC, CBS, ABC, " +
      "Guardian, Al Jazeera) and hazards (USGS earthquakes, NASA EONET wildfires and storms, CAL FIRE, InciWeb, NWS severe alerts), " +
      "newest first, each with category, place, source and time. Optional `filter` keeps items whose title, place or category " +
      "contains it (e.g. 'California', 'fire', 'Ukraine'). Use it for 'what's going on', 'any fires', 'news in Texas'.",
    input_schema: {
      type: "object",
      properties: { filter: { type: "string", description: "A word to match, e.g. California" } },
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "projects_list",
    description:
      "His projects: Jarvis projects (ones that live here, in the Projects tab) and his GitHub repos (his own account's and " +
      "the Opus-Systems-OS org's), with language, private or public, and last push.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "project_create",
    description:
      "Start a new project. If he hasn't said which kind, first ask exactly: \"Shall this be a GitHub repository or a " +
      "project on here?\" kind github makes a repository (private unless he says public; in his own account unless he " +
      "says the Opus-Systems-OS org); kind here makes a Jarvis project tied to this conversation, so the files and 3D " +
      "models you make in your sandbox show up in it. Confirm the name back to him.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "For GitHub: letters, digits, . - _ only, e.g. iron-suit" },
        kind: { type: "string", enum: ["github", "here"] },
        description: { type: "string" },
        private: { type: "boolean", description: "GitHub only; true unless he says public" },
        org: { type: "boolean", description: "GitHub only; true to create it in Opus-Systems-OS" },
      },
      required: ["name", "kind"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "project_open",
    description: "Open the Projects tab on one of his projects, by name, showing its details and 3D models.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "directions",
    description:
      "Driving directions to an address, business or place, from where he is (or from `from`, a place he names): distance, " +
      "time, arrival time and the first steps. Then ask him exactly: \"Shall I open this in Apple Maps, or show it here?\" " +
      "and call show_route with his answer.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Where to: an address, a business or a place, e.g. LAX or 123 Main St, Austin" },
        from: { type: "string", description: "Only if he names a start other than where he is" },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "show_route",
    description:
      "Show the route the last directions call found: apple_maps puts an Open in Apple Maps button in the transcript (he " +
      "taps it; on an iPhone or Mac it opens the Maps app), here draws it on the Intel globe with turn-by-turn steps.",
    input_schema: {
      type: "object",
      properties: { where: { type: "string", enum: ["apple_maps", "here"] } },
      required: ["where"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "watch_add",
    description:
      "Add to his Intel watchlist: the HUD then tells him aloud when a new story matches (checked every 5 minutes, and at " +
      "unlock for anything that came in while he was away). Give a term (a word in the headline, or a category: fire, " +
      "violence, conflict, unrest, disaster, weather, politics, health, economy), a place to watch near ('me' for where he " +
      "is), or both: 'tell me about fires near me' is term fire, near me. Confirm back what you set.",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string", description: "A word to match, e.g. Ukraine, or a category, e.g. fire" },
        near: { type: "string", description: "A place, e.g. Calabasas or Austin, TX, or 'me'" },
        radius_mi: { type: "number", description: "Miles around near; 50 if not said" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "watch_list",
    description: "His Intel watchlist: each watch's id and what it watches for.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "custom",
    name: "watch_remove",
    description: "Take a watch off his Intel watchlist, by the id watch_list gave.",
    input_schema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "set_reminder",
    description:
      "Set a reminder that the HUD speaks when it is due (or at his next unlock if no HUD is open). Give either " +
      "in_minutes, or at as his local wall time 'YYYY-MM-DDTHH:MM' (or RFC 3339 with an offset). If you don't know " +
      "today's date, call list_reminders first: it returns the current time. Confirm the time back to him in words.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind him of, as it should be said: 'call Josh about the invoice'" },
        at: { type: "string", description: "His local wall time, e.g. 2026-09-29T09:00" },
        in_minutes: { type: "number", description: "Minutes from now, instead of at" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "list_reminders",
    description: "The reminders not yet spoken (id, text, due_at, due), and the current time where he is as `now`.",
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
];

type Json = Record<string, unknown>;
/** The route the last `directions` call found, for `show_route`. */
let lastRoute: Route | null = null;
type IntelFeed = import("./intel/model").Feed;

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

/** What the `location` tools answer. */
function compactHere(): unknown {
  const h = location.here();
  const base = { now: reminders.localNow(), time_zone: location.localZone() };
  if (!h) return { known: false, ...base, note: "ask him where he is, then call set_location" };
  return {
    known: true,
    place: location.placeName(h) ?? undefined,
    lat: h.lat,
    lon: h.lon,
    from: h.source === "named" ? "he said so" : "his device",
    ...base,
    weather: location.freshWeather(h) ?? undefined,
  };
}

export async function runTool(
  name: string,
  input: unknown,
  ui: {
    openPanel(tab: string): void;
    showRoute(r: Route, where: "apple_maps" | "here"): void;
    openProject(name: string): Promise<boolean>;
    /** The conversation the tool was called in. */
    session: string | null;
    jobs(): Job[];
    full: boolean;
  },
): Promise<{ content: string; is_error?: boolean }> {
  const args = (input ?? {}) as Record<string, unknown>;
  if (!ui.full && OWNER_ONLY.has(name)) return { content: `this page has no tool named ${name}`, is_error: true };
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
        const [b] = await Promise.all([get<Briefing>("briefing"), location.refresh().catch(() => null)]);
        return { content: JSON.stringify(compactBriefing(withLocalWeather(b, location.freshWeather()))) };
      }
      case "location": {
        await location.refresh().catch(() => null);
        return { content: JSON.stringify(compactHere()) };
      }
      case "set_location": {
        const place = typeof args.place === "string" ? args.place.trim() : "";
        if (!place) return { content: "need place, e.g. Austin, TX", is_error: true };
        await location.locateNamed(place);
        return { content: JSON.stringify(compactHere()) };
      }
      case "set_reminder": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        const at = reminders.resolveAt(args);
        if (!text || !at) {
          return {
            content: `need text and either in_minutes or at as YYYY-MM-DDTHH:MM (his local time); it is now ${reminders.localNow()}`,
            is_error: true,
          };
        }
        const r = await reminders.create(text, at);
        return { content: JSON.stringify({ set: { id: r.id, text: r.text, due_at: reminders.localIso(new Date(r.due_at)) }, now: reminders.localNow() }) };
      }
      case "list_reminders": {
        const list = await reminders.pending();
        return {
          content: JSON.stringify({
            now: reminders.localNow(),
            time_zone: location.localZone(),
            reminders: list.map((r) => ({ id: r.id, text: r.text, due_at: reminders.localIso(new Date(r.due_at)), due: r.due })),
          }),
        };
      }
      case "cancel_reminder": {
        const id = Number(args.id);
        if (!Number.isInteger(id)) return { content: "id must be a reminder id from list_reminders", is_error: true };
        await reminders.cancel(id);
        return { content: `cancelled reminder ${id}` };
      }
      case "projects_list": {
        const l = await listProjects();
        return {
          content: JSON.stringify({
            jarvis_projects: l.local.map((p) => ({ name: p.name, description: p.description || undefined })),
            github: l.github
              ? {
                  login: l.github.login,
                  repos: l.github.repos.slice(0, 80).map((r) => ({
                    name: r.name,
                    owner: r.owner,
                    private: r.private,
                    language: r.language ?? undefined,
                    pushed_at: r.pushed_at ?? undefined,
                  })),
                }
              : { unavailable: l.github_error },
          }),
        };
      }
      case "project_create": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const kind = args.kind === "github" ? "github" : args.kind === "here" ? "here" : null;
        if (!name || !kind) return { content: "need name, and kind github or here (ask him which)", is_error: true };
        const made = await createProject({
          kind,
          name,
          description: typeof args.description === "string" ? args.description : undefined,
          private: args.private !== false,
          org: args.org === true,
          session: ui.session,
        });
        await ui.openProject(made);
        return { content: JSON.stringify({ created: made, kind, shown: "in the Projects tab" }) };
      }
      case "project_open": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return { content: "need name", is_error: true };
        return (await ui.openProject(name))
          ? { content: `showing ${name} in the Projects tab` }
          : { content: `no project called ${name}: call projects_list`, is_error: true };
      }
      case "directions": {
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (!to) return { content: "need to: where he wants to go", is_error: true };
        let start: { lat: number; lon: number } | null = location.here();
        const from = typeof args.from === "string" ? args.from.trim() : "";
        if (from) start = await webGet<{ lat: number; lon: number }>(`local?q=${encodeURIComponent(from)}`);
        if (!start) return { content: "I don't know where he is yet: ask him, then set_location, or give from", is_error: true };
        const r = await webGet<Route>(`route?to=${encodeURIComponent(to)}&from=${start.lat},${start.lon}`);
        lastRoute = r;
        return {
          content: JSON.stringify({
            to: r.to.name,
            distance: miles(r.distance_m),
            time: minutes(r.duration_s),
            arrive_at: reminders.localIso(new Date(Date.now() + r.duration_s * 1000)).slice(11, 16),
            first_steps: r.steps.slice(0, 4).map((s) => s.text),
            next: "Ask him: \"Shall I open this in Apple Maps, or show it here?\" Times are without live traffic.",
          }),
        };
      }
      case "show_route": {
        if (!lastRoute) return { content: "no route yet: call directions first", is_error: true };
        const where = args.where === "here" ? "here" : "apple_maps";
        ui.showRoute(lastRoute, where);
        return {
          content:
            where === "here"
              ? `showing the route to ${shortName(lastRoute)} on the Intel globe`
              : "an Open in Apple Maps button is in the transcript: tell him to tap it",
        };
      }
      case "watch_add": {
        const w = await watch.resolve(args);
        if (typeof w === "string") return { content: w, is_error: true };
        const added = await watch.add(w);
        return { content: JSON.stringify({ added: { id: added.id, watching: watch.describe(added) } }) };
      }
      case "watch_list": {
        const list = await watch.list();
        return { content: JSON.stringify({ watches: list.map((w) => ({ id: w.id, watching: watch.describe(w) })) }) };
      }
      case "watch_remove": {
        const id = Number(args.id);
        if (!Number.isInteger(id)) return { content: "id must be a watch id from watch_list", is_error: true };
        await watch.remove(id);
        return { content: `removed watch ${id}` };
      }
      case "intel_feed": {
        const [{ toStory }, feed] = await Promise.all([import("./intel/model"), webGet<IntelFeed>("intel/feed")]);
        const f = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
        const items = feed.items
          .map(toStory)
          .filter((s) => !f || `${s.title} ${s.where?.name ?? ""} ${s.category} ${s.summary}`.toLowerCase().includes(f))
          .slice(0, 30)
          .map((s) => ({
            title: s.title,
            category: s.category,
            place: s.where?.name,
            source: s.source,
            published: s.published,
            summary: s.summary ? s.summary.slice(0, 200) : undefined,
          }));
        return { content: JSON.stringify({ generated_at: feed.generated_at, items, sources_down: feed.sources.filter((x) => !x.ok).map((x) => x.name) }) };
      }
      case "fleet_jobs":
        return { content: JSON.stringify(compactJobs(ui.jobs())) };
      case "open_panel": {
        const tab = String(args.name ?? "");
        if (!tabsFor(ui.full).includes(tab)) return { content: `unknown panel ${tab}`, is_error: true };
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
