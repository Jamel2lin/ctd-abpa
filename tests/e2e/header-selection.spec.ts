import { expect, test } from "@playwright/test";
test("网页选择20行后的表头，预览纠错后重新绑定", async ({ page }) => {
  await page.goto("/"); await expect(page.locator(".status span")).not.toContainText("创建中");
  await page.locator('input[type="file"]').setInputFiles({ name: "deep.csv", mimeType: "text/csv", buffer: Buffer.from(`${"报表说明,版本,签署\n".repeat(30)}SKU,数量\nA,2\n`) });
  await page.getByRole("button", { name: "上传并分析" }).click(); await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一步" }).click();
  await page.getByText("工作表与表头纠错", { exact: true }).click(); await page.getByRole("button", { name: "查看前100行" }).click();
  await expect(page.locator(".table")).toContainText("31"); await page.getByLabel("表头行（多行用英文逗号分隔）").fill("31"); await page.getByRole("button", { name: "应用表头选择" }).click();
  await expect(page.getByText("表头已更新，原确认失效；请重新生成或绑定计划", { exact: true })).toBeVisible();
  await expect(page.locator(".file").first()).toContainText("1 行");
});
