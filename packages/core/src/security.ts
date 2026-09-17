export function safeSpreadsheetText(value: unknown): string {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function employeeId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("工号为空");
  return safeSpreadsheetText(text);
}

export function redactInstruction(instruction: string, privateTerms: string[] = []): { text: string; redact<T>(value: T): T; restore<T>(value: T): T; references: number } {
  const terms = new Set(privateTerms.filter((value) => value.length >= 2 && instruction.includes(value)));
  for (const match of instruction.matchAll(/(?:姓名|工号|员工编号|人员编号|职工号)\s*(?:为|是|:|：)\s*([\u4e00-\u9fff]{2,3}|[A-Za-z0-9_-]{3,})/g)) terms.add(match[1]);
  const replacements = new Map<string, string>();
  let text = instruction;
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const reference = `@PRIVATE_${replacements.size + 1}@`;
    replacements.set(reference, term);
    text = text.split(term).join(reference);
  }
  const redact = <T>(value: T): T => {
    if (typeof value === "string") {
      let result: string = value;
      for (const [reference, term] of replacements) result = result.split(term).join(reference);
      return result as T;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
    return value;
  };
  const restore = <T>(value: T): T => {
    if (typeof value === "string") {
      let result: string = value;
      for (const [reference, term] of replacements) result = result.split(reference).join(term);
      return result as T;
    }
    if (Array.isArray(value)) return value.map((item) => restore(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)])) as T;
    return value;
  };
  return { text, redact, restore, references: replacements.size };
}
