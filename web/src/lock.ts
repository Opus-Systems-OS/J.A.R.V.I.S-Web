// The lock screen. A fresh load always lands here, and every unlock posts
// the passphrase — by design, so the click that unlocks is also the user
// gesture the browser needs before it will let Jarvis speak or listen.

import { ApiError, unlock } from "./api";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

export function showLock(onUnlocked: () => void): void {
  const root = el<HTMLElement>("lock");
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
  input.focus();

  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };

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
    submit.disabled = true;
    root.classList.remove("denied");
    say("Verifying…");
    try {
      await unlock(input.value);
      input.value = "";
      say("Access granted");
      root.classList.add("granted");
      window.setTimeout(() => root.classList.add("leaving"), 450);
      window.setTimeout(() => {
        root.hidden = true;
        onUnlocked();
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
