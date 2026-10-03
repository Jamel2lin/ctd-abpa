# CTD-ABPA 跨系统表格数据桥接智能体

面向 ERP、OA、HR 等封闭系统的本地表格桥接应用。自然语言只生成受限 `ProcessPlan`；实际解析、校验、筛选、关联、计算和写出全部由确定性 TypeScript 引擎执行。

## 技术栈

- Node.js 24 LTS、pnpm 11、TypeScript Monorepo
- `packages/core`：日期、定点工时、字段匹配、业务规则、计划校验、任务状态
- `packages/excel`：`.xls/.xlsx/.csv` 分析、SheetJS 0.20.3 读写、BIFF8 和审计产物
- `apps/cli`：命令行入口
- `apps/api`：Fastify 本地 HTTP API，默认 `127.0.0.1:3210`
- `apps/web`：React 操作页，默认 `127.0.0.1:3211`

## 克隆后启动

要求 Node.js 24、Corepack 和 Git；已在 macOS 本机及 Ubuntu CI 配置中验证。进入仓库后执行：

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

网页打开 `http://127.0.0.1:3211`，API 健康检查为 `http://127.0.0.1:3210/health`。`.env` 由 API 和 CLI 加载；无模型密钥也可运行内置业务和自动测试。需要模型建议时，在各自本机的 `.env` 中填写获授权的密钥。首次运行会在本机创建 `.tasks/` 与 `.config/`；这些目录不进入 Git。

新成员的分支、PR 和数据处理要求见 [协作指南](CONTRIBUTING.md)。

## 无私有数据的完整演示

以下三个命令使用仓库中的合成样例，不需要模型密钥。它们分别覆盖 ERP 加班、OA 请假和年假余额结算；结果写入 Git 忽略的 `outputs/`。样例余额日期晚于请假日期，因此无需过期余额确认。

```bash
pnpm bridge inspect tests/fixtures/overtime.csv
pnpm bridge run --instruction "把ERP加班转为HR格式" --overtime tests/fixtures/overtime.csv --output outputs/quickstart-overtime
pnpm bridge run --instruction "把OA请假转为HR格式" --leave tests/fixtures/leave.csv --output outputs/quickstart-leave
pnpm bridge run --instruction "按年假余额优先抵扣" --leave tests/fixtures/leave.csv --balance tests/fixtures/balance.csv --output outputs/quickstart-settlement
pnpm bridge profile validate profiles/erp-overtime-to-hr.v1.json
```

启动网页后也可上传上述样例，依次执行“上传并分析 → 生成业务计划 → 完整预演 → 确认当前计划 → 执行并生成文件”。通用 V2/V3 的规则发布及执行示例由 `tests/e2e/generic-v2.spec.ts` 覆盖。CLI 其他参数运行 `pnpm bridge --help` 查看。

网页工作台支持业务流程与通用 V2/V3 计划、稳定来源身份、字段映射确认、完整预演、逐阶段专项对账、取消、运行历史和文件下载。V3 新规则由 `RuleDraft` 明确返回提议、待澄清或不支持，并显示每项条件对应的规则节点。ERP 加班、OA 请假的筛选与模板绑定，以及年假结算的筛选、顺序余额分配与拆分，已由兼容接口切入统一 V3 引擎。通用模板容量超限时按工作表上限分批输出；每批文件均复读校验。硅基流动托管的 `deepseek-ai/DeepSeek-V4-Flash` 已完成五类能力 25 种表达 × 3 轮真实验收：75/75 在限定修复次数内形成可预演规则，首轮 74/75。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

首次运行端到端测试前执行 `pnpm exec playwright install chromium`；Ubuntu 可用 `pnpm exec playwright install --with-deps chromium`。缺少本地业务数据时，默认测试只跳过依赖该数据的用例；合成数据用例仍须全部通过。拥有授权数据的成员可把原始文件放在 `data/自动化桥接与处理智能体数据集file/`，或设置 `CTD_TEST_DATA_DIR` 指向其目录，再运行 `pnpm test:real-data`。该命令在缺文件时失败。真实模型验收会产生外部调用和费用，仅在获授权后运行 `pnpm exec tsx scripts/validate-real-model.ts --output=outputs/real-model-validation.json`。

其余测试覆盖字段别名、重复候选、前导零、严格日期、定点分钟、公式注入、年假守恒、BIFF8 文件签名与行边界。

## 安全与隐私

- 原始数据、任务目录、输出、密钥和日志均不进入 Git。
- GitHub 私密仓库只用于协作源码；不要上传真实员工数据、密钥或本机运行状态，也不要把未鉴权的本地 API 暴露到公网。
- 模型接收脱敏指令、近期对话与草案、相关动作的完整输出契约、表头、稳定列 ID、字段类型及本地统计画像，不接收源文件路径或原始数据行。硅基流动使用 Chat Completions `json_schema` 非思考模式返回非递归语义动作，本地再编译为完整 V3 Rule IR，并检查完成原因、结构、逐项条件、常量来源和计划依赖。结构修复只收到脱敏错误码、路径和失败草案。
- 无模型配置时已确认规则仍可执行；无法解析的新指令会明确进入澄清，不会静默降级。
- 内置 HR 模板按文本契约写出；V2 模板按声明的文本、数值和日期类型写出。禁止 `eval`、动态公式和模型生成代码。

详细规则见 [业务规则](docs/业务规则.md)、[配置说明](docs/配置说明.md)、[规则与来源升级接口](docs/规则与来源升级接口.md)、[异常码手册](docs/异常码手册.md) 和 [HR 导入验收清单](docs/HR导入验收清单.md)。
本轮升级的完成项与未完成项见 [升级执行进度](docs/验收/升级执行进度.md)。

## 已知边界

本项目能完成文件级 BIFF8 兼容验收。目标 HR 系统可能存在未公开约束，最终“无缝导入”仍需在真实 HR 环境完成一次验收，并将发现的约束固化为配置和回归测试。
