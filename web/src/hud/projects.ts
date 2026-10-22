// The Projects tab: this profile's Jarvis projects (ones that live here) and
// GitHub repos (their own account's and Opus-Systems-OS's, through their own
// token, `projects.rs`). Selecting one shows what it is and its 3D models; a
// model opens in the spinning viewer (`model3d.ts`). New project asks the
// question Jarvis asks too: a GitHub repository, or a project on here?
//
// Text from GitHub and the API goes in with textContent; the skeleton is the
// only markup, and it goes through `html`.

import { ApiError, get, web, webGet } from "../api";
import { html, setHtml } from "../html";
import { link } from "./brief";
import { ago } from "./fleet";
import { kindOf, renderFile, type FileKind } from "./fileview";
import type { OutputFile } from "./transcript";

export interface Repo {
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
  html_url: string;
  default_branch: string;
}

export interface LocalProject {
  id: number;
  name: string;
  description: string;
  session_id: string | null;
  created_at: number;
}

export interface Listing {
  github: { login: string; repos: Repo[] } | null;
  github_error?: string;
  local: LocalProject[];
}

export const ORG = "Opus-Systems-OS";

/** What a key names: `local:3`, `gh:Opus-Systems-OS/J.A.R.V.I.S-Web`. */
type Key = string;
const localKey = (p: LocalProject): Key => `local:${p.id}`;
const repoKey = (r: Repo): Key => `gh:${r.owner}/${r.name}`;

/** The project whose name is `name` (case and spacing aside), Jarvis projects first. */
export function findProject(l: Listing, name: string): Key | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const want = norm(name);
  const local = l.local.find((p) => norm(p.name) === want);
  if (local) return localKey(local);
  const repo = l.github?.repos.find((r) => norm(r.name) === want || norm(`${r.owner}/${r.name}`) === want);
  return repo ? repoKey(repo) : null;
}

export const listProjects = () => webGet<Listing>("projects");

export interface ProjectsHost {
  /** The Jarvis conversation now: a new Jarvis project belongs to it. */
  sessionId(): string | null;
  /** Back into a Jarvis project's conversation (the HUD tab). */
  continueProject(p: LocalProject): Promise<void>;
}

