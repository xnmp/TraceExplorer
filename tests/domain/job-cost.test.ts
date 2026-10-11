import { describe, it, expect } from "vitest";
import { formatJobCost } from "../../src/lib/domain/job-cost";
const cost = (amount: string, estimated = false, currency = "USD") => ({ amount, estimated, currency, source: "fixture" });
describe("job cost display", () => {
  it("formats actual charges, estimates, zero and small positive amounts", () => {
    expect(formatJobCost(cost("0.08"))).toBe("US$0.08");
    expect(formatJobCost(cost("0.04", true))).toBe("≈US$0.04");
    expect(formatJobCost(cost("0.009999"))).toBe("<US$0.01");
    expect(formatJobCost(cost("0.000001", true))).toBe("≈<US$0.01");
    expect(formatJobCost(cost("0"))).toBe("US$0.00");
    expect(formatJobCost(cost("0.010000"))).toBe("US$0.01");
    expect(formatJobCost(cost("0.075"))).toBe("US$0.08");
    expect(formatJobCost(cost("1.995", false, "EUR"))).toBe("EUR 2.00");
  });
  it.each([
    ["0", false, "USD", "US$0.00"],
    ["0.004", false, "USD", "<US$0.01"],
    ["0.005", false, "USD", "<US$0.01"],
    ["0.0049", true, "USD", "≈<US$0.01"],
    ["12.345678", false, "USD", "US$12.35"],
    ["0.004", false, "EUR", "EUR 0.00"],
    ["0.005", false, "EUR", "EUR 0.01"],
    ["0.0049", true, "EUR", "≈EUR 0.00"],
    ["12.345678", false, "EUR", "EUR 12.35"],
  ])("formats %s (estimated=%s, %s) as %s", (amount, estimated, currency, expected) => {
    expect(formatJobCost(cost(amount, estimated, currency))).toBe(expected);
  });
  it.each(["true", "false", 0, 1, null, undefined])("omits a non-boolean estimated value: %s", (estimated) => {
    expect(formatJobCost({ ...cost("0.08"), estimated } as unknown as Parameters<typeof formatJobCost>[0])).toBe("");
  });
  it("rounds arbitrarily large decimals without losing precision", () => {
    expect(formatJobCost(cost("999999999999999999999999.995"))).toBe("US$1000000000000000000000000.00");
  });
  it("omits missing and malformed costs", () => {
    expect(formatJobCost(undefined)).toBe("");
    expect(formatJobCost(null)).toBe("");
    for (const amount of ["", "-1", "NaN", "abc", "1e3", "1.", "0.1234567"]) expect(formatJobCost(cost(amount))).toBe("");
    expect(formatJobCost(cost("1", false, "bad"))).toBe("");
  });
});
