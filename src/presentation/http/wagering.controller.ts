import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { GetTransactionUseCase } from "../../application/use-cases/get-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction.entity";
import { ProviderAuthGuard } from "../../shared/auth/auth.guard";
import { ValidationDomainError } from "../../shared/domain/errors";

const submitWagerSchema = z.object({
  providerId: z.string().min(1).max(128),
  externalTransactionId: z.string().min(1).max(255),
  playerId: z.string().min(1).max(128),
  walletId: z.string().uuid(),
  roundId: z.string().min(1).max(255),
  gameId: z.string().min(1).max(255),
  kind: z.nativeEnum(WagerTransactionKind),
  money: z.object({
    amount: z.string().min(1),
    currency: z.string().length(3),
  }),
  referenceExternalTransactionId: z.string().min(1).max(255).optional(),
});

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKeyHeader || !idempotencyKeyHeader.trim()) {
      throw new ValidationDomainError("Idempotency-Key header is required", "MISSING_IDEMPOTENCY_KEY");
    }

    const parsed = submitWagerSchema.parse(body);
    const result = await this.processWager.execute({
      providerId: parsed.providerId,
      externalTransactionId: parsed.externalTransactionId,
      idempotencyKey: idempotencyKeyHeader.trim(),
      playerId: parsed.playerId,
      walletId: parsed.walletId,
      roundId: parsed.roundId,
      gameId: parsed.gameId,
      kind: parsed.kind,
      money: parsed.money,
      referenceExternalTransactionId: parsed.referenceExternalTransactionId,
      correlationId,
    });

    let statusCode = HttpStatus.OK;
    if (result.status === WagerTransactionStatus.PendingReference) {
      statusCode = HttpStatus.ACCEPTED;
    } else if (result.status === WagerTransactionStatus.Rejected) {
      statusCode = HttpStatus.UNPROCESSABLE_ENTITY;
    } else if (result.status === WagerTransactionStatus.Processed && !result.idempotentReplay) {
      statusCode = HttpStatus.CREATED;
    }

    res.status(statusCode).json(result);
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId", new ParseUUIDPipe()) transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProviderExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getTransaction.byProviderExternalId(providerId, externalTransactionId);
  }
}
