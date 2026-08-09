import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_"],
  build: {
    target: "es2020",
    minify: process.env.NODE_ENV === "development" ? false : "esbuild",
    sourcemap: process.env.NODE_ENV === "development",
  },
});
