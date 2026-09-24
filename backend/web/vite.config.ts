import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The dashboard is served from /app, alongside the static marketing page that
// still owns "/". base must match or every built asset URL 404s in production.
export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    // Built straight into the hosting root the marketing page already uses, so
    // one `firebase deploy` ships both. Generated - never edit public/app.
    outDir: "../public/app",
    emptyOutDir: true,
    sourcemap: false,
  },
})
