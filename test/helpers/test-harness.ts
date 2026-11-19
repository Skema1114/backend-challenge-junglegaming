import { MikroORM } from "@mikro-orm/postgresql";
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { buildMikroOrmConfig } from "../../mikro-orm.config";

export const WAGER_QUEUE_URL =
  process.env.SQS_WAGER_QUEUE_URL ??
  "http://localhost:4566/000000000000/wager-transactions.fifo";
export const WAGER_DLQ_URL =
  process.env.SQS_WAGER_DLQ_URL ??
  "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";
export const OUTBOX_QUEUE_URL =
  process.env.SQS_OUTBOX_QUEUE_URL ??
  "http://localhost:4566/000000000000/wager-events.fifo";

export function createTestSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

export async function resetDatabase(orm: MikroORM): Promise<void> {
  const conn = orm.em.getConnection();
  await conn.execute(`
    TRUNCATE TABLE
      outbox_messages,
      inbox_messages,
      wallet_ledger_entries,
      wager_transactions,
      wallets
    RESTART IDENTITY CASCADE;
  `);
}

export async function drainSqsQueues(sqs: SQSClient): Promise<void> {
  for (const url of [WAGER_QUEUE_URL, WAGER_DLQ_URL, OUTBOX_QUEUE_URL]) {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
  await Bun.sleep(150);
}

export async function receiveAllFromQueue(
  sqs: SQSClient,
  queueUrl: string,
  maxWaitMs = 3000,
): Promise<Array<{ messageId?: string; body: string }>> {
  const collected: Array<{ messageId?: string; body: string }> = [];
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    const msgs = res.Messages ?? [];
    if (msgs.length === 0) break;
    for (const m of msgs) {
      if (m.Body) {
        collected.push({ messageId: m.MessageId, body: m.Body });
      }
      if (m.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    }
  }
  return collected;
}

export async function sendWagerToSqs(
  sqs: SQSClient,
  payload: Record<string, unknown>,
  groupId: string,
  dedupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: WAGER_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

export interface SpawnedApp {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startAppProcess(
  port: number,
  extraEnv: Record<string, string> = {},
): Promise<SpawnedApp> {
  const bunBin = process.execPath;
  const proc = Bun.spawn([bunBin, "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      INSTANCE_ID: extraEnv.INSTANCE_ID ?? `test-inst-${port}`,
      SQS_CONSUMER_ENABLED: extraEnv.SQS_CONSUMER_ENABLED ?? "false",
      OUTBOX_WORKER_ENABLED: extraEnv.OUTBOX_WORKER_ENABLED ?? "false",
      PENDING_REFERENCE_WORKER_ENABLED: extraEnv.PENDING_REFERENCE_WORKER_ENABLED ?? "false",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let ready = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health/live`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // waiting for startup
    }
    await Bun.sleep(150);
  }

  if (!ready) {
    proc.kill("SIGKILL");
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    throw new Error(`App on port ${port} failed to start.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  return {
    port,
    baseUrl,
    stop: async () => {
      proc.kill("SIGTERM");
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 5000);
      await proc.exited;
      clearTimeout(timeout);
    },
  };
}

export async function createTestOrm(): Promise<MikroORM> {
  return MikroORM.init(buildMikroOrmConfig());
}
