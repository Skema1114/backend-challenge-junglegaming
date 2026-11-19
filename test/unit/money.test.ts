import { describe, expect, it } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { ValidationDomainError } from "../../src/shared/domain/errors";

describe("Money", () => {
  it("normalizes valid decimal strings to 2 decimal places", () => {
    expect(Money.from({ amount: "25", currency: "BRL" }).toJSON()).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
    expect(Money.from({ amount: "25.5", currency: "BRL" }).toString()).toBe("25.50");
    expect(Money.zero("BRL").toString()).toBe("0.00");
  });

  it("performs exact decimal arithmetic without floating point drift", () => {
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    const sum = a.add(b);

    expect(sum.toString()).toBe("0.30");
    // Immutability check
    expect(a.toString()).toBe("0.10");
    expect(b.toString()).toBe("0.20");
    expect(sum.subtract(a).equals(b)).toBe(true);
    expect(a.negate().isNegative()).toBe(true);
  });

  it("rejects invalid inputs (NaN, Infinity, scientific notation, >2 decimals, negative, bad currency)", () => {
    const invalidAmounts = ["", "NaN", "Infinity", "1e2", "1E-2", "10.123", "-5.00", " 10.00", "abc"];
    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(ValidationDomainError);
    }

    const invalidCurrencies = ["", "brl", "BR", "BRL1", "123"];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(ValidationDomainError);
    }
  });

  it("throws on currency mismatch during operations", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(ValidationDomainError);
    expect(() => brl.subtract(usd)).toThrow(ValidationDomainError);
    expect(() => brl.isLessThan(usd)).toThrow(ValidationDomainError);
    expect(brl.equals(usd)).toBe(false);
  });
});
