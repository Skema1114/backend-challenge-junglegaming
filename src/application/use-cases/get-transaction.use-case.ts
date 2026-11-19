import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port";
import { NotFoundDomainError } from "../../shared/domain/errors";
import { WagerTransaction } from "../../domain/wagering/wager-transaction.entity";

function toDto(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

@Injectable()
export class GetTransactionUseCase {
  constructor(@Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort) {}

  async byId(transactionId: string) {
    const tx = await this.uow.readOnly().findWagerById(transactionId);
    if (!tx) {
      throw new NotFoundDomainError(`Transaction ${transactionId} not found`, "TRANSACTION_NOT_FOUND");
    }
    return toDto(tx);
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string) {
    const tx = await this.uow
      .readOnly()
      .findWagerByProviderExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new NotFoundDomainError(
        `Transaction ${providerId}:${externalTransactionId} not found`,
        "TRANSACTION_NOT_FOUND",
      );
    }
    return toDto(tx);
  }
}
