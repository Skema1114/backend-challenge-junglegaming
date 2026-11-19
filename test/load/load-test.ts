import { buildMikroOrmConfig } from "../../mikro-orm.config";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  createTestSqsClient,
  drainSqsQueues,
  resetDatabase,
  startAppProcess,
} from "../helpers/test-harness";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx]!.toFixed(2));
}

async function main() {
  const orm = await MikroORM.init(buildMikroOrmConfig());
  await orm.getMigrator().up();
  const sqs = createTestSqsClient();
  await resetDatabase(orm);
  await drainSqsQueues(sqs);

  const apps = await Promise.all([
    startAppProcess(3151, { INSTANCE_ID: "load-1", OUTBOX_WORKER_ENABLED: "true", OUTBOX_POLL_INTERVAL_MS: "100" }),
    startAppProcess(3152, { INSTANCE_ID: "load-2", OUTBOX_WORKER_ENABLED: "true", OUTBOX_POLL_INTERVAL_MS: "100" }),
    startAppProcess(3153, { INSTANCE_ID: "load-3", OUTBOX_WORKER_ENABLED: "true", OUTBOX_POLL_INTERVAL_MS: "100" }),
  ]);

  try {
    const walletCount = 12;
    const wallets: Array<{ id: string; playerId: string }> = [];
    for (let i = 0; i < walletCount; i++) {
      const playerId = `load-player-${i}`;
      const res = await fetch(`${apps[0]!.baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: i < 2 ? "500.00" : "5000.00", currency: "BRL" },
        }),
      });
      const body = (await res.json()) as { id: string };
      wallets.push({ id: body.id, playerId });
    }

    const totalRequests = 300;
    const concurrency = 24;
    const latencies: number[] = [];
    const statusCounts: Record<number, number> = {};
    let unexpectedErrors = 0;

    let nextIdx = 0;
    const startWall = performance.now();

    async function worker() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= totalRequests) break;

        const isReplay = idx % 15 === 0 && idx > 0;
        const txIdx = isReplay ? idx - 1 : idx;
        // First 2 wallets receive heavy contention (hot wallets)
        const targetWallet =
          txIdx % 3 === 0 ? wallets[txIdx % 2]! : wallets[2 + (txIdx % (walletCount - 2))]!;
        const targetApp = apps[idx % apps.length]!;

        const kind = txIdx % 5 === 0 ? "WIN" : txIdx % 7 === 0 ? "LOSS" : "BET";
        const amount = kind === "WIN" ? "12.50" : "10.00";

        const t0 = performance.now();
        try {
          const res = await fetch(`${targetApp.baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `load-prov:tx-${txIdx}`,
            },
            body: JSON.stringify({
              providerId: "load-prov",
              externalTransactionId: `tx-${txIdx}`,
              playerId: targetWallet.playerId,
              walletId: targetWallet.id,
              roundId: `round-${txIdx}`,
              gameId: "fortune-chimp",
              kind,
              money: { amount, currency: "BRL" },
            }),
          });
          latencies.push(performance.now() - t0);
          statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
          if (res.status >= 500) {
            unexpectedErrors += 1;
          }
        } catch {
          latencies.push(performance.now() - t0);
          unexpectedErrors += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const durationMs = performance.now() - startWall;

    // Wait briefly for outbox workers to drain
    await Bun.sleep(1000);

    const outboxStatsRows = await orm.em
      .getConnection()
      .execute<Array<{ pending: string; total: string }>>(
        `SELECT
           COUNT(*) FILTER (WHERE published_at IS NULL)::text AS pending,
           COUNT(*)::text AS total
         FROM outbox_messages`,
      );

    let lockConflictsTotal = 0;
    let duplicatesTotal = 0;
    for (const a of apps) {
      const m = (await (await fetch(`${a.baseUrl}/metrics/json`)).json()) as {
        lockConflicts: number;
        duplicatesDetected: number;
      };
      lockConflictsTotal += m.lockConflicts;
      duplicatesTotal += m.duplicatesDetected;
    }

    let consistentWallets = 0;
    for (const w of wallets) {
      const rec = (await (
        await fetch(`${apps[0]!.baseUrl}/wallets/${w.id}/reconciliation`, { method: "POST" })
      ).json()) as { consistent: boolean };
      if (rec.consistent) consistentWallets += 1;
    }

    latencies.sort((a, b) => a - b);
    const report = {
      environment: {
        instances: apps.length,
        concurrency,
        wallets: walletCount,
        hotWallets: 2,
      },
      requests: totalRequests,
      durationMs: Number(durationMs.toFixed(2)),
      throughputRps: Number(((totalRequests / durationMs) * 1000).toFixed(2)),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: Number((latencies[latencies.length - 1] ?? 0).toFixed(2)),
      },
      statusCounts,
      unexpectedErrorRate: Number(((unexpectedErrors / totalRequests) * 100).toFixed(2)),
      duplicatesDetected: duplicatesTotal,
      lockConflicts: lockConflictsTotal,
      outbox: {
        totalEvents: Number(outboxStatsRows[0]!.total),
        pendingAfter1s: Number(outboxStatsRows[0]!.pending),
      },
      reconciliation: {
        consistentWallets,
        totalWallets: walletCount,
      },
    };

    console.log(JSON.stringify(report, null, 2));

    if (unexpectedErrors > 0 || consistentWallets !== walletCount) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(apps.map((a) => a.stop()));
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
