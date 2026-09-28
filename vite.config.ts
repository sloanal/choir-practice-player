import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base + hash-based routing keeps the app working on GitHub Pages
// project sites (https://user.github.io/repo/) without extra config.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
  },
});
