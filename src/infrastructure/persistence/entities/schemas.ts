import { EntitySchema } from "@mikro-orm/core";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "./records";

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "Wallet",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    currency: { type: "string", length: 3 },
    balance: { type: "decimal", precision: 19, scale: 2 },
    version: { type: "integer", version: true, default: 1 },
    createdAt: { type: "Date", fieldName: "created_at" },
    updatedAt: { type: "Date", fieldName: "updated_at" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransaction",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id", length: 128 },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id", length: 255 },
    idempotencyKey: { type: "string", fieldName: "idempotency_key", length: 255 },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    roundId: { type: "string", fieldName: "round_id", length: 255 },
    gameId: { type: "string", fieldName: "game_id", length: 255 },
    kind: { type: "string", length: 32 },
    amount: { type: "decimal", precision: 19, scale: 2 },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      length: 255,
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    status: { type: "string", length: 32 },
    failureCode: { type: "string", fieldName: "failure_code", length: 64, nullable: true },
    observedBalanceAmount: {
      type: "decimal",
      fieldName: "observed_balance_amount",
      precision: 19,
      scale: 2,
      nullable: true,
    },
    observedBalanceCurrency: {
      type: "string",
      fieldName: "observed_balance_currency",
      length: 3,
      nullable: true,
    },
    pendingAttempts: { type: "integer", fieldName: "pending_attempts", default: 0 },
    nextRetryAt: { type: "Date", fieldName: "next_retry_at", nullable: true },
    createdAt: { type: "Date", fieldName: "created_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  name: "WalletLedgerEntry",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string", length: 16 },
    amount: { type: "decimal", precision: 19, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "decimal", fieldName: "balance_before", precision: 19, scale: 2 },
    balanceAfter: { type: "decimal", fieldName: "balance_after", precision: 19, scale: 2 },
    createdAt: { type: "Date", fieldName: "created_at" },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: "InboxMessage",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", fieldName: "consumer_name", length: 128, primary: true },
    messageId: { type: "string", fieldName: "message_id", length: 255, primary: true },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    receivedAt: { type: "Date", fieldName: "received_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessage",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id", length: 128 },
    eventType: { type: "string", fieldName: "event_type", length: 128 },
    payload: { type: "json" },
    occurredAt: { type: "Date", fieldName: "occurred_at" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { type: "Date", fieldName: "next_attempt_at", nullable: true },
    publishedAt: { type: "Date", fieldName: "published_at", nullable: true },
  },
});

export const ALL_ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
