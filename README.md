# CTD-ABPA 跨系统表格数据桥接智能体

面向 ERP、OA、HR 等封闭系统的本地表格桥接应用。自然语言只生成受限 `ProcessPlan`；实际解析、校验、筛选、关联、计算和写出全部由确定性 TypeScript 引擎执行。

## 技术栈

- Node.js 24 LTS、pnpm 11、TypeScript Monorepo
- `packages/core`：日期、定点工时、字段匹配、业务规则、计划校验、任务状态
- `packages/excel`：`.xls/.xlsx/.csv` 分析、SheetJS 0.20.3 读写、BIFF8 和审计产物
- `apps/cli`：命令行入口
- `apps/api`：Fastify 本地 HTTP API，默认 `127.0.0.1:3210`
- `apps/web`：React 操作页，默认 `127.0.0.1:3211`

## 启动

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

执行与正式验收均要求 Node 24。`.env` 会由 API 自动加载；使用 DeepSeek 时填写 `DEEPSEEK_API_KEY`，模型与服务地址可在 `.env` 配置。

## CLI

```bash
pnpm bridge inspect data/example.xlsx
pnpm bridge run --instruction "把ERP加班转为HR格式" --overtime data/example.xlsx --output outputs/task-1
pnpm bridge run --instruction "按年假余额优先抵扣" --leave data/leave.xlsx --balance data/balance.xls --allow-stale-balance --confirmed-by Jamel --output outputs/task-2
pnpm bridge exceptions export --from outputs/task-2/审计清单.json --output outputs/task-2/exceptions.json
pnpm bridge exceptions apply --log exceptions.json --resolutions resolutions.json --output exceptions-resolved.json
pnpm bridge profile validate profiles/erp-overtime-to-hr.v1.json
pnpm bridge run-v2 --plan plan.json --rules rules.json --template templates/hr-overtime.v1.json --input data/input.xlsx --output outputs/result.xls
```

网页工作台支持业务流程与通用 V2/V3 计划、稳定来源身份、字段映射确认、完整预演、逐阶段专项对账、取消、运行历史和文件下载。V3 新规则由 `RuleDraft` 明确返回提议、待澄清或不支持，并显示每项条件对应的规则节点。ERP 加班、OA 请假的筛选与模板绑定，以及年假结算的筛选、顺序余额分配与拆分，已由兼容接口切入统一 V3 引擎。通用模板容量超限时按工作表上限分批输出；每批文件均复读校验。硅基流动托管的 `deepseek-ai/DeepSeek-V4-Flash` 已完成五类能力 25 种表达 × 3 轮真实验收：75/75 在限定修复次数内形成可预演规则，首轮 74/75。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
pnpm test:model:real -- --output=docs/验收/真实模型验收.json
pnpm migrate:tasks
```

测试覆盖字段别名、重复候选、前导零、严格日期、定点分钟、公式注入、年假守恒、BIFF8 文件签名与行边界，以及三组真实数据黄金结果。

## 安全与隐私

- 原始数据、任务目录、输出、密钥和日志均不进入 Git。
- 模型接收脱敏指令、近期对话与草案、相关动作的完整输出契约、表头、稳定列 ID、字段类型及本地统计画像，不接收源文件路径或原始数据行。硅基流动使用 Chat Completions `json_schema` 非思考模式返回非递归语义动作，本地再编译为完整 V3 Rule IR，并检查完成原因、结构、逐项条件、常量来源和计划依赖。结构修复只收到脱敏错误码、路径和失败草案。
- 无模型配置时已确认规则仍可执行；无法解析的新指令会明确进入澄清，不会静默降级。
- 内置 HR 模板按文本契约写出；V2 模板按声明的文本、数值和日期类型写出。禁止 `eval`、动态公式和模型生成代码。

详细规则见 [业务规则](docs/业务规则.md)、[配置说明](docs/配置说明.md)、[规则与来源升级接口](docs/规则与来源升级接口.md)、[异常码手册](docs/异常码手册.md) 和 [HR 导入验收清单](docs/HR导入验收清单.md)。
本轮升级的完成项与未完成项见 [升级执行进度](docs/验收/升级执行进度.md)。

## 已知边界

本项目能完成文件级 BIFF8 兼容验收。目标 HR 系统可能存在未公开约束，最终“无缝导入”仍需在真实 HR 环境完成一次验收，并将发现的约束固化为配置和回归测试。
