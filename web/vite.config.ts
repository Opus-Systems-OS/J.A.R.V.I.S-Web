import { defineConfig } from "vite";

// `npm run dev` serves the page on :5173 and forwards the server's routes to
// a local `jarvis-web serve` on :8200 (see README "Local development").
export default defineConfig({
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:8200",
      "/bff": { target: "http://127.0.0.1:8200", ws: false },
      "/healthz": "http://127.0.0.1:8200",
    },
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0, // no data: URLs; everything is a same-origin file (CSP)
  },
});
