import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../../application/ports/unit-of-work.port";
import { MetricsService } from "../../shared/observability/metrics.service";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";
import { SqsGateway } from "./sqs.client";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly enabled = process.env.OUTBOX_WORKER_ENABLED !== "false";
  private readonly pollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 250);
  private readonly batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 25);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private currentTick: Promise<void> | null = null;

  constructor(
    @Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort,
    private readonly sqs: SqsGateway,
    private readonly metrics: MetricsService,
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
      this.currentTick = this.tick()
        .catch((err) => {
          this.logger.error("outbox.worker.tick_error", {}, err);
        })
        .finally(() => {
          this.currentTick = null;
          this.scheduleNext();
        });
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    await this.publishPendingBatch();
    const stats = await this.uow.readOnly().getOutboxStats(new Date());
    this.metrics.setOutboxLag(stats.maxLagMs, stats.pendingCount);
  }

  async publishPendingBatch(limit = this.batchSize): Promise<number> {
    const now = new Date();
    return this.uow.runInTransaction(async (repos) => {
      const batch = await repos.acquireDueOutboxBatch(now, limit);
      let publishedCount = 0;

      for (const msg of batch) {
        try {
          await this.sqs.publishOutboxEvent(msg);
          msg.markPublished(new Date());
          await repos.updateOutboxMessage(msg);
          publishedCount += 1;
        } catch (err) {
          msg.scheduleRetry(new Date());
          await repos.updateOutboxMessage(msg);
          this.metrics.incRetry();
          this.logger.warn("outbox.publish_retry", {
            eventId: msg.id,
            eventType: msg.eventType,
            attempts: msg.attempts,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return publishedCount;
    });
  }
}
