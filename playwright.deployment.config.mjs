import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "scripts/deployment.spec.mjs",
  timeout: 20 * 60 * 1000,
  expect: { timeout: 2 * 60 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  outputDir: "test-results/deployment",
  use: {
    browserName: "chromium",
    headless: process.env.KAKURIZAI_E2E_HEADED !== "true",
    ignoreHTTPSErrors: false,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  }
});
