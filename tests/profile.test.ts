import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { analyzeWorkbook, profileArtifactsForModel } from "@ctd-abpa/excel";

it("本地画像统计字段且不向模型暴露人员明细", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctd-profile-")), path = join(directory, "people.csv");
  try {
    await writeFile(path, "工号,姓名,金额,状态\n001,张三,1.2,已审批\n002,李四,2.3,待审批\n");
    const artifact = await analyzeWorkbook(path);
    const result = await profileArtifactsForModel([artifact], "只保留张三和工号001");
    expect(result.privateTerms).toContain("张三");
    expect(result.privateTerms).toContain("001");
    expect(result.sheets[0].columns.find((column) => column.header === "金额")?.numericRange).toEqual([1.2, 2.3]);
    expect(result.sheets[0].columns.find((column) => column.header === "工号")?.numericRange).toBeUndefined();
    expect(JSON.stringify(result.sheets)).not.toMatch(/张三|李四|001|002/);
  } finally { await rm(directory, { recursive: true }); }
});
