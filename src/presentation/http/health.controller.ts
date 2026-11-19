import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../../application/ports/unit-of-work.port";
import { SqsGateway } from "../../infrastructure/messaging/sqs.client";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(UNIT_OF_WORK_PORT) private readonly uow: UnitOfWorkPort,
    private readonly sqs: SqsGateway,
  ) {}

  @Get("live")
  live() {
    return {
      status: "ok",
      instanceId: process.env.INSTANCE_ID ?? `pid-${process.pid}`,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  @Get("ready")
  async ready(@Res() res: Response): Promise<void> {
    const [postgres, sqs] = await Promise.all([this.uow.ping(), this.sqs.ping()]);
    const healthy = postgres && sqs;
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: healthy ? "ready" : "degraded",
      checks: {
        postgres: postgres ? "up" : "down",
        sqs: sqs ? "up" : "down",
      },
    });
  }
}
