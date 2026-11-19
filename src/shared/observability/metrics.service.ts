import { Injectable } from "@nestjs/common";

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus = new Map<string, number>();
  private duplicatesDetected = 0;
  private retries = 0;
  private dlqMessages = 0;
  private lockConflicts = 0;
  private reconciliationDivergences = 0;
  private outboxLagMs = 0;
  private outboxPendingCount = 0;
  private latencyCount = 0;
  private latencySumMs = 0;
  private latencyMaxMs = 0;

  incTransactionStatus(status: string): void {
    this.transactionsByStatus.set(status, (this.transactionsByStatus.get(status) ?? 0) + 1);
  }

  incDuplicate(): void {
    this.duplicatesDetected += 1;
  }

  incRetry(): void {
    this.retries += 1;
  }

  incDlq(): void {
    this.dlqMessages += 1;
  }

  incLockConflict(): void {
    this.lockConflicts += 1;
  }

  incReconciliationDivergence(): void {
    this.reconciliationDivergences += 1;
  }

  setOutboxLag(lagMs: number, pendingCount: number): void {
    this.outboxLagMs = Math.max(0, lagMs);
    this.outboxPendingCount = Math.max(0, pendingCount);
  }

  observeLatency(durationMs: number): void {
    this.latencyCount += 1;
    this.latencySumMs += durationMs;
    if (durationMs > this.latencyMaxMs) {
      this.latencyMaxMs = durationMs;
    }
  }

  snapshot() {
    return {
      transactionsByStatus: Object.fromEntries(this.transactionsByStatus.entries()),
      duplicatesDetected: this.duplicatesDetected,
      retries: this.retries,
      dlqMessages: this.dlqMessages,
      lockConflicts: this.lockConflicts,
      reconciliationDivergences: this.reconciliationDivergences,
      outboxLagMs: this.outboxLagMs,
      outboxPendingCount: this.outboxPendingCount,
      latency: {
        count: this.latencyCount,
        avgMs: this.latencyCount > 0 ? Number((this.latencySumMs / this.latencyCount).toFixed(2)) : 0,
        maxMs: Number(this.latencyMaxMs.toFixed(2)),
      },
    };
  }

  toPrometheusText(): string {
    const lines: string[] = [
      "# TYPE wagering_transactions_total counter",
    ];
    for (const [status, count] of this.transactionsByStatus.entries()) {
      lines.push(`wagering_transactions_total{status="${status}"} ${count}`);
    }
    lines.push(
      "# TYPE wagering_duplicates_total counter",
      `wagering_duplicates_total ${this.duplicatesDetected}`,
      "# TYPE wagering_retries_total counter",
      `wagering_retries_total ${this.retries}`,
      "# TYPE wagering_dlq_messages_total counter",
      `wagering_dlq_messages_total ${this.dlqMessages}`,
      "# TYPE wagering_lock_conflicts_total counter",
      `wagering_lock_conflicts_total ${this.lockConflicts}`,
      "# TYPE wagering_reconciliation_divergences_total counter",
      `wagering_reconciliation_divergences_total ${this.reconciliationDivergences}`,
      "# TYPE wagering_outbox_lag_ms gauge",
      `wagering_outbox_lag_ms ${this.outboxLagMs}`,
      "# TYPE wagering_outbox_pending_count gauge",
      `wagering_outbox_pending_count ${this.outboxPendingCount}`,
      "# TYPE wagering_processing_latency_ms_sum counter",
      `wagering_processing_latency_ms_sum ${this.latencySumMs}`,
      "# TYPE wagering_processing_latency_ms_count counter",
      `wagering_processing_latency_ms_count ${this.latencyCount}`,
    );
    return lines.join("\n") + "\n";
  }
}
