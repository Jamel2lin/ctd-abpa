import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: {
    "@ctd-abpa/types": resolve("packages/types/src/index.ts"),
    "@ctd-abpa/core": resolve("packages/core/src/index.ts"),
    "@ctd-abpa/excel": resolve("packages/excel/src/index.ts"),
  } },
  test: { include: ["tests/**/*.test.ts"] },
});
