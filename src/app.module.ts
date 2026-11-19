import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { buildMikroOrmConfig } from "../mikro-orm.config";
import { UNIT_OF_WORK_PORT } from "./application/ports/unit-of-work.port";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { GetTransactionUseCase } from "./application/use-cases/get-transaction.use-case";
import { GetWalletLedgerUseCase } from "./application/use-cases/get-wallet-ledger.use-case";
import { GetWalletUseCase } from "./application/use-cases/get-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { OutboxPublisherWorker } from "./infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "./infrastructure/messaging/pending-reference.worker";
import { SqsWagerConsumer } from "./infrastructure/messaging/sqs-wager.consumer";
import { SqsGateway } from "./infrastructure/messaging/sqs.client";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/repositories/mikro-orm-unit-of-work";
import { HealthController } from "./presentation/http/health.controller";
import { WageringController } from "./presentation/http/wagering.controller";
import { WalletsController } from "./presentation/http/wallets.controller";
import {
  NoopProviderIdentityAdapter,
  PROVIDER_IDENTITY_PORT,
  ProviderAuthGuard,
} from "./shared/auth/auth.guard";
import { MetricsController } from "./shared/observability/metrics.controller";
import { MetricsService } from "./shared/observability/metrics.service";
import { StructuredLoggerService } from "./shared/observability/structured-logger.service";

@Module({
  imports: [MikroOrmModule.forRoot(buildMikroOrmConfig())],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    StructuredLoggerService,
    MetricsService,
    ProviderAuthGuard,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: NoopProviderIdentityAdapter,
    },
    MikroOrmUnitOfWork,
    {
      provide: UNIT_OF_WORK_PORT,
      useExisting: MikroOrmUnitOfWork,
    },
    SqsGateway,
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetTransactionUseCase,
    ReconcileWalletUseCase,
    ProcessWagerTransactionUseCase,
    SqsWagerConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
