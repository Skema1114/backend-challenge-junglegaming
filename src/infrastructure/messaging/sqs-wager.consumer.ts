import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Message } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction.entity";
import {
  ConflictDomainError,
  NotFoundDomainError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
  ValidationDomainError,
} from "../../shared/domain/errors";
import { newUuid } from "../../shared/domain/id";
import { MetricsService } from "../../shared/observability/metrics.service";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";
import { SqsGateway } from "./sqs.client";

const sqsEnvelopeSchema = z.object({
  messageId: z.string().min(1),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().optional(),
  data: z.object({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
    playerId: z.string().min(1),
    walletId: z.string().uuid(),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.nativeEnum(WagerTransactionKind),
    money: z.object({
      amount: z.string().min(1),
      currency: z.string().length(3),
    }),
    referenceExternalTransactionId: z.string().min(1).optional(),
  }),
});

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly consumerName = "sqs-wager-consumer";
  private readonly maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);
  private readonly enabled = process.env.SQS_CONSUMER_ENABLED !== "false";
  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    this.loopPromise = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([
      this.loopPromise ?? Promise.resolve(),
      ...Array.from(this.inFlight),
    ]);
  }

  private async pollLoop(): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const messages = await this.sqs.receiveWagerMessages(10, 2);
        if (messages.length === 0) continue;

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]!;
          if (this.shuttingDown) {
            if (msg.ReceiptHandle) {
              await this.sqs.releaseWagerMessage(msg.ReceiptHandle, 0).catch(() => undefined);
            }
            continue;
          }

          const task = this.handleMessage(msg).finally(() => {
            this.inFlight.delete(task);
          });
          this.inFlight.add(task);
        }

        await Promise.allSettled(Array.from(this.inFlight));
      } catch (err) {
        if (!this.shuttingDown) {
          this.logger.error("sqs.consumer.poll_error", {}, err);
          await Bun.sleep(500);
        }
      }
    }
  }

  async handleMessage(msg: Message, hooks?: { beforeAck?: () => Promise<void> }): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const sqsMessageId = msg.MessageId ?? newUuid();
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? 1);

    let parsed: z.infer<typeof sqsEnvelopeSchema>;
    try {
      const rawJson = JSON.parse(msg.Body ?? "{}");
      parsed = sqsEnvelopeSchema.parse(rawJson);
    } catch (err) {
      this.logger.error("sqs.consumer.malformed_message", { messageId: sqsMessageId }, err);
      this.metrics.incDlq();
      if (msg.Body) {
        await this.sqs.sendToDlq(msg.Body, "malformed", `${sqsMessageId}-dlq`).catch(() => undefined);
      }
      if (receiptHandle) {
        await this.sqs.ackWagerMessage(receiptHandle);
      }
      return;
    }

    const d = parsed.data;
    const idempotencyKey = d.idempotencyKey ?? `${d.providerId}:${d.externalTransactionId}`;

    try {
      await this.processWager.execute({
        providerId: d.providerId,
        externalTransactionId: d.externalTransactionId,
        idempotencyKey,
        playerId: d.playerId,
        walletId: d.walletId,
        roundId: d.roundId,
        gameId: d.gameId,
        kind: d.kind,
        money: d.money,
        referenceExternalTransactionId: d.referenceExternalTransactionId,
        correlationId: parsed.messageId,
        inboxContext: {
          consumerName: this.consumerName,
          messageId: parsed.messageId,
          receivedAt: parsed.occurredAt ? new Date(parsed.occurredAt) : new Date(),
        },
      });

      if (hooks?.beforeAck) {
        await hooks.beforeAck();
      }

      if (receiptHandle) {
        await this.sqs.ackWagerMessage(receiptHandle);
      }
    } catch (err) {
      if (
        err instanceof ValidationDomainError ||
        err instanceof ConflictDomainError ||
        err instanceof NotFoundDomainError ||
        err instanceof PermanentInfrastructureError
      ) {
        this.logger.warn("sqs.consumer.permanent_or_business_dlq", {
          messageId: parsed.messageId,
          providerId: d.providerId,
          walletId: d.walletId,
          errorCode: err instanceof Error ? err.name : "ERROR",
        });
        this.metrics.incDlq();
        if (msg.Body) {
          await this.sqs.sendToDlq(msg.Body, d.walletId, `${parsed.messageId}-${receiveCount}`);
        }
        if (receiptHandle) {
          await this.sqs.ackWagerMessage(receiptHandle);
        }
        return;
      }

      if (err instanceof TransientInfrastructureError || err instanceof Error) {
        this.metrics.incRetry();
        if (receiveCount >= this.maxReceiveCount) {
          this.metrics.incDlq();
        }
        this.logger.error(
          "sqs.consumer.transient_error",
          {
            messageId: parsed.messageId,
            providerId: d.providerId,
            walletId: d.walletId,
            receiveCount,
          },
          err,
        );
        if (receiptHandle) {
          const backoffSec = Math.min(30, 2 ** Math.min(receiveCount, 4));
          await this.sqs.releaseWagerMessage(receiptHandle, backoffSec).catch(() => undefined);
        }
      }
    }
  }
}
