import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const dataDir = resolve(process.env.CTD_TEST_DATA_DIR ?? "data/自动化桥接与处理智能体数据集file");
const requiredFiles = ["ERP导出加班.XLSX", "OA导出请假单.xlsx", "HR 系统需要最低版本导入.xls", "年假.xls"];
const missing = requiredFiles.filter((file) => !existsSync(resolve(dataDir, file)));

if (missing.length > 0) {
  console.error(`缺少已授权的本地验收文件：${missing.join("、")}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "tests/real-data.test.ts"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
