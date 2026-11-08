import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: false, target: "es2022" },
});
