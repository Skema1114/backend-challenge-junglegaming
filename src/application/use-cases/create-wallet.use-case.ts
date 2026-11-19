import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port";
import { Money, MoneyProps } from "../../shared/domain/money";
import { ConflictDomainError } from "../../shared/domain/errors";
import { newUuid } from "../../shared/domain/id";
import { hashCanonicalPayload } from "../../shared/domain/canonical-json";
import { Wallet } from "../../domain/wallet/wallet.entity";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry.entity";
import { WagerTransaction } from "../../domain/wagering/wager-transaction.entity";
import { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-event";
import { extractPgCode } from "../../infrastructure/persistence/repositories/mikro-orm-unit-of-work";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort,
    private readonly logger: StructuredLoggerService,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const initialBalance = Money.from(input.initialBalance);
    const walletId = newUuid();
    const now = new Date();
    const correlationId = input.correlationId ?? newUuid();

    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      now,
    });

    try {
      await this.uow.runInTransaction(async (repos) => {
        await repos.insertWallet(wallet);

        if (initialBalance.isPositive()) {
          const txId = newUuid();
          const openingTx = WagerTransaction.createOpening({
            id: txId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            payloadHash: hashCanonicalPayload({
              walletId: wallet.id,
              playerId: wallet.playerId,
              initialBalance: initialBalance.toJSON(),
            }),
            createdAt: now,
          });
          openingTx.markProcessed(undefined, now, wallet.balance);

          const entry = WalletLedgerEntry.create({
            id: newUuid(),
            walletId: wallet.id,
            transactionId: openingTx.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            createdAt: now,
          });

          await repos.insertWagerTransaction(openingTx);
          await repos.insertLedgerEntry(entry);

          const outboxMessages = [
            OutboxMessage.enqueue(
              WagerTransactionProcessed.from(openingTx, {
                eventId: newUuid(),
                correlationId,
                causationId: openingTx.id,
                occurredAt: now,
              }),
            ),
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, entry, {
                eventId: newUuid(),
                correlationId,
                causationId: openingTx.id,
                occurredAt: now,
              }),
            ),
          ];
          await repos.insertOutboxMessages(outboxMessages);
        }
      });
    } catch (err) {
      if (extractPgCode(err) === "23505") {
        throw new ConflictDomainError(
          `Wallet already exists for player ${input.playerId} and currency ${initialBalance.currency}`,
          "WALLET_ALREADY_EXISTS",
        );
      }
      throw err;
    }

    this.logger.info("wallet.created", {
      correlationId,
      walletId: wallet.id,
      currency: wallet.currency,
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
