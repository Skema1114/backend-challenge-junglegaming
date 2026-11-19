import { describe, expect, it } from "bun:test";
import { hashCanonicalPayload } from "../../src/shared/domain/canonical-json";
import {
  BusinessRejectionError,
  FailureCode,
  InvalidTransactionStateError,
  ValidationDomainError,
} from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { Wallet } from "../../src/domain/wallet/wallet.entity";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/domain/wallet/wallet-ledger-entry.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction.entity";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../src/domain/messaging/integration-event";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message.entity";

describe("Domain entities & canonical hashing", () => {
  it("produces identical SHA-256 hashes regardless of key ordering", () => {
    const h1 = hashCanonicalPayload({
      a: 1,
      nested: { x: "foo", y: "bar" },
      b: "25.00",
    });
    const h2 = hashCanonicalPayload({
      b: "25.00",
      nested: { y: "bar", x: "foo" },
      a: 1,
    });
    expect(h1).toBe(h2);
  });

  it("enforces Wallet invariants and increments version only when balance changes", () => {
    const wallet = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    expect(wallet.version).toBe(1);

    const debitEntry = wallet.debit({
      transactionId: "tx-1",
      entryId: "e-1",
      money: Money.from({ amount: "40.00", currency: "BRL" }),
      at: new Date(),
    });
    expect(wallet.balance.toString()).toBe("60.00");
    expect(wallet.version).toBe(2);
    expect(debitEntry.isBalanced()).toBe(true);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);

    expect(() =>
      wallet.debit({
        transactionId: "tx-2",
        entryId: "e-2",
        money: Money.from({ amount: "80.00", currency: "BRL" }),
        at: new Date(),
      }),
    ).toThrow(BusinessRejectionError);
    expect(wallet.version).toBe(2);

    const creditEntry = wallet.credit({
      transactionId: "tx-3",
      entryId: "e-3",
      money: Money.from({ amount: "15.00", currency: "BRL" }),
      at: new Date(),
    });
    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(3);
    expect(creditEntry.isBalanced()).toBe(true);
  });

  it("validates ledger entry arithmetic on creation", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e-bad",
        walletId: "w-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "50.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "45.00", currency: "BRL" }),
        createdAt: new Date(),
      }),
    ).toThrow(ValidationDomainError);
  });

  it("enforces WagerTransaction creation rules and terminal state immutability", () => {
    expect(() =>
      WagerTransaction.create({
        id: "tx-open",
        providerId: "prov",
        externalTransactionId: "ext-1",
        idempotencyKey: "k-1",
        payloadHash: "h-1",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Opening,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
      }),
    ).toThrow(ValidationDomainError);

    expect(() =>
      WagerTransaction.create({
        id: "tx-ref",
        providerId: "prov",
        externalTransactionId: "ext-2",
        idempotencyKey: "k-2",
        payloadHash: "h-2",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
      }),
    ).toThrow(ValidationDomainError);

    const bet = WagerTransaction.create({
      id: "tx-bet",
      providerId: "prov",
      externalTransactionId: "ext-bet",
      idempotencyKey: "k-bet",
      payloadHash: "h-bet",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "20.00", currency: "BRL" }),
    });
    expect(bet.status).toBe(WagerTransactionStatus.Pending);

    bet.markProcessed(undefined, new Date(), Money.from({ amount: "80.00", currency: "BRL" }));
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);

    const win = WagerTransaction.create({
      id: "tx-win",
      providerId: "prov",
      externalTransactionId: "ext-win",
      idempotencyKey: "k-win",
      payloadHash: "h-win",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
    });
    const rollbackOfWin = WagerTransaction.create({
      id: "tx-rb",
      providerId: "prov",
      externalTransactionId: "ext-rb",
      idempotencyKey: "k-rb",
      payloadHash: "h-rb",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-win",
    });
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollbackOfWin.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it("serializes IntegrationEvent subclasses and schedules OutboxMessage backoff", () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const wallet = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      now,
    });
    const entry = wallet.debit({
      transactionId: "tx-1",
      entryId: "e-1",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      at: now,
    });
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "prov",
      externalTransactionId: "ext-1",
      idempotencyKey: "k-1",
      payloadHash: "h-1",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      createdAt: now,
    });
    tx.markProcessed(undefined, now, wallet.balance);

    const processedEvent = WagerTransactionProcessed.from(tx, {
      eventId: "ev-1",
      correlationId: "corr-1",
      occurredAt: now,
    });
    const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
      eventId: "ev-2",
      correlationId: "corr-1",
      occurredAt: now,
    });

    expect(processedEvent.toJSON().eventType).toBe("WagerTransactionProcessed");
    expect(balanceEvent.toJSON().data.balanceAfter).toEqual({ amount: "40.00", currency: "BRL" });

    const outbox = OutboxMessage.enqueue(balanceEvent);
    expect(outbox.isPending()).toBe(true);
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    outbox.markPublished(new Date(now.getTime() + 1000));
    expect(outbox.isPending()).toBe(false);
  });
});
