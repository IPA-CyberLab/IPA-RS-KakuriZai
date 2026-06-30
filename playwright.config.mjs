import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "scripts/responsive.spec.mjs",
  webServer: process.env.STUDIO_URL
    ? undefined
    : {
        command: "npm exec vite -- --host 127.0.0.1 --port 5173 --strictPort",
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        url: "http://127.0.0.1:5173"
      }
});
