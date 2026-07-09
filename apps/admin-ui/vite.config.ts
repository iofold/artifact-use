import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built assets are served by the worker via Workers Static Assets from
// apps/worker/public. The app itself is mounted at /admin* while its assets
// live under /admin-app/ so they never collide with worker routes.
export default defineConfig({
  plugins: [react()],
  base: "/admin-app/",
  build: {
    outDir: "../worker/public/admin-app",
    emptyOutDir: true,
  },
  server: {
    // Local dev against `wrangler dev --port 8799`.
    proxy: {
      "/api": "http://127.0.0.1:8799",
      "/admin/": "http://127.0.0.1:8799",
      "/login": "http://127.0.0.1:8799",
      "/logout": "http://127.0.0.1:8799",
    },
  },
});
