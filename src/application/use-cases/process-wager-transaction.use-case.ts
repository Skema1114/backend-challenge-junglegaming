import { Inject, Injectable } from "@nestjs/common";
import { type TransactionalRepositories, UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port";
import {
  BusinessRejectionError,
  ConflictDomainError,
  FailureCode,
  NotFoundDomainError,
} from "../../shared/domain/errors";
import { Money, MoneyProps } from "../../shared/domain/money";
import { hashCanonicalPayload } from "../../shared/domain/canonical-json";
import { newUuid } from "../../shared/domain/id";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction.entity";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry.entity";
import { Wallet } from "../../domain/wallet/wallet.entity";
import { InboxMessage } from "../../domain/messaging/inbox-message.entity";
import { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-event";
import { MetricsService } from "../../shared/observability/metrics.service";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";

export interface InboxContext {
  consumerName: string;
  messageId: string;
  receivedAt?: Date;
}

export interface ProcessWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: InboxContext;
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionOutput> {
    const startMs = performance.now();
    const money = Money.from(input.money);
    const correlationId = input.correlationId ?? newUuid();
    const now = new Date();

    const businessPayload = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    };
    const payloadHash = hashCanonicalPayload(businessPayload);

    // Pre-validate domain creation rules before opening DB transaction
    const draftTx = WagerTransaction.create({
      id: newUuid(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });

    const result = await this.uow.runInTransaction(async (repos) => {
      const wallet = await repos.findWalletByIdForUpdate(input.walletId);
      if (!wallet) {
        throw new NotFoundDomainError(
          `Wallet ${input.walletId} not found`,
          FailureCode.WALLET_NOT_FOUND,
        );
      }

      if (input.inboxContext) {
        const existingInbox = await repos.findInboxMessage(
          input.inboxContext.consumerName,
          input.inboxContext.messageId,
        );
        if (existingInbox?.isProcessed()) {
          this.metrics.incDuplicate();
          const existingTx =
            (await repos.findWagerByIdempotencyKey(input.idempotencyKey)) ??
            (await repos.findWagerByProviderExternalId(
              input.providerId,
              input.externalTransactionId,
            ));
          if (existingTx) {
            return this.buildReplayOutput(existingTx, wallet);
          }
          return {
            transactionId: draftTx.id,
            status: WagerTransactionStatus.Processed,
            balance: wallet.balance.toJSON(),
            idempotentReplay: true,
          };
        }

        if (!existingInbox) {
          await repos.insertInboxMessage(
            InboxMessage.receive({
              messageId: input.inboxContext.messageId,
              consumerName: input.inboxContext.consumerName,
              payloadHash,
              receivedAt: input.inboxContext.receivedAt ?? now,
            }),
          );
        }
      }

      const existingByKey = await repos.findWagerByIdempotencyKey(input.idempotencyKey);
      if (existingByKey) {
        if (!existingByKey.matchesPayload(payloadHash)) {
          throw new ConflictDomainError(
            `Idempotency-Key "${input.idempotencyKey}" already used with a different payload`,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        this.metrics.incDuplicate();
        if (input.inboxContext) {
          await repos.markInboxProcessed(
            input.inboxContext.consumerName,
            input.inboxContext.messageId,
            now,
          );
        }
        return this.buildReplayOutput(existingByKey, wallet);
      }

      const existingByExternal = await repos.findWagerByProviderExternalId(
        input.providerId,
        input.externalTransactionId,
      );
      if (existingByExternal) {
        if (!existingByExternal.matchesPayload(payloadHash)) {
          throw new ConflictDomainError(
            `External transaction "${input.providerId}:${input.externalTransactionId}" already exists with a different payload`,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        this.metrics.incDuplicate();
        if (input.inboxContext) {
          await repos.markInboxProcessed(
            input.inboxContext.consumerName,
            input.inboxContext.messageId,
            now,
          );
        }
        return this.buildReplayOutput(existingByExternal, wallet);
      }

      const output = await this.evaluateAndPersist(
        repos,
        wallet,
        draftTx,
        true,
        false,
        correlationId,
        now,
      );

      if (input.inboxContext) {
        await repos.markInboxProcessed(
          input.inboxContext.consumerName,
          input.inboxContext.messageId,
          now,
        );
      }

      return output;
    });

    const elapsedMs = performance.now() - startMs;
    this.metrics.observeLatency(elapsedMs);
    if (!result.idempotentReplay) {
      this.metrics.incTransactionStatus(result.status);
    }

    this.logger.info("wager.transaction.handled", {
      correlationId,
      messageId: input.inboxContext?.messageId,
      transactionId: result.transactionId,
      walletId: input.walletId,
      providerId: input.providerId,
      kind: input.kind,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
      failureCode: result.failureCode,
      durationMs: Number(elapsedMs.toFixed(2)),
    });

    return result;
  }

  async reprocessPendingReference(
    transactionId: string,
    maxAttempts: number,
  ): Promise<{ resolved: boolean; status?: WagerTransactionStatus }> {
    const readTx = await this.uow.readOnly().findWagerById(transactionId);
    if (!readTx || readTx.status !== WagerTransactionStatus.PendingReference) {
      return { resolved: false };
    }

    const now = new Date();
    const correlationId = newUuid();

    return this.uow.runInTransaction(async (repos) => {
      const wallet = await repos.findWalletByIdForUpdate(readTx.walletId);
      if (!wallet) {
        return { resolved: false };
      }

      const tx = await repos.findWagerById(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
        return { resolved: false };
      }

      const isFinalAttempt = tx.pendingAttempts >= maxAttempts;
      const out = await this.evaluateAndPersist(
        repos,
        wallet,
        tx,
        false,
        isFinalAttempt,
        correlationId,
        now,
      );

      if (out.status !== WagerTransactionStatus.PendingReference) {
        this.metrics.incTransactionStatus(out.status);
      } else {
        this.metrics.incRetry();
      }

      this.logger.info("wager.pending_reference.reprocessed", {
        correlationId,
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        status: out.status,
        failureCode: out.failureCode,
        attempts: tx.pendingAttempts,
      });

      return {
        resolved: out.status !== WagerTransactionStatus.PendingReference,
        status: out.status,
      };
    });
  }

  private buildReplayOutput(
    tx: WagerTransaction,
    wallet: Wallet,
  ): ProcessWagerTransactionOutput {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: (tx.observedBalance ?? wallet.balance).toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: true,
    };
  }

  private async evaluateAndPersist(
    repos: TransactionalRepositories,
    wallet: Wallet,
    tx: WagerTransaction,
    isNewInsert: boolean,
    isFinalPendingAttempt: boolean,
    correlationId: string,
    now: Date,
  ): Promise<ProcessWagerTransactionOutput> {
    const outboxMessages: OutboxMessage[] = [];
    const baseCtx = {
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    };

    const persistTx = async () => {
      if (isNewInsert) {
        await repos.insertWagerTransaction(tx);
      } else {
        await repos.updateWagerTransaction(tx);
      }
    };

    const rejectWith = async (code: FailureCode): Promise<ProcessWagerTransactionOutput> => {
      tx.reject(code, now, wallet.balance);
      await persistTx();
      outboxMessages.push(
        OutboxMessage.enqueue(
          WagerTransactionRejected.from(tx, code, { ...baseCtx, eventId: newUuid() }),
        ),
      );
      await repos.insertOutboxMessages(outboxMessages);
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        failureCode: code,
        idempotentReplay: false,
      };
    };

    if (tx.playerId !== wallet.playerId) {
      return rejectWith(FailureCode.PLAYER_MISMATCH);
    }
    if (tx.money.currency !== wallet.currency) {
      return rejectWith(FailureCode.CURRENCY_MISMATCH);
    }

    if (tx.kind === WagerTransactionKind.Loss) {
      tx.markProcessed(undefined, now, wallet.balance);
      await persistTx();
      outboxMessages.push(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(tx, { ...baseCtx, eventId: newUuid() }),
        ),
      );
      await repos.insertOutboxMessages(outboxMessages);
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    if (tx.kind === WagerTransactionKind.Bet) {
      const expectedVersion = wallet.version;
      let entry: WalletLedgerEntry;
      try {
        entry = wallet.debit({
          transactionId: tx.id,
          entryId: newUuid(),
          money: tx.money,
          at: now,
          insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
        });
      } catch (err) {
        if (err instanceof BusinessRejectionError) {
          return rejectWith(err.failureCode);
        }
        throw err;
      }

      tx.markProcessed(undefined, now, wallet.balance);
      await persistTx();
      await repos.updateWallet(wallet, expectedVersion);
      await repos.insertLedgerEntry(entry);

      outboxMessages.push(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(tx, { ...baseCtx, eventId: newUuid() }),
        ),
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, { ...baseCtx, eventId: newUuid() }),
        ),
      );
      await repos.insertOutboxMessages(outboxMessages);

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    // WIN, REFUND, ROLLBACK
    let referenceTx: WagerTransaction | undefined;

    if (tx.kind === WagerTransactionKind.Win) {
      if (tx.referenceExternalTransactionId) {
        const ref = await repos.findWagerByProviderExternalId(
          tx.providerId,
          tx.referenceExternalTransactionId,
        );
        if (
          !ref ||
          ref.status === WagerTransactionStatus.Pending ||
          ref.status === WagerTransactionStatus.PendingReference
        ) {
          if (isFinalPendingAttempt) {
            return rejectWith(FailureCode.REFERENCE_NOT_FOUND);
          }
          const wasPending = tx.status === WagerTransactionStatus.PendingReference;
          const nextRetryAt = new Date(
            now.getTime() + Math.min(30_000, 500 * 2 ** Math.min(tx.pendingAttempts, 6)),
          );
          tx.markPendingReference(nextRetryAt);
          await persistTx();
          if (!wasPending) {
            outboxMessages.push(
              OutboxMessage.enqueue(
                WagerTransactionPendingReference.from(tx, { ...baseCtx, eventId: newUuid() }),
              ),
            );
            await repos.insertOutboxMessages(outboxMessages);
          }
          return {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }

        if (ref.status !== WagerTransactionStatus.Processed) {
          return rejectWith(FailureCode.REFERENCE_NOT_PROCESSED);
        }
        if (ref.kind !== WagerTransactionKind.Bet) {
          return rejectWith(FailureCode.INVALID_REFERENCE_KIND);
        }
        if (ref.walletId !== tx.walletId) return rejectWith(FailureCode.WALLET_MISMATCH);
        if (ref.playerId !== tx.playerId) return rejectWith(FailureCode.PLAYER_MISMATCH);
        if (ref.money.currency !== tx.money.currency) return rejectWith(FailureCode.CURRENCY_MISMATCH);
        if (ref.roundId !== tx.roundId) return rejectWith(FailureCode.ROUND_MISMATCH);
        referenceTx = ref;
      }

      const expectedVersion = wallet.version;
      const entry = wallet.credit({
        transactionId: tx.id,
        entryId: newUuid(),
        money: tx.money,
        at: now,
      });

      tx.markProcessed(referenceTx?.id, now, wallet.balance);
      await persistTx();
      await repos.updateWallet(wallet, expectedVersion);
      await repos.insertLedgerEntry(entry);

      outboxMessages.push(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(tx, { ...baseCtx, eventId: newUuid() }),
        ),
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, { ...baseCtx, eventId: newUuid() }),
        ),
      );
      await repos.insertOutboxMessages(outboxMessages);

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    // REFUND or ROLLBACK (referenceExternalTransactionId is required)
    const ref = await repos.findWagerByProviderExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId!,
    );

    if (
      !ref ||
      ref.status === WagerTransactionStatus.Pending ||
      ref.status === WagerTransactionStatus.PendingReference
    ) {
      if (isFinalPendingAttempt) {
        return rejectWith(FailureCode.REFERENCE_NOT_FOUND);
      }
      const wasPending = tx.status === WagerTransactionStatus.PendingReference;
      const nextRetryAt = new Date(
        now.getTime() + Math.min(30_000, 500 * 2 ** Math.min(tx.pendingAttempts, 6)),
      );
      tx.markPendingReference(nextRetryAt);
      await persistTx();
      if (!wasPending) {
        outboxMessages.push(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(tx, { ...baseCtx, eventId: newUuid() }),
          ),
        );
        await repos.insertOutboxMessages(outboxMessages);
      }
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    if (ref.status !== WagerTransactionStatus.Processed) {
      return rejectWith(FailureCode.REFERENCE_NOT_PROCESSED);
    }
    if (ref.walletId !== tx.walletId) return rejectWith(FailureCode.WALLET_MISMATCH);
    if (ref.playerId !== tx.playerId) return rejectWith(FailureCode.PLAYER_MISMATCH);
    if (ref.money.currency !== tx.money.currency) return rejectWith(FailureCode.CURRENCY_MISMATCH);
    if (ref.roundId !== tx.roundId) return rejectWith(FailureCode.ROUND_MISMATCH);

    if (tx.kind === WagerTransactionKind.Refund && ref.kind !== WagerTransactionKind.Bet) {
      return rejectWith(FailureCode.INVALID_REFERENCE_KIND);
    }
    if (
      tx.kind === WagerTransactionKind.Rollback &&
      ref.kind !== WagerTransactionKind.Bet &&
      ref.kind !== WagerTransactionKind.Win &&
      ref.kind !== WagerTransactionKind.Refund
    ) {
      return rejectWith(FailureCode.INVALID_REFERENCE_KIND);
    }

    if (!ref.money.equals(tx.money)) {
      return rejectWith(FailureCode.AMOUNT_MISMATCH);
    }

    const alreadyReversed = await repos.existsProcessedReversal(ref.id, tx.kind);
    if (alreadyReversed) {
      return rejectWith(FailureCode.ALREADY_REVERSED);
    }

    const direction = tx.ledgerDirectionFor(ref);
    const expectedVersion = wallet.version;
    let entry: WalletLedgerEntry;

    try {
      if (direction === LedgerDirection.Credit) {
        entry = wallet.credit({
          transactionId: tx.id,
          entryId: newUuid(),
          money: tx.money,
          at: now,
        });
      } else {
        entry = wallet.debit({
          transactionId: tx.id,
          entryId: newUuid(),
          money: tx.money,
          at: now,
          insufficientFundsCode: FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
        });
      }
    } catch (err) {
      if (err instanceof BusinessRejectionError) {
        return rejectWith(err.failureCode);
      }
      throw err;
    }

    tx.markProcessed(ref.id, now, wallet.balance);
    await persistTx();
    await repos.updateWallet(wallet, expectedVersion);
    await repos.insertLedgerEntry(entry);

    outboxMessages.push(
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(tx, { ...baseCtx, eventId: newUuid() }),
      ),
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(wallet, entry, { ...baseCtx, eventId: newUuid() }),
      ),
    );
    await repos.insertOutboxMessages(outboxMessages);

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }
}
