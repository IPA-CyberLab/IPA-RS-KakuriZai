import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/studio",
  plugins: [react()],
  build: {
    outDir: "../../dist/src/studio",
    emptyOutDir: true
  }
});
