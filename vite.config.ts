import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/share": backend,
      "/manifest.webmanifest": backend,
      "/sw.js": backend,
    },
  },
});
