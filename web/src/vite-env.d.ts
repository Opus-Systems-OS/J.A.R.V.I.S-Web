/// <reference types="vite/client" />

// The light build (no subtitles, alt audio or DRM) has the full build's API.
declare module "hls.js/light" {
  export { default } from "hls.js";
}
