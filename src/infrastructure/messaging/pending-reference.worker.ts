import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../../application/ports/unit-of-work.port";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly enabled = process.env.PENDING_REFERENCE_WORKER_ENABLED !== "false";
  private readonly pollIntervalMs = Number(process.env.PENDING_REF_POLL_INTERVAL_MS ?? 1000);
  private readonly maxAttempts = Number(process.env.PENDING_REF_MAX_ATTEMPTS ?? 10);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private currentTick: Promise<void> | null = null;

  constructor(
    @Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.currentTick) {
      await this.currentTick;
    }
  }

  private scheduleNext(): void {
    if (this.shuttingDown) return;
    this.timer = setTimeout(() => {
      this.currentTick = this.processDueBatch()
        .then(() => undefined)
        .catch((err) => {
          this.logger.error("pending_reference.worker.error", {}, err);
        })
        .finally(() => {
          this.currentTick = null;
          this.scheduleNext();
        });
    }, this.pollIntervalMs);
  }

  async processDueBatch(limit = 25, overrideMaxAttempts = this.maxAttempts): Promise<number> {
    const due = await this.uow.readOnly().findDuePendingReferenceTransactions(new Date(), limit);
    let resolvedCount = 0;
    for (const tx of due) {
      const res = await this.processWager.reprocessPendingReference(tx.id, overrideMaxAttempts);
      if (res.resolved) {
        resolvedCount += 1;
      }
    }
    return resolvedCount;
  }
}
