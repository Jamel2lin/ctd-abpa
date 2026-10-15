import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { RuleBuilder } from "./RuleBuilder.js";

type Task = { id: string; status: string; cancelRequested?: boolean; runs?: Array<{ version: number; status: string; startedAt: string; completedAt?: string; artifacts?: string[] }>; files: Array<{ id: string; fileName: string; path?: string; kind: string; sheets: Array<{ id: string; name: string; headerRow: number; rowCount: number; headers: string[]; columns: Array<{ id: string; index: number; header: string }> }> }>; plan?: any; generic?: { plan: any; rules?: { status: string }; result?: { outputFile: string; outputFiles?: Array<{ fileName: string; sha256: string; outputRows: number }>; outputRows: number; exceptions: number; sha256: string } }; manifest?: any; mappingSuggestions?: Array<{ standardField: string; sourceHeader: string; rationale: string }>; ruleDraft?: { status: string; requirements: Array<{ id: string; sourceText: string; status: string; stepId?: string; reason?: string }>; clarifications: string[] }; conversation?: Array<{ id: string; role: string; content: string }>; clarificationQuestions?: string[]; progress?: { phase: string; completed: number; total: number; message: string } };
type StageReconciliation = { stepId: string; operator: string; inputRows: number; outputRows: number; isolatedRows: number; metrics: Record<string, number> };
type Preview = { headers: string[]; rows: Array<{ cells: string[]; sourceRow: number }>; sheets?: Array<{ sheetId: string; name: string; headers: string[]; rows: string[][]; outputRows: number }>; batchCount?: number; exceptions: Array<{ id: string; code: string; message: string; businessLevel: "L1" | "L2" | "L3" | "L4"; disposition: string; requiresHumanReview: boolean; automationAllowed: boolean; sourceOfTruth: string; sourceFile?: string; sourceSheet?: string; sourceRow?: number; sourceColumn?: number; columnId?: string; lineage?: Array<{ artifactId?: string; sourceFile: string; sourceSheet: string; sourceRow?: number; sourceColumn?: number; columnId?: string }> }>; exceptionCount?: number; stages?: StageReconciliation[]; reconciliation: Record<string, number>; requiresStaleBalanceConfirmation?: boolean; balanceAsOf?: string; latestLeaveDate?: string; staleBalanceReason?: string };
const api = async (url: string, init?: RequestInit) => { const response = await fetch(url, init); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText); return response.json(); };

const STEPS = [
  { n: 1, title: "上传数据", desc: "上传源表格，识别结构与表头" },
  { n: 2, title: "生成规则", desc: "一句话描述转换，生成处理计划" },
  { n: 3, title: "预演确认", desc: "本地试算，核对并确认计划" },
  { n: 4, title: "执行下载", desc: "生成并下载交付文件" },
];

