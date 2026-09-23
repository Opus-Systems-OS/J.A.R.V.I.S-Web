import "@fontsource/rajdhani/latin-400.css";
import "@fontsource/rajdhani/latin-500.css";
import "@fontsource/rajdhani/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./styles/base.css";
import "./styles/lock.css";
import "./styles/hud.css";

import { LOCKED_EVENT } from "./api";
import { showLock } from "./lock";
import { mountHud } from "./hud/shell";

// A fresh load always starts locked. The server's cookie outlives a reload,
// but the page never uses it without a new unlock first.
const hudRoot = document.getElementById("hud") as HTMLDivElement;
let unmount: (() => void) | null = null;

function toLock() {
  unmount?.();
  unmount = null;
  hudRoot.hidden = true;
  hudRoot.innerHTML = "";
  showLock(toHud);
}

function toHud() {
  unmount = mountHud(hudRoot, toLock);
}

window.addEventListener(LOCKED_EVENT, () => {
  if (!hudRoot.hidden) toLock();
});

toLock();
