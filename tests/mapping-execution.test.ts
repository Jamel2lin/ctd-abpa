import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { processOvertime } from "@ctd-abpa/excel";

it("已确认别名进入 HR 执行字段匹配", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctd-alias-")), path = join(directory, "overtime.csv");
  try {
    await writeFile(path, "员工代号,姓名,部门,职位,起始日期,申请加班\n001,张三,研发,工程师,2026-09-13,1\n");
    await expect(processOvertime(path)).rejects.toThrow(/缺少必要字段/);
    const result = await processOvertime(path, [], [], { employeeId: ["员工代号"] });
    expect(result.rows[0].employeeId).toBe("001");
  } finally { await rm(directory, { recursive: true }); }
});
