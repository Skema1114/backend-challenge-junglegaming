import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
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
  WAGER_DLQ_URL,
} from "../helpers/test-harness";

describe("Integration: PostgreSQL + LocalStack SQS", () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let app: SpawnedApp;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    sqs = createTestSqsClient();
    app = await startAppProcess(3110, {
      INSTANCE_ID: "integration-1",
      SQS_CONSUMER_ENABLED: "true",
      OUTBOX_WORKER_ENABLED: "true",
      PENDING_REFERENCE_WORKER_ENABLED: "true",
      OUTBOX_POLL_INTERVAL_MS: "100",
      PENDING_REF_POLL_INTERVAL_MS: "200",
    });
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await drainSqsQueues(sqs);
  });

  afterAll(async () => {
    await app.stop();
    await orm.close(true);
  });

  it("enforces database-level immutability on ledger and non-negativity on wallets", async () => {
    const createRes = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-db-check",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(createRes.status).toBe(201);
    const wallet = (await createRes.json()) as { id: string };

    // Duplicate wallet for same player + currency must conflict
    const dupWalletRes = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-db-check",
        initialBalance: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(dupWalletRes.status).toBe(409);

    // Trigger must block UPDATE/DELETE on wallet_ledger_entries
    await expect(
      orm.em.getConnection().execute(`UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = ?`, [wallet.id]),
    ).rejects.toThrow();

    await expect(
      orm.em.getConnection().execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id]),
    ).rejects.toThrow();

    // Check constraint must block negative balance in wallets
    await expect(
      orm.em.getConnection().execute(`UPDATE wallets SET balance = -1.00 WHERE id = ?`, [wallet.id]),
    ).rejects.toThrow();
  });

  it("handles BET, WIN, LOSS, REFUND, ROLLBACK, idempotency replay, cursor pagination, and reconciliation", async () => {
    const createRes = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-1",
        initialBalance: { amount: "1000.00", currency: "BRL" },
      }),
    });
    expect(createRes.status).toBe(201);
    const wallet = (await createRes.json()) as { id: string; version: number };
    expect(wallet.version).toBe(1);

    // 1. BET 100.00 -> balance 900.00, version 2
    const betPayload = {
      providerId: "provider-a",
      externalTransactionId: "tx-bet-1",
      playerId: "player-1",
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "100.00", currency: "BRL" },
    };
    const betRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-1",
      },
      body: JSON.stringify(betPayload),
    });
    expect(betRes.status).toBe(201);
    const betBody = (await betRes.json()) as { transactionId: string; status: string; balance: { amount: string }; idempotentReplay: boolean };
    expect(betBody.status).toBe("PROCESSED");
    expect(betBody.balance.amount).toBe("900.00");
    expect(betBody.idempotentReplay).toBe(false);

    // 2. WIN 50.00 -> balance 950.00, version 3
    const winRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-win-1",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-win-1",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "WIN",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(winRes.status).toBe(201);
    const winBody = (await winRes.json()) as { balance: { amount: string } };
    expect(winBody.balance.amount).toBe("950.00");

    // 3. LOSS 20.00 -> no balance change, no version increment, no ledger entry
    const lossRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-loss-1",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-loss-1",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-2",
        gameId: "fortune-chimp",
        kind: "LOSS",
        money: { amount: "20.00", currency: "BRL" },
      }),
    });
    expect(lossRes.status).toBe(201);
    const walletAfterLoss = (await (await fetch(`${app.baseUrl}/wallets/${wallet.id}`)).json()) as {
      version: number;
      balance: { amount: string };
    };
    expect(walletAfterLoss.balance.amount).toBe("950.00");
    expect(walletAfterLoss.version).toBe(3);

    // 4. Idempotent replay of BET returns observed balance 900.00, NOT current 950.00
    const replayRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-1",
      },
      body: JSON.stringify(betPayload),
    });
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as { idempotentReplay: boolean; balance: { amount: string } };
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.balance.amount).toBe("900.00");

    // 5. Same Idempotency-Key with divergent payload -> 409 Conflict
    const conflictRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-1",
      },
      body: JSON.stringify({
        ...betPayload,
        money: { amount: "101.00", currency: "BRL" },
      }),
    });
    expect(conflictRes.status).toBe(409);

    // 6. REFUND of BET 100.00 -> 1050.00, second REFUND of same BET -> 422 ALREADY_REVERSED
    const refundRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-refund-1",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-refund-1",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "100.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(refundRes.status).toBe(201);
    expect(((await refundRes.json()) as { balance: { amount: string } }).balance.amount).toBe("1050.00");

    const dupRefundRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-refund-2",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-refund-2",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "100.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(dupRefundRes.status).toBe(422);
    expect(((await dupRefundRes.json()) as { failureCode: string }).failureCode).toBe("ALREADY_REVERSED");

    // 7. Reversal that would cause negative balance gets distinct failureCode
    const bigBetRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-big",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-bet-big",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-3",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "1030.00", currency: "BRL" },
      }),
    });
    expect(bigBetRes.status).toBe(201); // balance now 20.00

    const rollbackWinRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-rb-win",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-rb-win",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "ROLLBACK",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-win-1",
      }),
    });
    expect(rollbackWinRes.status).toBe(422);
    expect(((await rollbackWinRes.json()) as { failureCode: string }).failureCode).toBe(
      "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
    );

    // 8. Cursor pagination across ledger (5 entries: OPENING, BET, WIN, REFUND, BET_BIG)
    const p1 = (await (await fetch(`${app.baseUrl}/wallets/${wallet.id}/ledger?limit=3`)).json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(p1.items.length).toBe(3);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = (await (
      await fetch(`${app.baseUrl}/wallets/${wallet.id}/ledger?cursor=${encodeURIComponent(p1.nextCursor!)}&limit=3`)
    ).json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(p2.items.length).toBe(2);
    expect(p2.nextCursor).toBeNull();

    // 9. Reconciliation confirms exact match
    const recRes = await fetch(`${app.baseUrl}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(recRes.status).toBe(200);
    const rec = (await recRes.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
      checkedEntries: number;
    };
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("20.00");
    expect(rec.calculatedBalance.amount).toBe("20.00");
    expect(rec.checkedEntries).toBe(5);

    // 10. Currency mismatch rejected
    const usdRes = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-usd",
      },
      body: JSON.stringify({
        ...betPayload,
        externalTransactionId: "tx-usd",
        money: { amount: "10.00", currency: "USD" },
      }),
    });
    expect(usdRes.status).toBe(422);
    expect(((await usdRes.json()) as { failureCode: string }).failureCode).toBe("CURRENCY_MISMATCH");
  });

  it("consumes SQS messages via inbox deduplication, publishes outbox events, and routes malformed payloads to DLQ", async () => {
    const createRes = await fetch(`${app.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-sqs",
        initialBalance: { amount: "200.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };

    const msgPayload = {
      messageId: "sqs-msg-1",
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider-sqs",
        externalTransactionId: "ext-sqs-1",
        idempotencyKey: "provider-sqs:ext-sqs-1",
        playerId: "player-sqs",
        walletId: wallet.id,
        roundId: "round-sqs-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "45.00", currency: "BRL" },
      },
    };

    // Send twice with distinct deduplicationIds to simulate at-least-once redelivery
    await sendWagerToSqs(sqs, msgPayload, wallet.id, "dedup-1a");
    await sendWagerToSqs(sqs, msgPayload, wallet.id, "dedup-1b");

    // Send malformed payload to trigger DLQ routing
    await sendWagerToSqs(sqs, { invalid: true }, "malformed", "dedup-bad");

    // Wait for consumer and outbox worker
    let balance = "200.00";
    for (let i = 0; i < 30; i++) {
      const w = (await (await fetch(`${app.baseUrl}/wallets/${wallet.id}`)).json()) as {
        balance: { amount: string };
      };
      balance = w.balance.amount;
      if (balance === "155.00") break;
      await Bun.sleep(200);
    }
    expect(balance).toBe("155.00");

    // Wait briefly for second redelivery + DLQ + outbox publish
    await Bun.sleep(1000);

    const dlqMessages = await receiveAllFromQueue(sqs, WAGER_DLQ_URL, 2000);
    expect(dlqMessages.length).toBe(1);
    expect(dlqMessages[0]!.body).toContain("invalid");

    const outboxEvents = await receiveAllFromQueue(sqs, OUTBOX_QUEUE_URL, 2000);
    const eventTypes = outboxEvents.map((e) => (JSON.parse(e.body) as { eventType: string }).eventType);
    expect(eventTypes).toContain("WagerTransactionProcessed");
    expect(eventTypes).toContain("WalletBalanceChanged");

    const rec = (await (
      await fetch(`${app.baseUrl}/wallets/${wallet.id}/reconciliation`, { method: "POST" })
    ).json()) as { consistent: boolean };
    expect(rec.consistent).toBe(true);
  });
});
