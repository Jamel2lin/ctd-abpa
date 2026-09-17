const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDate(y: number, m: number, d: number): boolean {
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const limit = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1];
  return y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= limit;
}

export function parseLocalDate(input: unknown): { year: number; month: number; day: number; iso: string } {
  if (typeof input === "number" && Number.isInteger(input) && input > 0 && input < 2_958_466) {
    // Excel's 1900 date system includes a fictitious 1900-02-29 at serial 60.
    if (input === 60) throw new Error("非法 Excel 日期序列: 60");
    const adjusted = input > 60 ? input - 1 : input;
    const date = new Date(Date.UTC(1899, 11, 31 + adjusted));
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    return { year, month, day, iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
  }
  const value = String(input ?? "").trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (match) [, y, m, d] = match.map(Number) as [number, number, number, number];
  else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
    if (!match) throw new Error(`非法日期: ${value || "空"}`);
    m = Number(match[1]); d = Number(match[2]); y = Number(match[3]);
    if (y < 100) y += 2000;
  }
  if (!validDate(y, m, d)) throw new Error(`非法日期: ${value}`);
  return { year: y, month: m, day: d, iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

export function parseLocalTime(input: unknown): string {
  const value = String(input ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`非法时间: ${value || "空"}`);
  const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`非法时间: ${value}`);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function combineLocalDateTime(date: unknown, time: unknown): string {
  return `${parseLocalDate(date).iso} ${parseLocalTime(time)}`;
}

export function compareLocalDateTime(a: string, b: string): number { return a.localeCompare(b); }
