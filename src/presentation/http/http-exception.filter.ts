import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  BusinessRejectionError,
  ConflictDomainError,
  InvalidTransactionStateError,
  NotFoundDomainError,
  TransientInfrastructureError,
  ValidationDomainError,
} from "../../shared/domain/errors";
import { StructuredLoggerService } from "../../shared/observability/structured-logger.service";

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = request.header("x-correlation-id") ?? undefined;

    if (exception instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: "VALIDATION_ERROR",
        message: "Invalid request payload",
        details: exception.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }

    if (exception instanceof ValidationDomainError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof NotFoundDomainError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof ConflictDomainError) {
      response.status(HttpStatus.CONFLICT).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof BusinessRejectionError) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: exception.failureCode,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof TransientInfrastructureError) {
      this.logger.error("http.transient_infrastructure_error", { correlationId, path: request.url }, exception);
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Temporary infrastructure failure, please retry",
      });
      return;
    }

    if (exception instanceof InvalidTransactionStateError) {
      this.logger.error("http.invalid_transaction_state", { correlationId, path: request.url }, exception);
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(
        typeof body === "string" ? { error: "HTTP_ERROR", message: body } : body,
      );
      return;
    }

    this.logger.error("http.unhandled_exception", { correlationId, path: request.url }, exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected internal error",
    });
  }
}