function Stepper({ current, done, onSelect }: { current: number; done: boolean[]; onSelect: (n: number) => void }) {
  return (
    <ol className="stepper">
      {STEPS.map((s, i) => (
        <li key={s.n} className={s.n === current ? "current" : done[i] ? "done" : ""}>
          <button type="button" onClick={() => onSelect(s.n)} aria-current={s.n === current ? "step" : undefined}>
            <span className="step-dot">{done[i] ? "✓" : s.n}</span>
            <span className="step-text">
              <span className="step-title">{s.title}</span>
              <span className="step-desc">{s.desc}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function StepIntro({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="step-intro">
      <h2>{title}</h2>
      <p>{lead}</p>
    </div>
  );
}

function App() {
  const [task, setTask] = useState<Task>(); const [files, setFiles] = useState<File[]>([]); const [instruction, setInstruction] = useState("将OA请假按年假余额优先抵扣，剩余转事假"); const [notice, setNotice] = useState(""); const [useModel, setUseModel] = useState(false); const [mode, setMode] = useState<"business" | "generic">("business"); const [preview, setPreview] = useState<Preview>(); const [planJson, setPlanJson] = useState(""); const [genericJson, setGenericJson] = useState(""); const [ruleRef, setRuleRef] = useState(""); const [templateRef, setTemplateRef] = useState(""); const [models, setModels] = useState<Array<{ provider: string; model: string; enabled: boolean; apiKeyConfigured: boolean }>>([]); const [configJson, setConfigJson] = useState(""); const [ruleDiffRef, setRuleDiffRef] = useState(""); const [ruleDiff, setRuleDiff] = useState<unknown>(); const [lifecycleRef, setLifecycleRef] = useState(""); const [restoreRef, setRestoreRef] = useState(""); const [rules, setRules] = useState<Array<{ id: string; version: number; name: string; status: string; scope?: { kind: string; sourceIdentity?: string } }>>([]); const [fieldAliases, setFieldAliases] = useState<Record<string, string[]>>({}); const [selectedScope, setSelectedScope] = useState(""); const [mappingField, setMappingField] = useState("employeeId"); const [mappingHeader, setMappingHeader] = useState(""); const [confirmedMappings, setConfirmedMappings] = useState<Array<{ artifactId: string; sheetId: string; sourceIdentity?: { id: string; system: string; reportType: string }; structureFingerprint: string; mappings: Array<{ id: string; standardField: string; sourceHeader: string; active: boolean; structureCompatible: boolean }> }>>([]);
  const [staleConfirmed, setStaleConfirmed] = useState(false); const [confirmedBy, setConfirmedBy] = useState("");
  const [staleEvidence, setStaleEvidence] = useState("");
  const [session, setSession] = useState<{ authenticationRequired: boolean; user: { id: string; role: string } | null }>();
  const [taskList, setTaskList] = useState<Array<{ id: string; status: string }>>([]);
  const [loginToken, setLoginToken] = useState("");
  const [headerRows, setHeaderRows] = useState("");
  const [exceptionOffset, setExceptionOffset] = useState(0);
  const [sourceRows, setSourceRows] = useState<Array<{ sourceRow: number; cells: unknown[] }>>([]);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const create = async () => { setFiles([]); setTask(await api("/api/tasks", { method: "POST" })); setPreview(undefined); setPlanJson(""); setGenericJson(""); setStaleConfirmed(false); setStep(1); };
  useEffect(() => { void api("/api/auth/session").then(setSession).catch((error) => setNotice(error.message)); }, []);
  useEffect(() => { if (!session?.user) return; void api("/api/tasks").then((tasks) => { setTaskList(tasks); if (session.user?.role === "viewer") setTask(tasks[0]); else void create().catch((error) => setNotice(error.message)); }); void api("/api/models/status").then(setModels); void api("/api/fields").then(setFieldAliases); void api("/api/rules").then(setRules); }, [session?.user?.id]);
  const login = async () => { try { await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: loginToken }) }); setLoginToken(""); setSession(await api("/api/auth/session")); } catch (error) { setNotice((error as Error).message); } };
  useEffect(() => {
    if (!task?.id) return;
    const events = new EventSource(`/api/tasks/${task.id}/events`);
    events.addEventListener("task", (event) => setTask(JSON.parse((event as MessageEvent).data)));
    return () => events.close();
  }, [task?.id]);
  const upload = async () => { if (!task || !files.length) return; const form = new FormData(); files.forEach((file) => form.append("files", file)); await api(`/api/tasks/${task.id}/files`, { method: "POST", body: form }); setTask(await api(`/api/tasks/${task.id}/analyze`, { method: "POST" })); setConfirmedMappings(await api(`/api/tasks/${task.id}/mappings`)); setNotice("结构分析完成"); setFiles([]); setStep(2); };
  const reanalyze = async () => { if (!task?.files.length) return; setPreview(undefined); setStaleConfirmed(false); try { setTask(await api(`/api/tasks/${task.id}/analyze`, { method: "POST" })); setNotice("源文件已重新分析，计划需重新预演和确认"); } catch (error) { setNotice((error as Error).message); } };
  const generatePlan = async () => { if (!task) return; setPreview(undefined); setStaleConfirmed(false); setBusy(true); try { await api(`/api/tasks/${task.id}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, useModel, provider: "deepseek" }) }); const next = await api(`/api/tasks/${task.id}`); setTask(next); setPlanJson(JSON.stringify(next.plan, null, 2)); setNotice("处理计划已生成，请先预览再确认"); setStep(3); } catch (error) { setTask(await api(`/api/tasks/${task.id}`)); setNotice((error as Error).message); } finally { setBusy(false); } };
  const savePlan = async () => { if (!task) return; setPreview(undefined); setStaleConfirmed(false); const value = await api(`/api/tasks/${task.id}/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: planJson }); setPlanJson(JSON.stringify(value, null, 2)); setTask(await api(`/api/tasks/${task.id}`)); setNotice("计划修改已保存，原确认已失效"); };
  const loadPreview = async () => { setExceptionOffset(0); if (!task) return; setPreview(undefined); setStaleConfirmed(false); try { setPreview(await api(`/api/tasks/${task.id}/preview`, { method: "POST" })); setTask(await api(`/api/tasks/${task.id}`)); setNotice("本地预览完成，尚未写出文件"); } catch (error) { setNotice((error as Error).message); } };
  const confirm = async () => { if (!task) return; const isStale = Boolean(preview?.requiresStaleBalanceConfirmation); if (isStale && (!staleConfirmed || !confirmedBy.trim() || !staleEvidence.trim())) { setNotice("年假余额时点需核实，请勾选确认并填写签署人与核实依据"); return; } try { setTask(await api(`/api/tasks/${task.id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowStaleBalance: isStale, confirmedBy: confirmedBy.trim() || "Web用户", staleBalanceEvidence: staleEvidence.trim() }) })); setNotice("计划版本已确认"); setStep(4); } catch (error) { setNotice((error as Error).message); } };
  const execute = async () => { if (!task) return; setNotice("处理中…"); try { const next = await api(`/api/tasks/${task.id}/execute`, { method: "POST" }); setTask(next); setNotice(next.status === "cancelled" ? "运行已取消" : "处理完成"); } catch (error) { setTask(await api(`/api/tasks/${task.id}`)); setNotice((error as Error).message); } };
  const cancelRun = async () => { if (!task) return; try { setTask(await api(`/api/tasks/${task.id}/cancel`, { method: "POST" })); setNotice("已请求取消，等待当前步骤结束"); } catch (error) { setNotice((error as Error).message); } };
  const patchSource = (error: Preview["exceptions"][number]) => {
    const traces = error.lineage?.filter((trace) => trace.sourceRow !== undefined) ?? [];
    const trace = traces.find((trace) => trace.columnId === error.columnId) ?? traces.find((trace) => trace.sourceFile === error.sourceFile && trace.sourceSheet === error.sourceSheet && trace.sourceRow === error.sourceRow);
    const matches = task?.files.filter((file) => trace?.artifactId ? file.id === trace.artifactId : [file.fileName, file.path?.split("/").at(-1)].some((name) => name !== undefined && (name === error.sourceFile || name === trace?.sourceFile))).flatMap((file) => file.sheets.filter((sheet) => sheet.name === (trace?.sourceSheet ?? error.sourceSheet)).map((sheet) => ({ file, sheet }))) ?? [];
    const sourceRow = trace?.sourceRow ?? error.sourceRow;
    if (matches.length !== 1 || sourceRow === undefined) throw new Error("无法唯一定位异常源行，请从原始来源中选择后处理");
    return { artifactId: matches[0].file.id, sheetId: matches[0].sheet.id, sourceRow, columns: matches[0].sheet.columns, sourceColumn: trace?.sourceColumn ?? error.sourceColumn };
  };
  const resolveException = async (error: Preview["exceptions"][number], action: "correct" | "exclude") => {
    if (!task) return;
    try {
      const source = patchSource(error);
      let columnId: string | undefined, value: string | undefined;
      if (action === "correct") {
        const header = window.prompt("请输入要修正的源列名", source.columns.find((column) => column.index + 1 === source.sourceColumn)?.header ?? source.columns[0]?.header ?? "");
        if (!header) return;
        const column = source.columns.find((item) => item.header === header);
        if (!column) throw new Error("源列名不存在");
        columnId = column.id;
        const answer = window.prompt(`请输入 ${header} 的新值`); if (answer === null) return; value = answer;
      }
      const reason = window.prompt("请填写人工处理原因"); if (!reason?.trim()) return;
      const evidence = window.prompt("请填写核实依据（身份冲突填写 HR 主数据日期及记录编号）"); if (!evidence?.trim()) return;
      await api(`/api/tasks/${task.id}/patches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exceptionId: error.id, action, artifactId: source.artifactId, sheetId: source.sheetId, sourceRow: source.sourceRow, columnId, value, reason, evidence }) });
      if (task.generic) await previewGeneric(); else await loadPreview();
      setNotice("人工处理记录已保存并重算；请重新确认");
    } catch (cause) { setNotice((cause as Error).message); }
  };
  const exclude = (error: Preview["exceptions"][number]) => resolveException(error, "exclude");
  const correct = (error: Preview["exceptions"][number]) => resolveException(error, "correct");
  const publishConfig = async () => { const value = JSON.parse(configJson), kind = value.sheets ? "templates" : "rules"; await api(`/api/${kind}/${value.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }); setNotice(`${kind === "rules" ? "规则" : "模板"}版本已发布`); };
  const loadRuleDiff = async () => { const match = /^(.+)@(\d+)\.\.(\d+)$/.exec(ruleDiffRef.trim()); if (!match) { setNotice("差异格式应为 规则ID@起始版本..目标版本"); return; } try { setRuleDiff(await api(`/api/rules/${encodeURIComponent(match[1])}/diff?from=${match[2]}&to=${match[3]}`)); setNotice("规则版本差异已加载"); } catch (error) { setNotice((error as Error).message); } };
  const refreshRules = async () => setRules(await api("/api/rules"));
  const advanceRule = async (action: "validate" | "confirm" | "publish" | "supersede") => { const match = /^(.+)@(\d+)$/.exec(lifecycleRef.trim()); if (!match) { setNotice("生命周期格式应为 规则ID@版本号"); return; } try { const body = action === "confirm" ? { confirmedBy: "Web用户" } : action === "publish" ? { sourceIdentity: window.prompt("发布到来源身份（如 oa:leave）") || undefined, publishedBy: "Web用户" } : action === "supersede" ? { supersededBy: "Web用户" } : undefined; if (action === "publish" && !body?.sourceIdentity) return; const value = await api(`/api/rules/${encodeURIComponent(match[1])}/revisions/${match[2]}/${action}`, { method: "POST", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }); setConfigJson(JSON.stringify(value, null, 2)); await refreshRules(); setNotice(`规则已${action === "validate" ? "校验" : action === "confirm" ? "确认" : action === "publish" ? "发布" : "标记为已取代"}`); } catch (error) { setNotice((error as Error).message); } };
  const restoreRule = async () => { const match = /^(.+)@(\d+)\.\.(\d+)$/.exec(restoreRef.trim()); if (!match) { setNotice("恢复格式应为 规则ID@历史版本..当前基础版本"); return; } try { const value = await api(`/api/rules/${encodeURIComponent(match[1])}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceVersion: Number(match[2]), baseRevision: Number(match[3]), editedBy: "Web用户" }) }); setConfigJson(JSON.stringify(value, null, 2)); await refreshRules(); setNotice("历史内容已恢复为新草稿修订"); } catch (error) { setNotice((error as Error).message); } };
  const proposeRulePatch = async () => { const id = /^(.+?)(?:@\d+)?$/.exec(lifecycleRef.trim())?.[1]; if (!id || !instruction.trim()) { setNotice("请填写规则 ID 和自然语言修改指令"); return; } setBusy(true); try { const value = await api(`/api/rules/${encodeURIComponent(id)}/revisions/propose-patch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, editedBy: "Web用户", provider: "deepseek" }) }); setConfigJson(JSON.stringify(value, null, 2)); await refreshRules(); setNotice(value.status === "clarification_required" ? "规则修改需要澄清" : "增量修订草稿已创建"); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  const saveGenericPlan = async () => { if (!task) return; setPreview(undefined); await api(`/api/tasks/${task.id}/v2/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: genericJson }); setTask(await api(`/api/tasks/${task.id}`)); setNotice("V2 计划与已发布规则、模板版本已绑定"); setStep(3); };
  const suggestGeneric = async () => { if (!task) return; setPreview(undefined); const rule = ruleRef.trim() ? /^(.+)@(\d+)$/.exec(ruleRef.trim()) : null, template = /^(.+)@(\d+)$/.exec(templateRef.trim()); if ((ruleRef.trim() && !rule) || !template) { setNotice("规则须填写 id@版本号或留空自动检索；模板须填写 id@版本号"); return; } setBusy(true); try { const sourceIdentity = confirmedMappings.find((entry) => entry.sourceIdentity)?.sourceIdentity?.id; const generic = await api(`/api/tasks/${task.id}/v2/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, ...(rule ? { ruleId: rule[1], ruleVersion: Number(rule[2]) } : { sourceIdentity }), templateId: template[1], templateVersion: Number(template[2]) }) }); setGenericJson(JSON.stringify(generic.plan, null, 2)); setTask(await api(`/api/tasks/${task.id}`)); setNotice("DeepSeek V2 建议已通过本地校验，请预览"); setStep(3); } catch (error) { setTask(await api(`/api/tasks/${task.id}`)); setNotice((error as Error).message); } finally { setBusy(false); } };
  const proposeGeneric = async () => { if (!task) return; setPreview(undefined); const template = /^(.+)@(\d+)$/.exec(templateRef.trim()); if (!template) { setNotice("目标模板须填写 id@版本号"); return; } setBusy(true); try { const generic = await api(`/api/tasks/${task.id}/v3/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, templateId: template[1], templateVersion: Number(template[2]) }) }); setGenericJson(JSON.stringify(generic.plan, null, 2)); setTask(await api(`/api/tasks/${task.id}`)); setNotice("新规则草案已通过本地结构校验，请预演后确认本次使用"); setStep(3); } catch (error) { setTask(await api(`/api/tasks/${task.id}`)); setNotice((error as Error).message); } finally { setBusy(false); } };
  const previewGeneric = async () => { setExceptionOffset(0); if (!task) return; setPreview(undefined); try { setPreview(await api(`/api/tasks/${task.id}/v2/preview`, { method: "POST" })); setTask(await api(`/api/tasks/${task.id}`)); setNotice("V2 本地预览完成"); } catch (error) { setNotice((error as Error).message); } };
  const confirmGeneric = async () => { if (!task) return; try { setTask(await api(`/api/tasks/${task.id}/v2/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmedBy: "Web用户" }) })); setNotice("V2 计划版本已确认"); setStep(4); } catch (error) { setNotice((error as Error).message); } };
  const executeGeneric = async () => { if (!task) return; setNotice("通用计划执行中…"); try { const next = await api(`/api/tasks/${task.id}/v2/execute`, { method: "POST" }); setTask(next); setNotice(next.status === "cancelled" ? "运行已取消" : "目标文件已生成并复读校验"); } catch (error) { setTask(await api(`/api/tasks/${task.id}`)); setNotice((error as Error).message); } };
  const sourceSheets = task?.files.flatMap((file) => file.sheets.filter((sheet) => sheet.headers.length).map((sheet) => ({ file, sheet, key: `${file.id}/${sheet.id}` }))) ?? [];
  const currentSheet = sourceSheets.find((item) => item.key === selectedScope) ?? sourceSheets[0];
  const refreshMappings = async () => { if (task) setConfirmedMappings(await api(`/api/tasks/${task.id}/mappings`)); };
  const bindSourceIdentity = async () => { if (!task || !currentSheet) return; const system = window.prompt("来源系统（例如 OA、ERP）"); if (!system) return; const reportType = window.prompt("报表类型（例如 leave、overtime）"); if (!reportType) return; try { await api(`/api/tasks/${task.id}/sources/${currentSheet.file.id}/bind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system, reportType }) }); await refreshMappings(); setTask(await api(`/api/tasks/${task.id}`)); setNotice("来源身份已绑定；结构指纹将单独用于漂移检查"); } catch (error) { setNotice((error as Error).message); } };
  const confirmMapping = async (standardField = mappingField, sourceHeader = mappingHeader) => { if (!task || !currentSheet || !sourceHeader) return; try { await api(`/api/tasks/${task.id}/mappings/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifactId: currentSheet.file.id, sheetId: currentSheet.sheet.id, standardField, sourceHeader, confirmedBy: "Web用户" }) }); await refreshMappings(); setTask(await api(`/api/tasks/${task.id}`)); setPreview(undefined); setNotice("字段映射已按来源范围确认；请重新预演"); } catch (error) { setNotice((error as Error).message); } };
  const suggestMapping = async () => { if (!task || !currentSheet) return; setBusy(true); try { await api(`/api/tasks/${task.id}/mapping-suggestions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sheetId: currentSheet.sheet.id, instruction }) }); setTask(await api(`/api/tasks/${task.id}`)); setNotice("模型映射建议已生成，需逐项确认"); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  const deactivateMapping = async (id: string) => { if (!task) return; await api(`/api/tasks/${task.id}/mappings/${id}/deactivate`, { method: "POST" }); await refreshMappings(); setTask(await api(`/api/tasks/${task.id}`)); setPreview(undefined); setNotice("映射已停用"); };
  const shownSheets = preview?.sheets ?? (preview ? [{ sheetId: "main", name: "结果", headers: preview.headers, rows: preview.rows.map((row) => row.cells), outputRows: preview.reconciliation.outputRows ?? preview.rows.length }] : []);
  const loadExceptionPage = async (offset: number) => { if (!task || !preview) return; try { const page = await api(`/api/tasks/${task.id}/exceptions?offset=${offset}&limit=20`); setExceptionOffset(offset); setPreview({ ...preview, exceptions: page.exceptions, exceptionCount: page.total }); } catch (error) { setNotice((error as Error).message); } };
  const previewSource = async () => { if (!task || !currentSheet) return; setSourceRows(await api(`/api/tasks/${task.id}/sheets/${currentSheet.file.id}/${currentSheet.sheet.id}/rows`)); setHeaderRows(String(currentSheet.sheet.headerRow)); };
  const saveHeader = async () => { if (!task || !currentSheet) return; try { const next = await api(`/api/tasks/${task.id}/sources/${currentSheet.file.id}/header`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sheetId: currentSheet.sheet.id, headerRows: headerRows.split(",").map(Number) }) }); setTask(next); setPreview(undefined); setStaleConfirmed(false); setNotice("表头已更新，原确认失效；请重新生成或绑定计划"); } catch (error) { setNotice((error as Error).message); } };
  const doneSteps = [(task?.files.length ?? 0) > 0, Boolean(task?.plan || task?.generic), Boolean(preview), ["completed", "completed_with_exceptions"].includes(task?.status ?? "")];
  const isGeneric = mode === "generic";
  if (!session?.user) return <main><div className="shell"><header className="topbar"><p className="eyebrow">CTD-ABPA</p><h1>跨系统表格数据桥接</h1><p className="tagline">把 ERP、OA、HR 导出的表格，安全地转换成 HR 系统可直接导入的格式。</p></header>{session?.authenticationRequired ? <section className="card login"><label>登录令牌<input type="password" value={loginToken} onChange={(event) => setLoginToken(event.target.value)} autoComplete="off"/></label><button onClick={login}>登录</button></section> : <p className="muted">正在连接…</p>}{notice && <p className="alert">{notice}</p>}</div></main>;

  return <main>
    <div className="shell">
      <header className="topbar">
        <div className="topbar-main">
          <p className="eyebrow">CTD-ABPA</p>
          <h1>跨系统表格数据桥接</h1>
          <p className="tagline">把 ERP、OA、HR 导出的表格，安全地转换成 HR 系统可直接导入的格式。全程本地计算，原始数据不离开本机。</p>
        </div>
        <div className="topbar-actions">
          <span className="muted operator">操作人：{session.user.id} · {session.user.role}</span>
          <button className="ghost" onClick={create} disabled={session.user.role === "viewer"}>新建任务</button>
          {session.authenticationRequired && <button className="ghost" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setTask(undefined); setSession(await api("/api/auth/session")); }}>退出登录</button>}
        </div>
      </header>

      <details className="onboard">
        <summary>第一次使用？了解这个系统能做什么</summary>
        <div className="onboard-body">
          <p><strong>它能做什么：</strong>不同业务系统（ERP、OA、HR）导出的表格字段名和格式各不相同，无法直接互相导入。这个系统把来源表格解析、清洗、关联、计算后，按目标 HR 系统的模板写出标准文件，并附带异常日志和审计清单，全程由本地确定性引擎完成，模型只负责理解你的指令。</p>
          <div className="onboard-grid">
            {STEPS.map((s) => <div key={s.n} className="onboard-item"><span className="step-dot">{s.n}</span><div><strong>{s.title}</strong><p>{s.desc}</p></div></div>)}
          </div>
          <p className="muted">示例数据位于项目 <code>tests/fixtures/</code> 目录，可先用 <code>overtime.csv</code>、<code>leave.csv</code>、<code>balance.csv</code> 体验完整流程。</p>
        </div>
      </details>

      {session.authenticationRequired && <label className="task-picker">已有任务<select value={task?.id ?? ""} onChange={async (event) => { if (!event.target.value) return; setTask(await api(`/api/tasks/${event.target.value}`)); setPreview(undefined); setStaleConfirmed(false); }}><option value="">选择授权任务</option>{taskList.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status}</option>)}</select><button className="ghost" onClick={async () => setTaskList(await api("/api/tasks"))}>刷新</button></label>}

      <div className="status"><span>任务 {task?.id?.slice(0, 8) ?? "创建中"} · {task?.progress?.message ?? "等待操作"}</span><strong className={`badge badge-${task?.status ?? "draft"}`}>{task?.status ?? "draft"}</strong></div>

      <Stepper current={step} done={doneSteps} onSelect={setStep} />

      <div className="step-panel">
        <section className="card" hidden={step !== 1}>
          <StepIntro title="上传数据" lead="上传来源系统导出的表格。系统会自动识别表头、行数和列类型；识别不准时可在下方手动修正表头。" />
          <div className="dropzone">
            <label className="file-pick">
              <input type="file" multiple accept=".xls,.xlsx,.csv" onChange={(event) => { const selected = Array.from(event.target.files ?? []); setFiles(prev => [...prev, ...selected]); event.target.value = ""; }}/>
              <span className="file-pick-label">选择文件</span>
            </label>
            <button onClick={upload} disabled={!files.length}>上传并分析</button>
            <p className="muted hint">支持 .xls / .xlsx / .csv，可多选。年假结算需同时上传请假表与余额表。</p>
          </div>
          {files.length > 0 && <div className="selected-files">{files.map((file, i) => <div className="file-chip" key={i}><span>{file.name}</span><button className="chip-remove" onClick={() => setFiles(files.filter((_, j) => i !== j))} aria-label={`移除 ${file.name}`}>×</button></div>)}</div>}
          {!!task?.files.length && <button className="ghost" onClick={reanalyze} disabled={task.status === "running"}>重新分析已有文件</button>}
          {!!task?.files.length && <div className="file-list">{task.files.map((file) => <div className="file" key={file.id}><div><b>{file.fileName}</b><span className="file-kind">{file.kind}</span></div><span className="muted">{file.sheets.filter((sheet) => sheet.rowCount).map((sheet) => `${sheet.name} ${sheet.rowCount} 行`).join("，")}</span></div>)}</div>}
          {!task?.files.length && <div className="empty">还没有文件。上传后，这里会列出每个文件的识别结果。</div>}
          {currentSheet && <details className="sub-panel"><summary>工作表与表头纠错</summary><select aria-label="表头工作表" value={currentSheet.key} onChange={(event) => { setSelectedScope(event.target.value); setSourceRows([]); }}>{sourceSheets.map((item) => <option key={item.key} value={item.key}>{item.file.fileName} / {item.sheet.name}</option>)}</select><button className="ghost" onClick={previewSource}>查看前100行</button><label>表头行（多行用英文逗号分隔）<input value={headerRows} onChange={(event) => setHeaderRows(event.target.value)}/></label><button onClick={saveHeader} disabled={!headerRows.trim()}>应用表头选择</button><div className="table"><table><tbody>{sourceRows.map((row) => <tr key={row.sourceRow}><th>{row.sourceRow}</th>{row.cells.map((cell, index) => <td key={index}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table></div></details>}
        </section>

        <section className="card" hidden={step !== 2}>
          <StepIntro title="生成规则" lead="用一句自然语言描述要做什么，例如「把 ERP 加班转为 HR 格式」。系统生成本地可执行的计划；也可切换「通用表格任务」自定义规则。" />
          <label className="field-label">转换指令<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)}/></label>
          <div className="mode-toggle" role="tablist">
            <button type="button" className={mode === "business" ? "active" : ""} onClick={() => setMode("business")}>年假与 HR 业务</button>
            <button type="button" className={mode === "generic" ? "active" : ""} onClick={() => setMode("generic")}>通用表格任务</button>
          </div>
          {!isGeneric ? <>
            <label className="check"><input type="checkbox" checked={useModel} onChange={(event) => setUseModel(event.target.checked)}/>使用 DeepSeek 规划</label>
            <button onClick={generatePlan} disabled={busy}>{busy && <span className="spinner"/>}{busy ? "正在生成计划…" : "生成业务计划"}</button>
            {task?.plan && <><textarea className="code" value={planJson || JSON.stringify(task.plan, null, 2)} onChange={(event) => setPlanJson(event.target.value)}/><button className="ghost" onClick={savePlan}>保存计划</button></>}
            {currentSheet && <div className="mapping-editor"><h3>字段映射</h3><p className="muted">将来源列名对到标准字段，系统据此理解数据。</p><select value={currentSheet.key} onChange={(event) => { setSelectedScope(event.target.value); setMappingHeader(""); }}>{sourceSheets.map((item) => <option key={item.key} value={item.key}>{item.file.fileName} / {item.sheet.name}</option>)}</select><button className="ghost" onClick={bindSourceIdentity}>绑定来源身份</button><select value={mappingField} onChange={(event) => setMappingField(event.target.value)}>{Object.keys(fieldAliases).map((field) => <option key={field} value={field}>{field} · {fieldAliases[field][0]}</option>)}</select><select value={mappingHeader} onChange={(event) => setMappingHeader(event.target.value)}><option value="">选择源列</option>{currentSheet.sheet.columns.map((column) => <option key={column.id} value={column.header}>{column.header}</option>)}</select><button onClick={() => confirmMapping()} disabled={!mappingHeader}>确认映射</button><button className="ghost" onClick={suggestMapping} disabled={busy}>{busy && <span className="spinner"/>}{busy ? "生成中…" : "模型建议"}</button><button className="ghost" onClick={refreshMappings}>查看已确认映射</button>{confirmedMappings.filter((entry) => entry.artifactId === currentSheet.file.id && entry.sheetId === currentSheet.sheet.id).map((entry) => <p className="muted" key={`${entry.artifactId}/${entry.sheetId}`}>来源：{entry.sourceIdentity?.id ?? "未绑定"} · 结构：{entry.structureFingerprint.slice(0, 12)}</p>)}{confirmedMappings.filter((entry) => entry.artifactId === currentSheet.file.id && entry.sheetId === currentSheet.sheet.id).flatMap((entry) => entry.mappings.filter((mapping) => mapping.active).map((mapping) => <div className="file" key={mapping.id}><span>{mapping.standardField} ← {mapping.sourceHeader}{mapping.structureCompatible ? "" : "（结构已漂移，禁止复用）"}</span><button className="ghost" onClick={() => deactivateMapping(mapping.id)}>停用</button></div>))}{task?.mappingSuggestions?.map((mapping, index) => <div className="file" key={index}><span>{mapping.standardField} ← {mapping.sourceHeader}：{mapping.rationale}</span><button className="ghost" onClick={() => confirmMapping(mapping.standardField, mapping.sourceHeader)}>确认建议</button></div>)}</div>}
          </> : <>
            {task && <RuleBuilder key={task?.id} task={task} api={api} onNotice={setNotice} onBound={async (plan: any) => { await api(`/api/tasks/${task!.id}/v2/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(plan) }); setGenericJson(JSON.stringify(plan, null, 2)); setTask(await api(`/api/tasks/${task!.id}`)); setPreview(undefined); setNotice("表单计划已绑定，请完整预演"); setStep(3); }}/>}
            <p className="muted">选择已发布规则复用，或根据指令提出本次使用的新规则草案。</p>
            <label className="field-label">规则引用<input value={ruleRef} onChange={(event) => setRuleRef(event.target.value)} placeholder="已发布规则 ID@版本号（留空则按来源身份自动检索）"/></label>
            <label className="field-label">目标模板<input value={templateRef} onChange={(event) => setTemplateRef(event.target.value)} placeholder="目标模板 ID@版本号"/></label>
            <button onClick={suggestGeneric} disabled={!templateRef || busy}>{busy && <span className="spinner"/>}{busy ? "正在规划…" : "检索/复用规则并规划"}</button>
            <button onClick={proposeGeneric} disabled={!templateRef || busy}>{busy && <span className="spinner"/>}{busy ? "正在生成…" : "提出新规则草案"}</button>
            {task?.files.flatMap((file) => file.sheets.map((sheet) => <div className="file" key={`${file.id}/${sheet.id}`}><b>{file.fileName} / {sheet.name}</b><span>{sheet.columns.map((column) => `${column.index}:${column.header}`).join("，")}</span></div>))}
            <textarea className="code" value={genericJson} onChange={(event) => setGenericJson(event.target.value)} placeholder="高级入口：ProcessPlanV2 / V3 JSON"/>
            <button className="ghost" onClick={saveGenericPlan} disabled={!genericJson.trim() || task?.generic?.rules?.status === "draft"}>绑定手工计划</button>
          </>}
          <p className="muted model-status">{models.map((model) => `${model.provider}: ${model.enabled && model.apiKeyConfigured ? `${model.model} 可用` : "未配置"}`).join(" · ")}</p>
          {task?.clarificationQuestions?.map((question) => <p className="alert" key={question}>需要澄清：{question}</p>)}
          {task?.ruleDraft?.requirements?.map((item) => <p className={item.status === "satisfied" ? "muted" : "alert"} key={item.id}>{item.status === "satisfied" ? "已落实" : "待处理"}：{item.sourceText}{item.stepId ? ` → ${item.stepId}` : ""}{item.reason ? ` · ${item.reason}` : ""}</p>)}
        </section>

        <section className="card" hidden={step !== 3}>
          <StepIntro title="预演确认" lead="在真正生成文件前，先在本地完整试算一遍，核对输出行数、字段和异常。异常可以修正源值或排除源行，核对无误后确认计划。" />
          {(!task?.plan && !task?.generic) ? <div className="empty">还没有计划。请先回到「生成规则」生成或绑定计划。</div> : <>
            <button onClick={task.generic ? previewGeneric : loadPreview}>完整预演</button>
            {preview && <>
              {preview.requiresStaleBalanceConfirmation && <div className="alert stale-alert">
                <h3>余额时点可能过期</h3>
                <p>{preview.staleBalanceReason}。余额表时点：<strong>{preview.balanceAsOf}</strong>；参与结算的最晚请假日期：<strong>{preview.latestLeaveDate}</strong>。</p>
                <p className="muted">请 HR 重新核实：若有标明具体截至日的余额表，可在「上传数据」重新上传并分析；若确认继续使用当前余额，请勾选下方确认项并签署。</p>
                <label className="check"><input type="checkbox" id="stale-balance-check" checked={staleConfirmed} onChange={(event) => setStaleConfirmed(event.target.checked)}/>我已核实，确认本次结算继续使用上述年假余额</label>
                <div className="stale-signer"><span>HR 确认人：</span><input type="text" id="stale-confirmed-by" value={confirmedBy} onChange={(event) => setConfirmedBy(event.target.value)} placeholder="HR 确认人姓名或工号"/></div>
                <label>核实依据<input id="stale-evidence" value={staleEvidence} onChange={(event) => setStaleEvidence(event.target.value)} placeholder="核实记录编号、日期与继续使用该余额的依据"/></label>
              </div>}
              <p className="recon-line">{Object.entries(preview.reconciliation).map(([key, value]) => `${key}: ${value}`).join(" · ")} · 异常总数: {preview.exceptionCount ?? preview.exceptions.length}{preview.batchCount ? ` · 预计 ${preview.batchCount} 批文件` : ""}</p>
              {!!preview.stages?.length && <details className="sub-panel"><summary>逐阶段对账（{preview.stages.length} 步）</summary><div className="table"><table><thead><tr><th>步骤</th><th>算子</th><th>输入</th><th>输出</th><th>隔离</th><th>专项指标</th></tr></thead><tbody>{preview.stages.map((stage) => <tr key={stage.stepId}><td>{stage.stepId}</td><td>{stage.operator}</td><td>{stage.inputRows}</td><td>{stage.outputRows}</td><td>{stage.isolatedRows}</td><td>{Object.entries(stage.metrics).map(([key, value]) => `${key}=${value}`).join(" · ") || "—"}</td></tr>)}</tbody></table></div></details>}
              {shownSheets.map((sheet) => <div key={sheet.sheetId} className="sheet-preview"><h3>{sheet.name} · {sheet.outputRows} 行</h3><div className="table"><table><thead><tr>{sheet.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{sheet.rows.slice(0, 10).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div></div>)}
              {preview.exceptions.map((error) => <div className="exception" key={error.id}><span><span className={`level level-${error.businessLevel}`}>{error.businessLevel}</span> {error.code} · {error.sourceFile} / {error.sourceSheet} · 第 {error.sourceRow} 行 · {error.message} · 权威来源：{error.sourceOfTruth}{error.requiresHumanReview ? " · 需人工复核" : ""}{error.automationAllowed ? "" : " · 禁止自动处理"}</span><span className="exception-actions"><button onClick={() => correct(error)}>修正源值并预览</button><button className="ghost" onClick={() => exclude(error)}>排除源行并预览</button></span></div>)}
              {(preview.exceptionCount ?? 0) > 20 && <p className="pager"><button className="ghost" disabled={exceptionOffset === 0} onClick={() => loadExceptionPage(Math.max(0, exceptionOffset - 20))}>上一页异常</button><span>{exceptionOffset + 1}–{exceptionOffset + preview.exceptions.length} / {preview.exceptionCount}</span><button className="ghost" disabled={exceptionOffset + 20 >= (preview.exceptionCount ?? 0)} onClick={() => loadExceptionPage(exceptionOffset + 20)}>下一页异常</button></p>}
            </>}
            {task?.status === "awaiting_confirmation" && preview && <>
              <button className="warn" onClick={task.generic ? confirmGeneric : confirm} disabled={!task.generic && Boolean(preview.requiresStaleBalanceConfirmation) && (!staleConfirmed || !confirmedBy.trim() || !staleEvidence.trim())}>{task.generic ? (task.generic?.rules?.status === "draft" ? "确认本次使用草案" : "确认当前计划") : "确认当前计划"}</button>
              {!task.generic && preview.requiresStaleBalanceConfirmation && !staleConfirmed && <span className="muted">（余额时点需核实，请在上方显式确认后方可继续）</span>}
            </>}
          </>}
        </section>

        <section className="card" hidden={step !== 4}>
          <StepIntro title="执行下载" lead="计划确认后执行，生成 HR 导入文件、异常日志和审计清单，并在此下载。" />
          <button onClick={task?.generic ? executeGeneric : execute} disabled={!task || !["ready", "cancelled", "failed"].includes(task.status)}>执行并生成文件</button>
          {task?.status === "running" && <button className="warn" onClick={cancelRun} disabled={task.cancelRequested}>取消当前运行</button>}
          {!!task?.runs?.length && <div className="run-history"><h3>运行记录</h3>{task.runs.map((run) => <p key={run.version}>第 {run.version} 次 · {run.status} · {run.startedAt}{run.completedAt ? ` → ${run.completedAt}` : ""}{run.artifacts?.map((name) => <a key={name} href={`/api/tasks/${task.id}/runs/${run.version}/artifacts/${encodeURIComponent(name)}`}>{name}</a>)}</p>)}</div>}
          {task?.manifest && <div className="artifacts"><a href={`/api/tasks/${task.id}/artifacts/HR导入.xls`}>HR 导入文件</a><a href={`/api/tasks/${task.id}/artifacts/异常日志.xlsx`}>异常日志</a>{task.manifest.calculationSummary?.annualMinutes !== undefined && <a href={`/api/tasks/${task.id}/artifacts/年假余额对账.xlsx`}>年假对账</a>}<a href={`/api/tasks/${task.id}/artifacts/任务产物.zip`}>全部 ZIP</a></div>}
          {task?.generic?.result && <div className="artifacts">{(task.generic.result.outputFiles ?? [{ fileName: task.generic.result.outputFile }]).map((file) => <a key={file.fileName} href={`/api/tasks/${task.id}/artifacts/${encodeURIComponent(file.fileName)}`}>{(task.generic!.result!.outputFiles?.length ?? 1) === 1 ? "目标文件" : file.fileName}</a>)}{task.generic.result.exceptions > 0 && <a href={`/api/tasks/${task.id}/artifacts/异常日志.xlsx`}>异常日志</a>}<a href={`/api/tasks/${task.id}/artifacts/审计清单.json`}>审计清单</a></div>}
          {!task?.manifest && !task?.generic?.result && <div className="empty">还没有生成结果。确认计划后点击「执行并生成文件」。</div>}
        </section>
      </div>

      <nav className="step-nav">
        <button className="ghost" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>上一步</button>
        <span className="muted">第 {step} / 4 步</span>
        <button onClick={() => setStep(Math.min(4, step + 1))} disabled={step === 4}>下一步</button>
      </nav>

      <details className="sub-panel advanced"><summary>高级配置：规则与模板版本</summary><section><textarea className="code" value={configJson} onChange={(event) => setConfigJson(event.target.value)} placeholder="粘贴规则或模板 JSON；发布后禁止覆盖"/><button onClick={publishConfig} disabled={!configJson.trim()}>校验并发布</button><h3>规则生命周期</h3><input value={lifecycleRef} onChange={(event) => setLifecycleRef(event.target.value)} placeholder="规则ID@版本号"/><button className="ghost" onClick={() => advanceRule("validate")}>校验草稿</button><button className="ghost" onClick={() => advanceRule("confirm")}>确认修订</button><button className="ghost" onClick={() => advanceRule("publish")}>发布到来源</button><button className="ghost" onClick={() => advanceRule("supersede")}>标记已取代</button><button className="ghost" onClick={proposeRulePatch} disabled={busy}>{busy && <span className="spinner"/>}{busy ? "生成中…" : "按上方指令增量修改"}</button><input value={restoreRef} onChange={(event) => setRestoreRef(event.target.value)} placeholder="规则ID@历史版本..当前基础版本"/><button className="ghost" onClick={restoreRule}>恢复为新修订</button>{rules.map((rule) => <p className="muted" key={`${rule.id}@${rule.version}`}>{rule.id}@{rule.version} · {rule.status} · {rule.scope?.sourceIdentity ?? rule.scope?.kind ?? "legacy"}</p>)}<h3>版本差异</h3><input value={ruleDiffRef} onChange={(event) => setRuleDiffRef(event.target.value)} placeholder="规则ID@1..2"/><button className="ghost" onClick={loadRuleDiff} disabled={!ruleDiffRef.trim()}>比较修订</button>{ruleDiff ? <pre className="diff">{JSON.stringify(ruleDiff, null, 2)}</pre> : null}</section></details>

      {task?.conversation?.length ? <section className="card"><h2>任务对话</h2>{task.conversation.map((item) => <p key={item.id}><b>{item.role === "user" ? "用户" : "智能体"}</b>：{item.content}</p>)}</section> : null}

      {notice && <div className="toast">{notice}</div>}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
