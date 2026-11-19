import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { GlobalHttpExceptionFilter } from "./presentation/http/http-exception.filter";
import { StructuredLoggerService } from "./shared/observability/structured-logger.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(StructuredLoggerService);
  app.useGlobalFilters(new GlobalHttpExceptionFilter(logger));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port);
  logger.info("app.started", { port });
}

bootstrap().catch((err) => {
  console.error("Failed to start application:", err);
  process.exit(1);
});
