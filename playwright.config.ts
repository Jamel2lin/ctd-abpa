import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const testRoot = process.env.CTD_E2E_ROOT ?? mkdtempSync(join(tmpdir(), "ctd-e2e-"));
process.env.CTD_E2E_ROOT = testRoot;

export default defineConfig({
  testDir: "tests/e2e",
  globalTeardown: "tests/e2e/cleanup.ts",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3211", headless: true, browserName: "chromium" },
  webServer: [
    { command: "node_modules/.bin/tsx apps/api/src/server.ts", env: { EXECUTION_QUEUE_DELAY_MS: "300", HOST: "127.0.0.1", PORT: "3210", API_USERS: "", TASK_STORAGE_DIR: join(testRoot, "tasks"), CONFIG_STORAGE_DIR: join(testRoot, "config") }, url: "http://127.0.0.1:3210/health", reuseExistingServer: false, timeout: 30_000 },
    { command: "node_modules/.bin/vite apps/web --config apps/web/vite.config.ts", url: "http://127.0.0.1:3211", reuseExistingServer: false, timeout: 30_000 },
  ],
});
