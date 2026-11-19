import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port";
import { NotFoundDomainError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { MetricsService } from "../../shared/observability/metrics.service";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async execute(walletId: string, correlationId?: string) {
    return this.uow.runInTransaction(async (repos) => {
      const wallet = await repos.findWalletByIdForUpdate(walletId);
      if (!wallet) {
        throw new NotFoundDomainError(`Wallet ${walletId} not found`, "WALLET_NOT_FOUND");
      }

      const stats = await repos.sumLedgerForWallet(walletId);
      const storedBalance = wallet.balance;
      const calculatedBalance = Money.rehydrate({
        amount: stats.calculatedAmount,
        currency: wallet.currency,
      });
      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = difference.isZero();

      if (!consistent) {
        this.metrics.incReconciliationDivergence();
        this.logger.error("wallet.reconciliation.divergence", {
          correlationId,
          walletId,
          storedAmount: storedBalance.toString(),
          calculatedAmount: calculatedBalance.toString(),
          differenceAmount: difference.toString(),
          checkedEntries: stats.checkedEntries,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: stats.checkedEntries,
      };
    });
  }
}
