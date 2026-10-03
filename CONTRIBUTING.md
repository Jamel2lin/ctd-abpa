# 协作指南

## 本地启动

1. 安装 Node.js 24。仓库的 `.nvmrc` 和 `packageManager` 分别固定主版本与 pnpm 版本。
2. 在仓库根目录运行 `corepack enable`、`pnpm install --frozen-lockfile`、`cp .env.example .env` 和 `pnpm dev`。
3. 打开 `http://127.0.0.1:3211`。需要模型建议时，自行在本机 `.env` 填写获授权的密钥；普通开发和自动测试不需要共享密钥。

## 分支与审查

- 从最新 `main` 创建个人功能分支；每次 PR 聚焦一个问题，说明改动、验证方式和已知限制。
- 提交 PR 前运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`。涉及网页或 API 流程时，安装 Playwright Chromium 并运行 `pnpm test:e2e`。
- 请一名组员审查后合并。业务规则、数据格式和模板变化应附可复现的脱敏样例与相应测试。
- `docs/验收/` 中的报告是特定日期的证据。新测试结果应注明环境、版本、样本来源和限制，不覆盖历史结论。

## 数据边界

- `.env`、`data/`、`outputs/`、`.tasks/`、`.config/` 和测试报告均保持本地，不要强制加入 Git，也不要粘贴到 Issue 或 PR。
- 测试样例使用合成数据。获得授权的真实数据仅用于本机专项验收；缺少该数据时，默认测试会跳过真实数据黄金验收。
- 持有完整授权数据的成员运行 `pnpm test:real-data`；此命令会在文件缺失时失败。
- 当前 API 为本地单机服务，没有多人访问鉴权。组员各自在本机运行；共同开发通过 Git 和 PR 进行。

## GitHub 协作设置

- 仓库保持私密，只邀请参与开发的组员。若当前 GitHub 方案支持，限制直接修改 `main`，要求 PR 审查及 CI 通过后合并。
- 每次提交前检查 `git status --short`、`git ls-files` 和 diff，确认只有可共享内容；特别检查新建的报告、样本与配置。
- 组员克隆仓库后按“本地启动”操作。真实业务数据和模型密钥通过团队批准的独立渠道提供。
