import type { JobCost } from "../../../integration/plugin-sdk";

/** Decimal arithmetic keeps rounding exact, including amounts beyond Number's range. */
export function formatJobCost(cost: JobCost | null | undefined): string {
  if (!cost || typeof cost.amount !== "string" || typeof cost.currency !== "string" || typeof cost.estimated !== "boolean" || !/^\d+(?:\.\d{1,6})?$/.test(cost.amount) || !/^[A-Z]{3}$/.test(cost.currency)) return "";
  const [whole, fraction = ""] = cost.amount.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const prefix = cost.estimated === true ? "≈" : "";
  const currency = cost.currency === "USD" ? "US$" : `${cost.currency} `;
  if (cost.currency === "USD" && micros > 0n && micros < 10_000n) return `${prefix}<${currency}0.01`;
  const cents = (micros + 5_000n) / 10_000n;
  return `${prefix}${currency}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
