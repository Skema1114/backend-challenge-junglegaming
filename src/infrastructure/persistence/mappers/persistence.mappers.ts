import { WagerTransaction } from "../../../domain/wagering/wager-transaction.entity";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.entity";
import { Wallet } from "../../../domain/wallet/wallet.entity";
import { InboxMessage } from "../../../domain/messaging/inbox-message.entity";
import { OutboxMessage } from "../../../domain/messaging/outbox-message.entity";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "../entities/records";

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: { amount: String(r.balance), currency: r.currency },
    version: r.version,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function ledgerEntryToDomain(r: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction,
    money: { amount: String(r.amount), currency: r.currency },
    balanceBefore: { amount: String(r.balanceBefore), currency: r.currency },
    balanceAfter: { amount: String(r.balanceAfter), currency: r.currency },
    createdAt: new Date(r.createdAt),
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): WalletLedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    createdAt: e.createdAt,
  };
}

export function wagerTxToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind,
    money: { amount: String(r.amount), currency: r.currency },
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: new Date(r.createdAt),
    status: r.status,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: r.failureCode ?? undefined,
    processedAt: r.processedAt ? new Date(r.processedAt) : undefined,
    observedBalance:
      r.observedBalanceAmount != null && r.observedBalanceCurrency
        ? { amount: String(r.observedBalanceAmount), currency: r.observedBalanceCurrency }
        : undefined,
    pendingAttempts: r.pendingAttempts,
    nextRetryAt: r.nextRetryAt ? new Date(r.nextRetryAt) : undefined,
  });
}

export function wagerTxToRecord(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    observedBalanceAmount: tx.observedBalance ? tx.observedBalance.toString() : null,
    observedBalanceCurrency: tx.observedBalance ? tx.observedBalance.currency : null,
    pendingAttempts: tx.pendingAttempts,
    nextRetryAt: tx.nextRetryAt ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
  };
}

export function inboxToDomain(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: new Date(r.receivedAt),
    processedAt: r.processedAt ? new Date(r.processedAt) : undefined,
  });
}

export function outboxToDomain(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: new Date(r.occurredAt),
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt) : undefined,
    publishedAt: r.publishedAt ? new Date(r.publishedAt) : undefined,
  });
}
