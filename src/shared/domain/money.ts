import Decimal from "decimal.js";
import { ValidationDomainError } from "./errors";

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface MoneyProps {
  amount: string;
  currency: string;
}

const VALID_CURRENCY_REGEX = /^[A-Z]{3}$/;
const VALID_UNSIGNED_DECIMAL_REGEX = /^\d+(\.\d{1,2})?$/;
const VALID_SIGNED_DECIMAL_REGEX = /^-?\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.validateCurrency(props?.currency);
    if (typeof props?.amount !== "string" || !VALID_UNSIGNED_DECIMAL_REGEX.test(props.amount)) {
      throw new ValidationDomainError(
        `Invalid money amount "${String(props?.amount)}": expected non-negative decimal string with up to 2 decimal places`,
      );
    }

    const decimal = new Decimal(props.amount);
    if (!decimal.isFinite() || decimal.isNaN() || decimal.isNegative()) {
      throw new ValidationDomainError(`Invalid money amount "${props.amount}"`);
    }

    return new Money(decimal.toDecimalPlaces(2), currency);
  }

  /** Used internally for persistence rehydration or signed reconciliation differences. */
  static rehydrate(props: MoneyProps): Money {
    const currency = Money.validateCurrency(props?.currency);
    if (typeof props?.amount !== "string" || !VALID_SIGNED_DECIMAL_REGEX.test(props.amount)) {
      throw new ValidationDomainError(`Invalid persisted money amount "${String(props?.amount)}"`);
    }
    const decimal = new Decimal(props.amount);
    if (!decimal.isFinite() || decimal.isNaN()) {
      throw new ValidationDomainError(`Invalid persisted money amount "${props.amount}"`);
    }
    return new Money(decimal.toDecimalPlaces(2), currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0).toDecimalPlaces(2), Money.validateCurrency(currency));
  }

  private static validateCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !VALID_CURRENCY_REGEX.test(currency)) {
      throw new ValidationDomainError(
        `Invalid currency "${String(currency)}": expected 3-letter uppercase ISO-4217 code`,
      );
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value).toDecimalPlaces(2), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value).toDecimalPlaces(2), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated().toDecimalPlaces(2), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new ValidationDomainError(
        `Currency mismatch: cannot operate ${this.currency} with ${other.currency}`,
        "CURRENCY_MISMATCH",
      );
    }
  }
}
