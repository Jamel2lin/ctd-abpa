import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3211", headless: true, launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
  webServer: [
    { command: "node_modules/.bin/tsx apps/api/src/server.ts", env: { EXECUTION_QUEUE_DELAY_MS: "300" }, url: "http://127.0.0.1:3210/health", reuseExistingServer: false, timeout: 30_000 },
    { command: "node_modules/.bin/vite apps/web --config apps/web/vite.config.ts", url: "http://127.0.0.1:3211", reuseExistingServer: false, timeout: 30_000 },
  ],
});
