import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev port and leaves the console alone so Rust logs are
// visible. See https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: {
      // Don't let Vite watch the Rust side.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep the heavy, lazily-loaded math/diagram libraries out of the main
        // bundle — they load on demand only when a note actually uses them.
        manualChunks(id) {
          if (id.includes("/katex/")) return "katex";
          if (id.includes("/mermaid/")) return "mermaid";
        },
      },
    },
  },
});
