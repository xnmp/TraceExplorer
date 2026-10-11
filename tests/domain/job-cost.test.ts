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
  it("rounds arbitrarily large decimals without losing precision", () => {
    expect(formatJobCost(cost("999999999999999999999999.995"))).toBe("US$1000000000000000000000000.00");
  });
  it("omits missing and malformed costs", () => {
    expect(formatJobCost(undefined)).toBe("");
    expect(formatJobCost(null)).toBe("");
    for (const amount of ["", "-1", "NaN", "1e3", "1.", "0.1234567"]) expect(formatJobCost(cost(amount))).toBe("");
    expect(formatJobCost(cost("1", false, "bad"))).toBe("");
  });
});
