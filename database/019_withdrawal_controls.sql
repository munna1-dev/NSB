-- NorthStarBank withdrawal controls and idempotency.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS withdrawals_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS withdrawal_limit NUMERIC(18,2);

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_withdrawal_limit_nonnegative;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_withdrawal_limit_nonnegative
  CHECK (withdrawal_limit IS NULL OR withdrawal_limit >= 0);

-- Prevent duplicate withdrawal idempotency keys for the same account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawal_idempotency
  ON transactions (account_id, (metadata->>'idempotencyKey'))
  WHERE transaction_type = 'withdrawal'
    AND metadata ? 'idempotencyKey';
