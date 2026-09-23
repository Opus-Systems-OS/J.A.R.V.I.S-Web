import "@fontsource/rajdhani/latin-400.css";
import "@fontsource/rajdhani/latin-500.css";
import "@fontsource/rajdhani/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./styles/base.css";
import "./styles/lock.css";
import "./styles/hud.css";
import "./styles/voice.css";

import { LOCKED_EVENT } from "./api";
import { showLock } from "./lock";
import { mountHud, type Hud } from "./hud/shell";
import { Speaker } from "./hud/speaker";

// A fresh load always starts locked. The server's cookie outlives a reload,
// but the page never uses it without a new unlock first.
const hudRoot = document.getElementById("hud") as HTMLDivElement;
const speaker = new Speaker();
let hud: Hud | null = null;

function toLock() {
  hud?.unmount();
  hud = null;
  hudRoot.hidden = true;
  hudRoot.innerHTML = "";
  showLock(toHud, () => speaker.prime());
}

function toHud() {
  hud = mountHud(hudRoot, speaker, toLock);
}

window.addEventListener(LOCKED_EVENT, () => {
  if (!hudRoot.hidden) toLock();
});

toLock();
