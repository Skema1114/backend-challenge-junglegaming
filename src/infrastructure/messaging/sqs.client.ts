import { Injectable } from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import { TransientInfrastructureError } from "../../shared/domain/errors";

@Injectable()
export class SqsGateway {
  readonly client: SQSClient;
  readonly wagerQueueUrl: string;
  readonly wagerDlqUrl: string;
  readonly outboxQueueUrl: string;

  constructor() {
    this.wagerQueueUrl =
      process.env.SQS_WAGER_QUEUE_URL ??
      "http://localhost:4566/000000000000/wager-transactions.fifo";
    this.wagerDlqUrl =
      process.env.SQS_WAGER_DLQ_URL ??
      "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";
    this.outboxQueueUrl =
      process.env.SQS_OUTBOX_QUEUE_URL ??
      "http://localhost:4566/000000000000/wager-events.fifo";

    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  async receiveWagerMessages(maxMessages = 10, waitTimeSeconds = 5): Promise<Message[]> {
    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.wagerQueueUrl,
          MaxNumberOfMessages: maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      return response.Messages ?? [];
    } catch (err) {
      throw new TransientInfrastructureError("Failed to receive messages from SQS", err);
    }
  }

  async ackWagerMessage(receiptHandle: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.wagerQueueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err) {
      throw new TransientInfrastructureError("Failed to delete message from SQS", err);
    }
  }

  async releaseWagerMessage(receiptHandle: string, delaySeconds = 0): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.wagerQueueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: Math.max(0, Math.min(43200, Math.floor(delaySeconds))),
        }),
      );
    } catch (err) {
      throw new TransientInfrastructureError("Failed to change SQS message visibility", err);
    }
  }

  async sendToWagerQueue(
    body: string,
    groupId: string,
    deduplicationId: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.wagerQueueUrl,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId: deduplicationId,
        }),
      );
    } catch (err) {
      throw new TransientInfrastructureError("Failed to enqueue wager message to SQS", err);
    }
  }

  async sendToDlq(body: string, groupId: string, deduplicationId: string): Promise<void> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.wagerDlqUrl,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId: deduplicationId,
        }),
      );
    } catch (err) {
      throw new TransientInfrastructureError("Failed to send message to DLQ", err);
    }
  }

  async publishOutboxEvent(outboxMsg: OutboxMessage): Promise<void> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.outboxQueueUrl,
          MessageBody: JSON.stringify(outboxMsg.payload),
          MessageGroupId: outboxMsg.aggregateId,
          MessageDeduplicationId: outboxMsg.id,
        }),
      );
    } catch (err) {
      throw new TransientInfrastructureError("Failed to publish outbox event to SQS", err);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerQueueUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