/** A file a project shows: where to read it and where to download it. */
interface ProjectFile {
  path: string;
  size: number;
  url: string;
  load(): Promise<ArrayBuffer>;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The subfolders and files directly in `dir` ("" = the root). */
export function folderView<T extends { path: string }>(files: T[], dir: string): { folders: string[]; here: T[] } {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Set<string>();
  const here: T[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) here.push(f);
    else folders.add(rest.slice(0, slash));
  }
  return { folders: [...folders].sort((a, b) => a.localeCompare(b)), here: here.sort((a, b) => a.path.localeCompare(b.path)) };
}

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ProjectsView {
  private listing: Listing | null = null;
  private selected: Key | null = null;
  private filter = "";
  private closeViewer: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private readonly $: <T extends HTMLElement>(sel: string) => T;

  constructor(
    root: HTMLElement,
    private readonly host: ProjectsHost,
  ) {
    setHtml(root, html`
      <div class="projects">
        <section class="panel projects-list">
          <header class="panel-head">
            <span class="panel-title">Projects</span>
            <button class="btn-ghost btn-small" id="proj-new" type="button">New project</button>
          </header>
          <input class="projects-filter" id="proj-filter" autocomplete="off" spellcheck="false" placeholder="Filter" aria-label="Filter projects" />
          <div class="projects-groups" id="proj-groups"><p class="panel-empty">Reading your projects…</p></div>
        </section>
        <section class="panel projects-detail">
          <header class="panel-head"><span class="panel-title" id="proj-title">Select a project</span><span class="panel-tag" id="proj-tag"></span></header>
          <div class="panel-body" id="proj-body"></div>
        </section>
      </div>`);
    this.$ = <T extends HTMLElement>(sel: string) => {
      const found = root.querySelector(sel);
      if (!found) throw new Error(`missing ${sel}`);
      return found as T;
    };
    this.$<HTMLInputElement>("#proj-filter").oninput = (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderList();
    };
    this.$<HTMLButtonElement>("#proj-new").onclick = () => this.renderNew();
  }

  show() {
    this.loading = this.load();
  }

  hide() {
    this.stopViewer();
  }

  dispose() {
    this.stopViewer();
  }

  /** For `project_open`: select it by name; false when there's none. */
  async open(name: string): Promise<boolean> {
    await (this.loading ?? (this.loading = this.load()));
    const key = this.listing && findProject(this.listing, name);
    if (!key) return false;
    this.select(key);
    return true;
  }

  async reload() {
    this.loading = this.load();
    await this.loading;
  }

  private async load() {
    try {
      this.listing = await listProjects();
    } catch (e) {
      const groups = this.$("#proj-groups");
      groups.replaceChildren(el("p", "panel-empty", `Projects unavailable: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    this.renderList();
    if (this.selected) this.select(this.selected);
  }

  private renderList() {
    const l = this.listing;
    if (!l) return;
    const groups = this.$("#proj-groups");
    const match = (...words: (string | null)[]) => !this.filter || words.some((w) => w?.toLowerCase().includes(this.filter));
    const section = (title: string, rows: HTMLElement[], empty: string) => {
      const s = el("div", "projects-group");
      s.append(el("p", "sec-label", title));
      const ul = el("ul", "rows");
      if (rows.length) ul.append(...rows);
      else ul.append(el("li", "panel-empty", empty));
      s.append(ul);
      return s;
    };
    const row = (key: Key, name: string, detail: string) => {
      const li = el<HTMLLIElement>("li", "row");
      li.tabIndex = 0;
      li.dataset.state = "ok";
      li.setAttribute("aria-selected", String(key === this.selected));
      li.append(el("span", "row-name", name), el("span", "row-detail", detail));
      li.onclick = () => this.select(key);
      li.onkeydown = (e) => {
        if (e.key === "Enter") this.select(key);
      };
      return li;
    };
    const local = l.local
      .filter((p) => match(p.name, p.description))
      .map((p) => row(localKey(p), p.name, p.description || "Jarvis project"));
    const out = [section("Jarvis projects", local, "None yet · New project, or ask Jarvis")];
    if (l.github) {
      const repos = l.github.repos.filter((r) => match(r.name, r.description, r.language));
      const repoRow = (r: Repo) =>
        row(repoKey(r), r.name, [r.private ? "private" : "public", r.language, r.pushed_at ? `pushed ${ago(r.pushed_at)}` : null].filter(Boolean).join(" · "));
      const mine = repos.filter((r) => r.owner.toLowerCase() === l.github!.login.toLowerCase());
      const org = repos.filter((r) => r.owner.toLowerCase() === ORG.toLowerCase());
      out.push(section(`Your repos · ${l.github.login}`, mine.map(repoRow), "None"));
      out.push(section(ORG, org.map(repoRow), "None you can see"));
    } else {
      const s = el("div", "projects-group");
      s.append(el("p", "sec-label", "GitHub"), el("p", "panel-empty", l.github_error ?? "GitHub unavailable"));
      out.push(s);
    }
    groups.replaceChildren(...out);
  }

  private stopViewer() {
    this.closeViewer?.();
    this.closeViewer = null;
  }

  private detail(title: string, tag: string): HTMLElement {
    this.stopViewer();
    this.$("#proj-title").textContent = title;
    this.$("#proj-tag").textContent = tag;
    const body = this.$("#proj-body");
    body.replaceChildren();
    return body;
  }

  private select(key: Key) {
    this.selected = key;
    this.renderList();
    const l = this.listing;
    if (!l) return;
    if (key.startsWith("local:")) {
      const p = l.local.find((x) => localKey(x) === key);
      if (p) this.renderLocal(p);
    } else {
      const r = l.github?.repos.find((x) => repoKey(x) === key);
      if (r) this.renderRepo(r);
    }
  }

  private facts(body: HTMLElement, rows: [string, string][]) {
    const dl = el("dl", "node-facts");
    for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
    body.append(dl);
  }

  /** Files as groups (models, docs, code, other) and a viewer below; the
   * first model, else the first doc, opens by itself. */
  private filesBlock(body: HTMLElement, files: ProjectFile[], heading: string) {
    body.append(el("p", "sec-label", `${heading} · ${files.length}`));
    if (!files.length) {
      body.append(el("p", "panel-empty", "No files yet"));
      return;
    }
    const viewer = el("div", "projects-viewer");
    const groups = el("div", "projects-files");
    const buttons: HTMLButtonElement[] = [];
    const open = async (f: ProjectFile, b: HTMLButtonElement) => {
      buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      this.stopViewer();
      try {
        const close = await renderFile(viewer, f.path, f.size, f.load, f.url);
        if (close) {
          if (viewer.isConnected) this.closeViewer = close;
          else close();
        }
      } catch (e) {
        viewer.replaceChildren(el("p", "panel-empty", `Couldn't open ${f.path}: ${e instanceof Error ? e.message : String(e)}`));
      }
    };
    const label: Record<FileKind, string> = { model: "3D models", doc: "Docs", code: "Code", other: "Other" };
    for (const kind of ["model", "doc", "code", "other"] as FileKind[]) {
      const these = files.filter((f) => kindOf(f.path) === kind);
      if (!these.length) continue;
      groups.append(el("p", "projects-kind", `${label[kind]} · ${these.length}`));
      const ul = el("ul", "projects-models");
      for (const f of these) {
        const li = el("li");
        const b = el<HTMLButtonElement>("button", "btn-ghost btn-small", f.path);
        b.type = "button";
        b.onclick = () => void open(f, b);
        buttons.push(b);
        li.append(b);
        ul.append(li);
      }
      groups.append(ul);
    }
    body.append(groups, viewer);
    const first = files.find((f) => kindOf(f.path) === "model") ?? files.find((f) => kindOf(f.path) === "doc");
    if (first) void open(first, buttons[files.indexOf(first)] ?? buttons[0]);
  }

  private async renderRepo(r: Repo) {
    const key = repoKey(r);
    const body = this.detail(r.name, r.private ? "private" : "public");
    this.facts(body, [
      ["Owner", r.owner],
      ["Language", r.language ?? "—"],
      ["Last push", r.pushed_at ? ago(r.pushed_at) : "—"],
      ["Branch", r.default_branch],
      ...(r.description ? [["About", r.description] as [string, string]] : []),
    ]);
    const p = el("p", "intel-listen");
    p.append(link(r.html_url, "Open on GitHub"));
    body.append(p);
    const base = `/web/projects/github/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
    let tree: { files: { path: string; size: number }[]; truncated: boolean };
    try {
      tree = await webGet(`${base.slice(5)}/tree`);
    } catch (e) {
      if (this.selected === key) body.append(el("p", "panel-empty", `Files unavailable: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    if (this.selected !== key) return;
    const file = (path: string, size: number): ProjectFile => {
      const url = `${base}/file?path=${encodeURIComponent(path)}`;
      return { path, size, url, load: () => fetchBytes(url) };
    };
    const readme = tree.files.find((f) => /^readme\.(md|markdown)$/i.test(f.path));
    if (readme) {
      const box = el("div", "projects-readme");
      body.append(el("p", "sec-label", "README"), box);
      void renderFile(box, readme.path, readme.size, file(readme.path, readme.size).load, file(readme.path, readme.size).url).catch(() =>
        box.replaceChildren(el("p", "panel-empty", "README unavailable")),
      );
    }
    const models = tree.files.filter((f) => kindOf(f.path) === "model").slice(0, 50);
    if (models.length) this.filesBlock(body, models.map((f) => file(f.path, f.size)), "3D models");
    this.browser(body, tree, file);
  }

  /** A repo's files, folder by folder, with a path filter. */
  private browser(body: HTMLElement, tree: { files: { path: string; size: number }[]; truncated: boolean }, file: (path: string, size: number) => ProjectFile) {
    body.append(el("p", "sec-label", `Files · ${tree.files.length}${tree.truncated ? " (the first 5,000)" : ""}`));
    const crumbs = el("div", "projects-crumbs");
    const filter = el<HTMLInputElement>("input", "projects-filter");
    filter.placeholder = "Find a file by path";
    filter.setAttribute("aria-label", "Find a file by path");
    const list = el("ul", "rows projects-tree");
    const viewer = el("div", "projects-viewer");
    let dir = "";
    const show = (f: { path: string; size: number }) => {
      this.stopViewer();
      const pf = file(f.path, f.size);
      void renderFile(viewer, f.path, f.size, pf.load, pf.url)
        .then((close) => {
          if (close) this.closeViewer = close;
        })
        .catch((e) => viewer.replaceChildren(el("p", "panel-empty", `Couldn't open ${f.path}: ${e instanceof Error ? e.message : String(e)}`)));
    };
    const row = (name: string, detail: string, go: () => void) => {
      const li = el<HTMLLIElement>("li", "row");
      li.tabIndex = 0;
      li.append(el("span", "row-name", name), el("span", "row-detail", detail));
      li.onclick = go;
      li.onkeydown = (e) => {
        if (e.key === "Enter") go();
      };
      return li;
    };
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      crumbs.replaceChildren();
      if (q) {
        const hits = tree.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200);
        list.replaceChildren(...(hits.length ? hits.map((f) => row(f.path, kb(f.size), () => show(f))) : [el("li", "panel-empty", "No match")]));
        return;
      }
      const parts = dir ? dir.split("/") : [];
      const crumb = (text: string, to: string) => {
        const b = el<HTMLButtonElement>("button", "btn-ghost btn-small", text);
        b.type = "button";
        b.onclick = () => {
          dir = to;
          render();
        };
        return b;
      };
      crumbs.append(crumb("/", ""));
      parts.forEach((p, i) => crumbs.append(crumb(p, parts.slice(0, i + 1).join("/"))));
      const { folders, here } = folderView(tree.files, dir);
      list.replaceChildren(
        ...folders.map((f) =>
          row(`${f}/`, "folder", () => {
            dir = dir ? `${dir}/${f}` : f;
            render();
          }),
        ),
        ...here.map((f) => row(f.path.split("/").pop()!, kb(f.size), () => show(f))),
      );
    };
    filter.oninput = render;
    render();
    body.append(filter, crumbs, list, viewer);
  }

  private async renderLocal(p: LocalProject) {
    const key = localKey(p);
    const body = this.detail(p.name, "Jarvis project");
    const go = el<HTMLButtonElement>("button", "btn-primary btn-small", "Continue in this project");
    go.type = "button";
    go.onclick = () => void this.host.continueProject(p);
    body.append(go);
    this.facts(body, [
      ["About", p.description || "—"],
      ["Started", ago(new Date(p.created_at * 1000).toISOString())],
      ["Conversation", p.session_id ?? "not started: Continue starts one"],
    ]);
    const remove = el<HTMLButtonElement>("button", "btn-ghost btn-small", "Remove project");
    remove.type = "button";
    remove.onclick = async () => {
      if (!window.confirm(`Remove ${p.name}? Its files stay in the conversation.`)) return;
      await web(`projects/local/${p.id}/remove`, {}).catch(() => undefined);
      this.selected = null;
      this.detail("Select a project", "");
      await this.reload();
    };
    if (!p.session_id) {
      body.append(remove);
      return;
    }
    let files: OutputFile[] = [];
    try {
      files = (await get<{ data?: OutputFile[] }>(`sessions/${encodeURIComponent(p.session_id)}/files`)).data ?? [];
    } catch {
      /* the conversation may be gone */
    }
    if (this.selected !== key) return;
    const session = p.session_id;
    this.filesBlock(
      body,
      files
        .filter((f) => f.downloadable)
        .map((f) => {
          const url = `/bff/v1/files/${encodeURIComponent(f.id)}/content?session=${encodeURIComponent(session)}`;
          return { path: f.filename, size: f.size_bytes ?? 0, url, load: () => fetchBytes(url) };
        }),
      "Files",
    );
    body.append(remove);
  }

  private renderNew() {
    this.selected = null;
    this.renderList();
    const body = this.detail("New project", "");
    const form = el<HTMLFormElement>("form", "projects-new");
    const name = el<HTMLInputElement>("input", "projects-filter");
    name.placeholder = "Name";
    name.required = true;
    name.maxLength = 100;
    const about = el<HTMLInputElement>("input", "projects-filter");
    about.placeholder = "What it is (optional)";
    about.maxLength = 350;
    form.append(el("p", "sec-label", "Shall this be a GitHub repository or a project on here?"));
    const choice = (value: string, label: string, checked: boolean) => {
      const l = el<HTMLLabelElement>("label", "projects-choice");
      const r = el<HTMLInputElement>("input");
      r.type = "radio";
      r.name = "kind";
      r.value = value;
      r.checked = checked;
      l.append(r, document.createTextNode(` ${label}`));
      return l;
    };
    const check = (label: string, checked: boolean) => {
      const l = el<HTMLLabelElement>("label", "projects-choice");
      const c = el<HTMLInputElement>("input");
      c.type = "checkbox";
      c.checked = checked;
      l.append(c, document.createTextNode(` ${label}`));
      return { l, c };
    };
    const priv = check("Private", true);
    const org = check(`In ${ORG}`, false);
    const github = el("div", "projects-github");
    github.append(priv.l, org.l);
    const hereChoice = choice("here", "A project on here (Jarvis)", true);
    const ghChoice = choice("github", "A GitHub repository", false);
    const status = el("p", "intel-hint");
    const submit = el<HTMLButtonElement>("button", "btn-primary btn-small", "Create");
    submit.type = "submit";
    const kind = () => (form.querySelector<HTMLInputElement>("input[name=kind]:checked")?.value === "github" ? "github" : "here");
    const sync = () => (github.hidden = kind() !== "github");
    form.onchange = sync;
    sync();
    form.append(hereChoice, ghChoice, github, name, about, submit, status);
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.textContent = "Creating…";
      try {
        const made = await createProject({
          kind: kind(),
          name: name.value,
          description: about.value,
          private: priv.c.checked,
          org: org.c.checked,
          session: this.host.sessionId(),
        });
        await this.reload();
        if (this.listing) {
          const key = findProject(this.listing, made);
          if (key) this.select(key);
        }
      } catch (err) {
        status.textContent = err instanceof ApiError || err instanceof Error ? err.message : String(err);
        submit.disabled = false;
      }
    };
    body.append(form);
    name.focus();
  }
}

/** Create either kind; resolves with its name as listed. */
export async function createProject(o: {
  kind: "github" | "here";
  name: string;
  description?: string;
  private?: boolean;
  org?: boolean;
  session?: string | null;
}): Promise<string> {
  const name = o.name.trim();
  const description = o.description?.trim() || undefined;
  if (o.kind === "github") {
    const r = await web<Repo>("projects/github", { name, description, private: o.private ?? true, org: o.org ?? false });
    return r.name;
  }
  const p = await web<LocalProject>("projects/local", { name, description, session_id: o.session ?? undefined });
  return p.name;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}
