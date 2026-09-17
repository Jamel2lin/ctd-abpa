export function allocateAnnualLeave(requestedMinutes: number, remainingMinutes: number): { annualMinutes: number; personalMinutes: number; remainingMinutes: number } {
  if (![requestedMinutes, remainingMinutes].every(Number.isSafeInteger) || requestedMinutes < 0 || remainingMinutes < 0) throw new Error("抵扣分钟必须为非负安全整数");
  const annualMinutes = Math.min(requestedMinutes, remainingMinutes);
  return { annualMinutes, personalMinutes: requestedMinutes - annualMinutes, remainingMinutes: remainingMinutes - annualMinutes };
}
