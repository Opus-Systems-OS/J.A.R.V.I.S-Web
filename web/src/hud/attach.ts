// Files attached to the next message. Each uploads the moment it is added
// (paperclip, drop, or paste) through `/bff/v1/files`, which hands it to the
// API → control plane → Anthropic's Files API; the page keeps only the
// returned id. The next request, typed or spoken, carries the ids: Jarvis
// finds each file in his sandbox under /mnt/session/uploads/, and sees
// images and PDFs directly.

import { ApiError, LOCKED_EVENT } from "../api";

/** The API's per-file limit and per-message count. */
export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 10;

interface Uploaded {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

interface Item {
  key: number;
  name: string;
  size: number;
  chip: HTMLElement;
  bar: HTMLElement;
  xhr: XMLHttpRequest | null;
  done: Promise<string | null>;
}

export function humanSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${n} B`;
}

/** Why this file can't be attached, or null. */
export function refusal(file: { name: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= MAX_FILES) return `at most ${MAX_FILES} files per message`;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > MAX_BYTES) return `${file.name} is over ${MAX_BYTES / 1024 / 1024} MB`;
  return null;
}

/** POST one file as multipart, reporting progress; resolves to its id. */
function upload(file: File, onProgress: (f: number) => void): { xhr: XMLHttpRequest; done: Promise<Uploaded> } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Uploaded>((resolve, reject) => {
    xhr.open("POST", "/bff/v1/files");
    xhr.setRequestHeader("x-jarvis", "1");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 201 && xhr.response?.file_id) return resolve(xhr.response as Uploaded);
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
      const env = xhr.response?.error ?? { type: "internal", message: `HTTP ${xhr.status}` };
      reject(new ApiError(xhr.status, env, null));
    };
    xhr.onerror = () => reject(new Error("cannot reach the tower"));
    xhr.onabort = () => reject(new Error("removed"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
  return { xhr, done };
}

export class Attachments {
  private items: Item[] = [];
  private next = 1;

  constructor(
    private readonly tray: HTMLElement,
    private readonly note: (text: string) => void,
  ) {
    this.render();
  }

  get count(): number {
    return this.items.length;
  }

  add(files: Iterable<File>) {
    for (const file of files) {
      const why = refusal(file, this.items.length);
      if (why) {
        this.note(`can't attach: ${why}`);
        continue;
      }
      const key = this.next++;
      const chip = document.createElement("span");
      chip.className = "file-chip uploading";
      chip.title = `${file.name} · ${humanSize(file.size)}`;
      const label = document.createElement("span");
      label.className = "file-chip-name";
      label.textContent = file.name;
      const bar = document.createElement("span");
      bar.className = "file-chip-bar";
      const x = document.createElement("button");
      x.type = "button";
      x.className = "file-chip-x";
      x.setAttribute("aria-label", `Remove ${file.name}`);
      x.textContent = "×";
      x.onclick = () => this.remove(key);
      chip.append(label, bar, x);

      const { xhr, done } = upload(file, (f) => (bar.style.width = `${Math.round(f * 100)}%`));
      const item: Item = {
        key,
        name: file.name,
        size: file.size,
        chip,
        bar,
        xhr,
        done: done.then(
          (u) => {
            chip.classList.remove("uploading");
            item.xhr = null;
            return u.file_id;
          },
          (e: unknown) => {
            item.xhr = null;
            if (!this.items.includes(item)) return null; // removed
            chip.classList.remove("uploading");
            chip.classList.add("failed");
            const msg = e instanceof Error ? e.message : String(e);
            chip.title = `${file.name}: ${msg}`;
            this.note(`upload failed: ${file.name}: ${msg}`);
            return null;
          },
        ),
      };
      this.items.push(item);
    }
    this.render();
  }

  /**
   * The ids for the message being sent, waiting for any upload still in
   * flight; failed ones are left out. Empties the tray.
   */
  async take(): Promise<string[]> {
    const items = this.items;
    this.items = [];
    this.render();
    const ids = await Promise.all(items.map((i) => i.done));
    return ids.filter((id): id is string => !!id);
  }

  private remove(key: number) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    this.items = this.items.filter((i) => i !== item);
    item.xhr?.abort();
    this.render();
  }

  private render() {
    this.tray.replaceChildren(...this.items.map((i) => i.chip));
    this.tray.hidden = this.items.length === 0;
  }
}

/** One file named in a message's "Attached files" line. */
export interface AttachedLine {
  path: string;
  name: string;
  mime: string;
  size: string;
}

const ATTACHED_HEADER = "Attached files (read-only copies in your sandbox):";

/**
 * Split a user message's text into what was said and the files the control
 * plane listed after it (`- /mnt/session/uploads/a.png (image/png, 12 KB;
 * file_id file_…)`).
 */
export function splitAttached(text: string): { said: string; files: AttachedLine[] } {
  const at = text.indexOf(ATTACHED_HEADER);
  if (at < 0) return { said: text, files: [] };
  const files: AttachedLine[] = [];
  for (const line of text.slice(at + ATTACHED_HEADER.length).split("\n")) {
    const m = /^- (\S+) \(([^,]+), ([^;]+); file_id \S+\)$/.exec(line.trim());
    if (m) files.push({ path: m[1], name: m[1].split("/").pop() ?? m[1], mime: m[2], size: m[3] });
  }
  return { said: text.slice(0, at).trim(), files };
}
