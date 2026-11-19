import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port";
import { NotFoundDomainError } from "../../shared/domain/errors";

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(@Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort) {}

  async execute(walletId: string, cursor?: string, limit = 50) {
    const clampedLimit = Math.min(100, Math.max(1, limit));
    const repos = this.uow.readOnly();
    const wallet = await repos.findWalletById(walletId);
    if (!wallet) {
      throw new NotFoundDomainError(`Wallet ${walletId} not found`, "WALLET_NOT_FOUND");
    }

    const page = await repos.findLedgerPage(walletId, cursor, clampedLimit);
    return {
      walletId,
      items: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
