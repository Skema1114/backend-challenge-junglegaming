import { FailureCode } from "../../../shared/domain/errors";
import { LedgerDirection } from "../../../domain/wallet/wallet-ledger-entry.entity";
import { WagerTransactionKind, WagerTransactionStatus } from "../../../domain/wagering/wager-transaction.entity";

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status: WagerTransactionStatus;
  failureCode?: FailureCode | null;
  observedBalanceAmount?: string | null;
  observedBalanceCurrency?: string | null;
  pendingAttempts: number;
  nextRetryAt?: Date | null;
  createdAt: Date;
  processedAt?: Date | null;
}

export interface WalletLedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface InboxMessageRecord {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}
