import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../application/use-cases/get-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { ProviderAuthGuard } from "../../shared/auth/auth.guard";

const createWalletSchema = z.object({
  playerId: z.string().min(1).max(128),
  initialBalance: z.object({
    amount: z.string().min(1),
    currency: z.string().length(3),
  }),
});

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getWalletLedger: GetWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    const parsed = createWalletSchema.parse(body);
    return this.createWallet.execute({
      playerId: parsed.playerId,
      initialBalance: parsed.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  async getById(@Param("walletId", new ParseUUIDPipe()) walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId", new ParseUUIDPipe()) walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limitRaw?: string,
  ) {
    const parsedLimit = limitRaw !== undefined ? Number(limitRaw) : 50;
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    return this.getWalletLedger.execute(walletId, cursor, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param("walletId", new ParseUUIDPipe()) walletId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.reconcileWallet.execute(walletId, correlationId);
  }
}
