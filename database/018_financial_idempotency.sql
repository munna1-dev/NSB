-- NorthStarBank financial idempotency repair.
-- Nullable keys preserve compatibility with existing records.

ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency
  ON transfers (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency
  ON payments (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
