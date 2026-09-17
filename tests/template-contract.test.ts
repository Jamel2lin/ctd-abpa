import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TargetTemplateVersionSchema } from "@ctd-abpa/types";

describe("目标模板契约", () => {
  for (const file of ["hr-overtime.v1.json", "hr-leave.v1.json"]) {
    it(`校验 ${file}`, async () => {
      const template = TargetTemplateVersionSchema.parse(JSON.parse(await readFile(resolve("templates", file), "utf8")));
      const sheet = template.sheets[0];
      expect(new Set(sheet.columns.map((column) => column.columnId)).size).toBe(sheet.columns.length);
      expect(sheet.maxDataRows).toBe(65_535);
    });
  }
});
