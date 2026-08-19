-- 006_payout_watch.sql
-- Persistent baseline state for the automatic payout trigger. Each watched
-- pool stores its last observed wallet balance so a restart can never
-- double-distribute a payout (a payout is only fired on an INCREASE from
-- this baseline).
CREATE TABLE IF NOT EXISTS payout_watch (
    pool VARCHAR(20) PRIMARY KEY,
    last_balance NUMERIC(30, 12) NOT NULL DEFAULT 0,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    last_payout_amount NUMERIC(30, 12),
    last_payout_at TIMESTAMP WITH TIME ZONE
);
