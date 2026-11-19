import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import { AppModule } from "../../src/app.module";
import { OutboxPublisherWorker } from "../../src/infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/messaging/pending-reference.worker";
import {
  createTestOrm,
  createTestSqsClient,
  drainSqsQueues,
  OUTBOX_QUEUE_URL,
  receiveAllFromQueue,
  resetDatabase,
  sendWagerToSqs,
  SpawnedApp,
  startAppProcess,
} from "../helpers/test-harness";

describe("Concurrency & Crash Recovery (Real PostgreSQL + LocalStack + Multi-Instance)", () => {
  let orm: MikroORM;
  let sqs: SQSClient;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    sqs = createTestSqsClient();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await drainSqsQueues(sqs);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function createWallet(baseUrl: string, playerId: string, amount: string): Promise<string> {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency: "BRL" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function assertReconciled(baseUrl: string, walletId: string, expectedBalance?: string) {
    const res = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: "POST" });
    expect(res.status).toBe(200);
    const rec = (await res.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
    };
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe(rec.calculatedBalance.amount);
    if (expectedBalance !== undefined) {
      expect(rec.storedBalance.amount).toBe(expectedBalance);
    }
  }

  it("1. processes the same bet 50 times in parallel with exactly one debit", async () => {
    const app = await startAppProcess(3120);
    try {
      const walletId = await createWallet(app.baseUrl, "p-50x", "500.00");

      const payload = {
        providerId: "prov-50",
        externalTransactionId: "ext-50",
        playerId: "p-50x",
        walletId,
        roundId: "r-50",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      };

      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          fetch(`${app.baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": "prov-50:ext-50",
            },
            body: JSON.stringify(payload),
          }).then(async (r) => ({ status: r.status, body: (await r.json()) as { idempotentReplay: boolean; balance: { amount: string } } })),
        ),
      );

      const created = responses.filter((r) => r.status === 201 && !r.body.idempotentReplay);
      const replayed = responses.filter((r) => r.status === 200 && r.body.idempotentReplay);
      expect(created.length).toBe(1);
      expect(replayed.length).toBe(49);
      for (const r of responses) {
        expect(r.body.balance.amount).toBe("475.00");
      }

      const ledgerCountRows = await orm.em
        .getConnection()
        .execute<Array<{ cnt: string }>>(
          `SELECT COUNT(*)::text AS cnt FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
          [walletId],
        );
      expect(Number(ledgerCountRows[0]!.cnt)).toBe(1);
      await assertReconciled(app.baseUrl, walletId, "475.00");
    } finally {
      await app.stop();
    }
  });

  it("2. enforces mandatory race condition scenario (100.00 BRL vs two concurrent 80.00 BRL bets)", async () => {
    const app = await startAppProcess(3121);
    try {
      const walletId = await createWallet(app.baseUrl, "p-race-80", "100.00");

      const [r1, r2] = await Promise.all([
        fetch(`${app.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "prov:bet-a" },
          body: JSON.stringify({
            providerId: "prov",
            externalTransactionId: "bet-a",
            playerId: "p-race-80",
            walletId,
            roundId: "r-1",
            gameId: "chimp-mines",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          }),
        }),
        fetch(`${app.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "prov:bet-b" },
          body: JSON.stringify({
            providerId: "prov",
            externalTransactionId: "bet-b",
            playerId: "p-race-80",
            walletId,
            roundId: "r-2",
            gameId: "chimp-mines",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          }),
        }),
      ]);

      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 422]);

      const b1 = (await r1.json()) as { status: string; failureCode?: string };
      const b2 = (await r2.json()) as { status: string; failureCode?: string };
      const txStatuses = [b1.status, b2.status].sort();
      expect(txStatuses).toEqual(["PROCESSED", "REJECTED"]);

      const rejected = b1.status === "REJECTED" ? b1 : b2;
      expect(rejected.failureCode).toBe("INSUFFICIENT_FUNDS");

      const debits = await orm.em
        .getConnection()
        .execute<Array<{ cnt: string }>>(
          `SELECT COUNT(*)::text AS cnt FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
          [walletId],
        );
      expect(Number(debits[0]!.cnt)).toBe(1);
      await assertReconciled(app.baseUrl, walletId, "20.00");
    } finally {
      await app.stop();
    }
  });

  it("3. processes distinct wallets in parallel consistently", async () => {
    const app = await startAppProcess(3122);
    try {
      const walletIds = await Promise.all(
        Array.from({ length: 8 }, (_, idx) => createWallet(app.baseUrl, `p-distinct-${idx}`, "100.00")),
      );

      await Promise.all(
        walletIds.map((walletId, idx) =>
          fetch(`${app.baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": `prov:d-${idx}` },
            body: JSON.stringify({
              providerId: "prov",
              externalTransactionId: `d-${idx}`,
              playerId: `p-distinct-${idx}`,
              walletId,
              roundId: `r-${idx}`,
              gameId: "fortune-chimp",
              kind: "BET",
              money: { amount: "35.00", currency: "BRL" },
            }),
          }).then((r) => expect(r.status).toBe(201)),
        ),
      );

      await Promise.all(walletIds.map((wId) => assertReconciled(app.baseUrl, wId, "65.00")));
    } finally {
      await app.stop();
    }
  });

  it("4. maintains strict consistency across >= 3 simultaneous application instances", async () => {
    const apps: SpawnedApp[] = await Promise.all([
      startAppProcess(3131, { INSTANCE_ID: "inst-1" }),
      startAppProcess(3132, { INSTANCE_ID: "inst-2" }),
      startAppProcess(3133, { INSTANCE_ID: "inst-3" }),
    ]);

    try {
      const hotWalletId = await createWallet(apps[0]!.baseUrl, "p-hot", "200.00");

      // Fire 20 concurrent 15.00 BRL bets distributed round-robin across all 3 OS processes
      // 200.00 / 15.00 => max 13 bets succeed (195.00), 7 must be REJECTED, final balance = 5.00
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const targetApp = apps[i % apps.length]!;
          return fetch(`${targetApp.baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `prov-multi:bet-${i}`,
            },
            body: JSON.stringify({
              providerId: "prov-multi",
              externalTransactionId: `bet-${i}`,
              playerId: "p-hot",
              walletId: hotWalletId,
              roundId: `round-${i}`,
              gameId: "fortune-chimp",
              kind: "BET",
              money: { amount: "15.00", currency: "BRL" },
            }),
          }).then((r) => r.status);
        }),
      );

      const processedCount = results.filter((s) => s === 201).length;
      const rejectedCount = results.filter((s) => s === 422).length;
      expect(processedCount).toBe(13);
      expect(rejectedCount).toBe(7);

      await assertReconciled(apps[1]!.baseUrl, hotWalletId, "5.00");
    } finally {
      await Promise.all(apps.map((a) => a.stop()));
    }
  });

  it("5. deduplicates cleanly when worker is killed after DB commit and before SQS ack", async () => {
    const setupApp = await startAppProcess(3135);
    let walletId: string;
    try {
      walletId = await createWallet(setupApp.baseUrl, "p-crash", "100.00");
    } finally {
      await setupApp.stop();
    }

    await sendWagerToSqs(
      sqs,
      {
        messageId: "crash-msg-1",
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "prov-crash",
          externalTransactionId: "ext-crash-1",
          idempotencyKey: "prov-crash:ext-crash-1",
          playerId: "p-crash",
          walletId,
          roundId: "r-crash",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "30.00", currency: "BRL" },
        },
      },
      walletId,
      "crash-dedup-1",
    );

    // Run real child process that commits to PostgreSQL and exits(42) BEFORE SQS ack
    const crashProc = Bun.spawn([process.execPath, "run", "test/helpers/crash-worker.ts"], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await crashProc.exited;
    expect(exitCode).toBe(42);

    // Wait for 2s visibility timeout expiration and boot a healthy consumer instance to receive redelivery
    await Bun.sleep(2300);
    const recoveryApp = await startAppProcess(3136, {
      INSTANCE_ID: "recovery-consumer",
      SQS_CONSUMER_ENABLED: "true",
      OUTBOX_WORKER_ENABLED: "true",
    });

    try {
      await Bun.sleep(1500);
      await assertReconciled(recoveryApp.baseUrl, walletId, "70.00");

      const debits = await orm.em
        .getConnection()
        .execute<Array<{ cnt: string }>>(
          `SELECT COUNT(*)::text AS cnt FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
          [walletId],
        );
      expect(Number(debits[0]!.cnt)).toBe(1);
    } finally {
      await recoveryApp.stop();
    }
  }, 20_000);

  it("6. runs two concurrent outbox publishers without duplicating published events", async () => {
    process.env.SQS_CONSUMER_ENABLED = "false";
    process.env.OUTBOX_WORKER_ENABLED = "false";
    process.env.PENDING_REFERENCE_WORKER_ENABLED = "false";

    const app = await startAppProcess(3137);
    try {
      const walletId = await createWallet(app.baseUrl, "p-outbox", "500.00");
      for (let i = 0; i < 6; i++) {
        await fetch(`${app.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `prov-ob:b-${i}` },
          body: JSON.stringify({
            providerId: "prov-ob",
            externalTransactionId: `b-${i}`,
            playerId: "p-outbox",
            walletId,
            roundId: `r-ob-${i}`,
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          }),
        });
      }
    } finally {
      await app.stop();
    }

    const ctx1 = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const ctx2 = await NestFactory.createApplicationContext(AppModule, { logger: false });

    try {
      const p1 = ctx1.get(OutboxPublisherWorker);
      const p2 = ctx2.get(OutboxPublisherWorker);

      const [c1, c2] = await Promise.all([p1.publishPendingBatch(25), p2.publishPendingBatch(25)]);
      // OPENING produces 2 events + 6 BETs produce 12 events = 14 events total
      expect(c1 + c2).toBe(14);

      const publishedEvents = await receiveAllFromQueue(sqs, OUTBOX_QUEUE_URL, 2500);
      const uniqueIds = new Set(
        publishedEvents.map((e) => (JSON.parse(e.body) as { eventId: string }).eventId),
      );
      expect(publishedEvents.length).toBe(14);
      expect(uniqueIds.size).toBe(14);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  it("7. resolves out-of-order REFUND/ROLLBACK via PendingReferenceWorker and rejects expired missing references", async () => {
    const app = await startAppProcess(3138, {
      PENDING_REFERENCE_WORKER_ENABLED: "false",
    });

    let walletId = "";
    try {
      walletId = await createWallet(app.baseUrl, "p-ooo", "100.00");

      // Submit REFUND before BET arrives -> 202 PENDING_REFERENCE
      const refundRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prov-ooo:ref-1" },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: "ref-1",
          playerId: "p-ooo",
          walletId,
          roundId: "r-ooo",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "40.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-ooo-1",
        }),
      });
      expect(refundRes.status).toBe(202);
      expect(((await refundRes.json()) as { status: string }).status).toBe("PENDING_REFERENCE");

      // Submit missing reference ROLLBACK that will never arrive
      const orphanRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prov-ooo:rb-orphan" },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: "rb-orphan",
          playerId: "p-ooo",
          walletId,
          roundId: "r-orphan",
          gameId: "fortune-chimp",
          kind: "ROLLBACK",
          money: { amount: "10.00", currency: "BRL" },
          referenceExternalTransactionId: "never-arrives",
        }),
      });
      expect(orphanRes.status).toBe(202);

      // Now BET arrives -> balance drops to 60.00
      const betRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prov-ooo:bet-ooo-1" },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: "bet-ooo-1",
          playerId: "p-ooo",
          walletId,
          roundId: "r-ooo",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "40.00", currency: "BRL" },
        }),
      });
      expect(betRes.status).toBe(201);
    } finally {
      await app.stop();
    }

    // Run PendingReferenceWorker deterministically
    process.env.SQS_CONSUMER_ENABLED = "false";
    process.env.OUTBOX_WORKER_ENABLED = "false";
    process.env.PENDING_REFERENCE_WORKER_ENABLED = "false";
    const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      const worker = ctx.get(PendingReferenceWorker);
      // Force next_retry_at to now so we don't have to sleep for backoff in test
      await orm.em.getConnection().execute(`UPDATE wager_transactions SET next_retry_at = NOW() WHERE status = 'PENDING_REFERENCE'`);
      const resolved = await worker.processDueBatch(10, 1);
      expect(resolved).toBe(2); // ref-1 -> PROCESSED, rb-orphan -> REJECTED (REFERENCE_NOT_FOUND)
    } finally {
      await ctx.close();
    }

    const checkApp = await startAppProcess(3139);
    try {
      const refundTx = (await (
        await fetch(`${checkApp.baseUrl}/providers/prov-ooo/wagering/transactions/ref-1`)
      ).json()) as { status: string };
      expect(refundTx.status).toBe("PROCESSED");

      const orphanTx = (await (
        await fetch(`${checkApp.baseUrl}/providers/prov-ooo/wagering/transactions/rb-orphan`)
      ).json()) as { status: string; failureCode: string };
      expect(orphanTx.status).toBe("REJECTED");
      expect(orphanTx.failureCode).toBe("REFERENCE_NOT_FOUND");

      await assertReconciled(checkApp.baseUrl, walletId, "100.00");
    } finally {
      await checkApp.stop();
    }
  });

  it("8. preserves full consistency and drains outbox across service restarts", async () => {
    const app1 = await startAppProcess(3140, { OUTBOX_WORKER_ENABLED: "false" });
    let walletId: string;
    try {
      walletId = await createWallet(app1.baseUrl, "p-restart", "300.00");
      await fetch(`${app1.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prov-rst:1" },
        body: JSON.stringify({
          providerId: "prov-rst",
          externalTransactionId: "1",
          playerId: "p-restart",
          walletId,
          roundId: "r-rst",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "50.00", currency: "BRL" },
        }),
      });
    } finally {
      await app1.stop();
    }

    const app2 = await startAppProcess(3141, {
      OUTBOX_WORKER_ENABLED: "true",
      OUTBOX_POLL_INTERVAL_MS: "100",
    });
    try {
      const readyRes = await fetch(`${app2.baseUrl}/health/ready`);
      expect(readyRes.status).toBe(200);

      await Bun.sleep(600);
      const pendingRows = await orm.em
        .getConnection()
        .execute<Array<{ cnt: string }>>(`SELECT COUNT(*)::text AS cnt FROM outbox_messages WHERE published_at IS NULL`);
      expect(Number(pendingRows[0]!.cnt)).toBe(0);

      await assertReconciled(app2.baseUrl, walletId, "250.00");
    } finally {
      await app2.stop();
    }
  });
});
