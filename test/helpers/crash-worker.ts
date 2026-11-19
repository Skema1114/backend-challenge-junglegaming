import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { AppModule } from "../../src/app.module";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager.consumer";
import { SqsGateway } from "../../src/infrastructure/messaging/sqs.client";

/**
 * Simulates a worker process that commits the financial transaction in PostgreSQL
 * and crashes (SIGKILL-like immediate exit) before acknowledging the SQS message.
 */
async function main() {
  process.env.SQS_CONSUMER_ENABLED = "false";
  process.env.OUTBOX_WORKER_ENABLED = "false";
  process.env.PENDING_REFERENCE_WORKER_ENABLED = "false";

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const sqs = app.get(SqsGateway);
  const consumer = app.get(SqsWagerConsumer);

  const res = await sqs.client.send(
    new ReceiveMessageCommand({
      QueueUrl: sqs.wagerQueueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 2,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );

  const msg = res.Messages?.[0];
  if (!msg) {
    await app.close();
    process.exit(2);
  }

  await consumer.handleMessage(msg, {
    beforeAck: async () => {
      // Simulate process crash right after PostgreSQL commit and before SQS DeleteMessage
      process.exit(42);
    },
  });

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
