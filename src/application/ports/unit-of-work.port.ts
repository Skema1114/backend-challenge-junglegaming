import { InboxMessage } from "../../domain/messaging/inbox-message.entity";
import { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wagering/wager-transaction.entity";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry.entity";
import { Wallet } from "../../domain/wallet/wallet.entity";

export interface LedgerCursorPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface LedgerReconciliationStats {
  calculatedAmount: string;
  checkedEntries: number;
}

export interface TransactionalRepositories {
  findWalletByIdForUpdate(walletId: string): Promise<Wallet | null>;
  findWalletById(walletId: string): Promise<Wallet | null>;
  insertWallet(wallet: Wallet): Promise<void>;
  updateWallet(wallet: Wallet, expectedVersion: number): Promise<void>;

  findWagerByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findWagerByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findWagerById(transactionId: string): Promise<WagerTransaction | null>;
  existsProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
  insertWagerTransaction(tx: WagerTransaction): Promise<void>;
  updateWagerTransaction(tx: WagerTransaction): Promise<void>;
  findDuePendingReferenceTransactions(now: Date, limit: number): Promise<WagerTransaction[]>;

  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  findLedgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerCursorPage>;
  sumLedgerForWallet(walletId: string): Promise<LedgerReconciliationStats>;

  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insertInboxMessage(msg: InboxMessage): Promise<void>;
  markInboxProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;

  insertOutboxMessages(messages: OutboxMessage[]): Promise<void>;
  acquireDueOutboxBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  updateOutboxMessage(msg: OutboxMessage): Promise<void>;
  getOutboxStats(now: Date): Promise<{ pendingCount: number; maxLagMs: number }>;
}

export interface UnitOfWorkPort {
  runInTransaction<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
  readOnly(): TransactionalRepositories;
  ping(): Promise<boolean>;
}

export const UNIT_OF_WORK_PORT = Symbol("UNIT_OF_WORK_PORT");
