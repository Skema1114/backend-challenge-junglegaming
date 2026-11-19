import { BusinessRejectionError, FailureCode, ValidationDomainError } from "../../shared/domain/errors";
import { Money, MoneyProps } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.entity";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementParams {
  transactionId: string;
  entryId: string;
  money: Money;
  at: Date;
  insufficientFundsCode?: FailureCode;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (!props.playerId.trim()) {
      throw new ValidationDomainError("playerId is required");
    }
    if (props.initialBalance.isNegative()) {
      throw new ValidationDomainError("Initial balance cannot be negative");
    }

    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.money);
    if (!params.money.isPositive()) {
      throw new ValidationDomainError("Debit amount must be positive");
    }

    if (this._balance.isLessThan(params.money)) {
      throw new BusinessRejectionError(
        params.insufficientFundsCode ?? FailureCode.INSUFFICIENT_FUNDS,
        `Insufficient balance in wallet ${this.id}: available ${this._balance.toString()}, required ${params.money.toString()}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(params.money);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = params.at;

    return WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: params.at,
    });
  }

  credit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.money);
    if (!params.money.isPositive()) {
      throw new ValidationDomainError("Credit amount must be positive");
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(params.money);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = params.at;

    return WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: params.at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new BusinessRejectionError(
        FailureCode.CURRENCY_MISMATCH,
        `Currency mismatch for wallet ${this.id}: expected ${this.currency}, got ${money.currency}`,
      );
    }
  }
}
