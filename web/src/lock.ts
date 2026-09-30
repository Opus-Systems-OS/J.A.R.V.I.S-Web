// The lock screen. A fresh load always lands here, and every unlock posts
// the passphrase — by design, so the click that unlocks is also the user
// gesture the browser needs before it will let Jarvis speak or listen.
// With more than one profile it asks who you are first (a button each),
// then that profile's passphrase.

import { ApiError, profiles, unlock, webGet, type Profile, type ProfileChoice } from "./api";

const OWNER: ProfileChoice = { id: "walker", name: "Mr. Walker" };

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

/**
 * `onGesture` runs synchronously inside the submit — the one moment the
 * browser counts as the user's own action — so audio can be unlocked
 * before any network wait lets that moment lapse.
 */
export function showLock(onUnlocked: (me: Profile) => void, onGesture?: () => void): void {
  const root = el<HTMLElement>("lock");
  const picker = el<HTMLElement>("lock-profiles");
  const list = el<HTMLDivElement>("lock-profile-list");
  const whoRow = el<HTMLDivElement>("lock-who-row");
  const who = el<HTMLSpanElement>("lock-who");
  const back = el<HTMLButtonElement>("lock-back");
  const form = el<HTMLFormElement>("lock-form");
  const input = el<HTMLInputElement>("lock-password");
  const submit = el<HTMLButtonElement>("lock-submit");
  const status = el<HTMLParagraphElement>("lock-status");
  let lockedUntil = 0;
  let countdown: number | undefined;

  root.hidden = false;
  root.classList.remove("leaving", "granted", "denied");
  input.value = "";
  status.textContent = "";
  status.classList.remove("error");
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };

  let chosen: ProfileChoice = OWNER;
  let choices: ProfileChoice[] = [];

  /** The passphrase step, for `p`. */
  const choose = (p: ProfileChoice) => {
    chosen = p;
    picker.hidden = true;
    form.hidden = false;
    whoRow.hidden = choices.length < 2;
    who.textContent = p.name;
    input.value = "";
    input.focus();
  };
  /** The "who is it?" step. */
  const pick = () => {
    form.hidden = true;
    picker.hidden = false;
    root.classList.remove("denied");
    say("");
    list.querySelector<HTMLButtonElement>("button")?.focus();
  };
  back.onclick = pick;
  form.hidden = true;
  picker.hidden = true;
  profiles()
    .then((ps) => {
      choices = ps;
      if (ps.length < 2) {
        choose(ps[0] ?? OWNER);
        return;
      }
      list.replaceChildren(
        ...ps.map((p) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "profile-btn";
          b.textContent = p.name;
          b.onclick = () => choose(p);
          return b;
        }),
      );
      pick();
    })
    .catch(() => choose(OWNER));

  const holdOff = (seconds: number) => {
    lockedUntil = Date.now() + seconds * 1000;
    window.clearInterval(countdown);
    const tick = () => {
      const left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left <= 0) {
        window.clearInterval(countdown);
        submit.disabled = false;
        say("");
        input.focus();
        return;
      }
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, "0");
      say(`Lockout — retry in ${m}:${s}`, true);
    };
    submit.disabled = true;
    tick();
    countdown = window.setInterval(tick, 1000);
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (Date.now() < lockedUntil || !input.value) return;
    onGesture?.();
    submit.disabled = true;
    root.classList.remove("denied");
    say("Verifying…");
    try {
      await unlock(chosen.id, input.value);
      input.value = "";
      const me = await webGet<Profile>("me");
      say(`Welcome back, ${me.name}`);
      root.classList.add("granted");
      window.setTimeout(() => root.classList.add("leaving"), 450);
      window.setTimeout(() => {
        root.hidden = true;
        onUnlocked(me);
      }, 1000);
    } catch (e) {
      input.select();
      // Restart the shake animation even on repeated failures.
      void root.offsetWidth;
      root.classList.add("denied");
      if (e instanceof ApiError && e.status === 429) {
        holdOff(e.retryAfter ?? 60);
        return;
      }
      if (e instanceof ApiError && e.status === 401) {
        say("Access denied", true);
      } else {
        say("Cannot reach the tower — try again", true);
      }
      submit.disabled = false;
    }
  };
}
