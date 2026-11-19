import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port";
import { NotFoundDomainError } from "../../shared/domain/errors";
import { MoneyProps } from "../../shared/domain/money";

export interface GetWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort) {}

  async execute(walletId: string): Promise<GetWalletOutput> {
    const wallet = await this.uow.readOnly().findWalletById(walletId);
    if (!wallet) {
      throw new NotFoundDomainError(`Wallet ${walletId} not found`, "WALLET_NOT_FOUND");
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
