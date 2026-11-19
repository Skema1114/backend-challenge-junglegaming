import { Injectable } from "@nestjs/common";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  instanceId?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "secret",
  "password",
  "payload",
  "body",
  "rawbody",
]);

@Injectable()
export class StructuredLoggerService {
  private readonly instanceId = process.env.INSTANCE_ID ?? `pid-${process.pid}`;

  info(event: string, context: LogContext = {}): void {
    this.emit("INFO", event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.emit("WARN", event, context);
  }

  error(event: string, context: LogContext = {}, err?: unknown): void {
    const errorInfo =
      err instanceof Error
        ? { errorName: err.name, errorMessage: err.message }
        : err !== undefined
          ? { errorMessage: String(err) }
          : {};
    this.emit("ERROR", event, { ...context, ...errorInfo });
  }

  private emit(level: "INFO" | "WARN" | "ERROR", event: string, context: LogContext): void {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (!SENSITIVE_KEYS.has(key.toLowerCase()) && value !== undefined) {
        sanitized[key] = value;
      }
    }

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      instanceId: this.instanceId,
      event,
      ...sanitized,
    });

    if (level === "ERROR") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
