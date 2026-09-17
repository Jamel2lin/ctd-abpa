export function decimalHoursToMinutes(input: unknown): number {
  const value = String(input ?? "").trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error(`非法工时: ${value || "空"}`);
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * scale + BigInt(fraction || "0");
  const minuteNumerator = numerator * 60n;
  if (minuteNumerator % scale !== 0n) throw new Error(`工时不能精确换算为整数分钟: ${value}`);
  const result = Number(minuteNumerator / scale);
  return negative ? -result : result;
}

export function minutesToHoursText(minutes: number): string {
  if (!Number.isSafeInteger(minutes)) throw new Error("分钟必须为安全整数");
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const whole = Math.floor(abs / 60);
  const rem = abs % 60;
  if (!rem) return `${sign}${whole}`;
  const hundredths = Math.round((rem * 100) / 60);
  return `${sign}${whole}.${String(hundredths).padStart(2, "0")}`.replace(/0+$/, "");
}

export function decimalMultiplyToInteger(input: unknown, multiplier: number): number {
  if (!Number.isSafeInteger(multiplier)) throw new Error("乘数必须为安全整数");
  const value = String(input ?? "").trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error(`非法小数: ${value || "空"}`);
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole) * scale + BigInt(fraction || "0")) * BigInt(multiplier);
  if (numerator % scale !== 0n) throw new Error(`数值不能精确换算为整数: ${value} × ${multiplier}`);
  const result = Number(numerator / scale);
  if (!Number.isSafeInteger(result)) throw new Error("整数精度溢出");
  return negative ? -result : result;
}
