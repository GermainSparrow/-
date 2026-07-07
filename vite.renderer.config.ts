import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true
  },
  server: {
    strictPort: true
  }
});
