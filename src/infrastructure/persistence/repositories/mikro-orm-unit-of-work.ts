import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import {
  LedgerCursorPage,
  LedgerReconciliationStats,
  TransactionalRepositories,
  UnitOfWorkPort,
} from "../../../application/ports/unit-of-work.port";
import { InboxMessage } from "../../../domain/messaging/inbox-message.entity";
import { OutboxMessage } from "../../../domain/messaging/outbox-message.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction.entity";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.entity";
import { Wallet } from "../../../domain/wallet/wallet.entity";
import {
  ConflictDomainError,
  TransientInfrastructureError,
  ValidationDomainError,
} from "../../../shared/domain/errors";
import { MetricsService } from "../../../shared/observability/metrics.service";
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from "../entities/schemas";
import {
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
} from "../entities/records";
import {
  inboxToDomain,
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToDomain,
  wagerTxToDomain,
  wagerTxToRecord,
  walletToDomain,
  walletToRecord,
} from "../mappers/persistence.mappers";

interface CursorToken {
  createdAt: string;
  id: string;
}

export function extractPgCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string") return e.code;
  if (e.driverException && typeof e.driverException === "object") {
    const code = (e.driverException as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  if (e.cause && typeof e.cause === "object") {
    const code = (e.cause as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function extractPgConstraint(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.constraint === "string") return e.constraint;
  if (e.driverException && typeof e.driverException === "object") {
    const c = (e.driverException as Record<string, unknown>).constraint;
    if (typeof c === "string") return c;
  }
  if (e.cause && typeof e.cause === "object") {
    const c = (e.cause as Record<string, unknown>).constraint;
    if (typeof c === "string") return c;
  }
  return undefined;
}

class MikroOrmRepositories implements TransactionalRepositories {
  constructor(private readonly em: EntityManager) {}

  async findWalletByIdForUpdate(walletId: string): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? walletToDomain(row) : null;
  }

  async findWalletById(walletId: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { id: walletId });
    return row ? walletToDomain(row) : null;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    const record = walletToRecord(wallet);
    await this.em.insert(WalletSchema, record);
  }

  async updateWallet(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected === 0) {
      throw new ConflictDomainError(
        `Optimistic concurrency conflict updating wallet ${wallet.id}`,
        "WALLET_VERSION_CONFLICT",
      );
    }
  }

  async findWagerByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, { idempotencyKey });
    return row ? wagerTxToDomain(row) : null;
  }

  async findWagerByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return row ? wagerTxToDomain(row) : null;
  }

  async findWagerById(transactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, { id: transactionId });
    return row ? wagerTxToDomain(row) : null;
  }

  async existsProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insertWagerTransaction(tx: WagerTransaction): Promise<void> {
    const record = wagerTxToRecord(tx);
    await this.em.insert(WagerTransactionSchema, record);
  }

  async updateWagerTransaction(tx: WagerTransaction): Promise<void> {
    const record = wagerTxToRecord(tx);
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        observedBalanceAmount: record.observedBalanceAmount,
        observedBalanceCurrency: record.observedBalanceCurrency,
        pendingAttempts: record.pendingAttempts,
        nextRetryAt: record.nextRetryAt,
        processedAt: record.processedAt,
      },
    );
  }

  async findDuePendingReferenceTransactions(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.em.getConnection().execute<WagerTransactionRecord[]>(
      `SELECT
         id,
         provider_id AS "providerId",
         external_transaction_id AS "externalTransactionId",
         idempotency_key AS "idempotencyKey",
         payload_hash AS "payloadHash",
         wallet_id AS "walletId",
         player_id AS "playerId",
         round_id AS "roundId",
         game_id AS "gameId",
         kind,
         amount::text AS amount,
         currency,
         reference_external_transaction_id AS "referenceExternalTransactionId",
         reference_transaction_id AS "referenceTransactionId",
         status,
         failure_code AS "failureCode",
         observed_balance_amount::text AS "observedBalanceAmount",
         observed_balance_currency AS "observedBalanceCurrency",
         pending_attempts AS "pendingAttempts",
         next_retry_at AS "nextRetryAt",
         created_at AS "createdAt",
         processed_at AS "processedAt"
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [now.toISOString(), limit],
    );
    return rows.map(wagerTxToDomain);
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntrySchema, ledgerEntryToRecord(entry));
  }

  async findLedgerPage(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerCursorPage> {
    let decoded: CursorToken | null = null;
    if (cursor) {
      try {
        const raw = Buffer.from(cursor, "base64url").toString("utf8");
        const parsed = JSON.parse(raw) as CursorToken;
        if (!parsed.createdAt || !parsed.id) {
          throw new Error("missing fields");
        }
        decoded = parsed;
      } catch {
        throw new ValidationDomainError("Invalid ledger pagination cursor");
      }
    }

    const params: unknown[] = [walletId];
    let cursorClause = "";
    if (decoded) {
      cursorClause = "AND (created_at, id) > (?::timestamptz, ?::uuid)";
      params.push(decoded.createdAt, decoded.id);
    }
    params.push(limit + 1);

    const rows = await this.em.getConnection().execute<WalletLedgerEntryRecord[]>(
      `SELECT
         id,
         wallet_id AS "walletId",
         transaction_id AS "transactionId",
         direction,
         amount::text AS amount,
         currency,
         balance_before::text AS "balanceBefore",
         balance_after::text AS "balanceAfter",
         created_at AS "createdAt"
       FROM wallet_ledger_entries
       WHERE wallet_id = ?
         ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: new Date(last.createdAt).toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null;

    return {
      entries: sliced.map(ledgerEntryToDomain),
      nextCursor,
    };
  }

  async sumLedgerForWallet(walletId: string): Promise<LedgerReconciliationStats> {
    const rows = await this.em.getConnection().execute<Array<{ sum: string; cnt: string }>>(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS sum,
         COUNT(*)::text AS cnt
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );
    const first = rows[0];
    return {
      calculatedAmount: first?.sum ?? "0.00",
      checkedEntries: Number(first?.cnt ?? 0),
    };
  }

  async findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxMessageSchema, { consumerName, messageId });
    return row ? inboxToDomain(row) : null;
  }

  async insertInboxMessage(msg: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageSchema, {
      consumerName: msg.consumerName,
      messageId: msg.messageId,
      payloadHash: msg.payloadHash,
      receivedAt: msg.receivedAt,
      processedAt: msg.processedAt ?? null,
    });
  }

  async markInboxProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName, messageId },
      { processedAt: at },
    );
  }

  async insertOutboxMessages(messages: OutboxMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.em.insert(OutboxMessageSchema, {
        id: msg.id,
        aggregateId: msg.aggregateId,
        eventType: msg.eventType,
        payload: msg.payload as Record<string, unknown>,
        occurredAt: msg.occurredAt,
        attempts: msg.attempts,
        nextAttemptAt: msg.nextAttemptAt ?? null,
        publishedAt: msg.publishedAt ?? null,
      });
    }
  }

  async acquireDueOutboxBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.getConnection().execute<OutboxMessageRecord[]>(
      `SELECT
         id,
         aggregate_id AS "aggregateId",
         event_type AS "eventType",
         payload,
         occurred_at AS "occurredAt",
         attempts,
         next_attempt_at AS "nextAttemptAt",
         published_at AS "publishedAt"
       FROM outbox_messages
       WHERE published_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY occurred_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit],
    );
    return rows.map(outboxToDomain);
  }

  async updateOutboxMessage(msg: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: msg.id },
      {
        attempts: msg.attempts,
        nextAttemptAt: msg.nextAttemptAt ?? null,
        publishedAt: msg.publishedAt ?? null,
      },
    );
  }

  async getOutboxStats(now: Date): Promise<{ pendingCount: number; maxLagMs: number }> {
    const rows = await this.em.getConnection().execute<Array<{ cnt: string; oldest: Date | null }>>(
      `SELECT
         COUNT(*)::text AS cnt,
         MIN(occurred_at) AS oldest
       FROM outbox_messages
       WHERE published_at IS NULL`,
    );
    const first = rows[0];
    const pendingCount = Number(first?.cnt ?? 0);
    const oldest = first?.oldest ? new Date(first.oldest).getTime() : null;
    const maxLagMs = oldest !== null ? Math.max(0, now.getTime() - oldest) : 0;
    return { pendingCount, maxLagMs };
  }
}

const TRANSIENT_PG_CODES = new Set(["08000", "08001", "08006", "57P01", "57P02", "57P03", "53300"]);
const LOCK_RETRY_PG_CODES = new Set(["40001", "40P01"]);

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async runInTransaction<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    const forked = this.em.fork();
    try {
      return await forked.transactional(async (txEm) => {
        return fn(new MikroOrmRepositories(txEm));
      });
    } catch (err) {
      const code = extractPgCode(err);
      if (code && LOCK_RETRY_PG_CODES.has(code)) {
        this.metrics.incLockConflict();
        throw new TransientInfrastructureError(`Database lock/serialization conflict (${code})`, err);
      }
      if (code && TRANSIENT_PG_CODES.has(code)) {
        throw new TransientInfrastructureError(`Transient database error (${code})`, err);
      }
      throw err;
    }
  }

  readOnly(): TransactionalRepositories {
    return new MikroOrmRepositories(this.em.fork());
  }

  async ping(): Promise<boolean> {
    try {
      await this.em.getConnection().execute("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
