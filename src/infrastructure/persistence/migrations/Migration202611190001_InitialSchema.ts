import { Migration } from "@mikro-orm/migrations";

export class Migration202611190001_InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(128) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(19, 2) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(128) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id VARCHAR(128) NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255) NULL,
        reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
        status VARCHAR(32) NOT NULL,
        failure_code VARCHAR(64) NULL,
        observed_balance_amount NUMERIC(19, 2) NULL,
        observed_balance_currency CHAR(3) NULL,
        pending_attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT chk_wager_tx_amount_non_negative CHECK (amount >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_processed_reversal
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED'
          AND kind IN ('REFUND', 'ROLLBACK')
          AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_pending_reference
        ON wager_transactions (next_retry_at, created_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_wallet_created
        ON wager_transactions (wallet_id, created_at DESC);
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(16) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(19, 2) NOT NULL,
        balance_after NUMERIC(19, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_ledger_wallet_tx UNIQUE (wallet_id, transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after)
          OR
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_id_cursor
        ON wallet_ledger_entries (wallet_id, created_at ASC, id ASC);
    `);

    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only and immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW
        EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(128) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_pending
        ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
