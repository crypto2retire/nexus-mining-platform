-- 012_miner_push.sql — outbound miner push architecture (2026-08-19)
--
-- Removes the reverse-SSH-tunnel dependency for the Live Miner panel and
-- miner controls. The Mac's miner agent pushes status to the droplet over
-- outbound HTTPS and polls this queue for start/stop/switch commands.
-- The tunnel (com.nexus.miner-tunnel) becomes optional.

CREATE TABLE IF NOT EXISTS miner_commands (
  id           SERIAL PRIMARY KEY,
  action       TEXT NOT NULL,                  -- 'start' | 'stop' | 'switch'
  params       JSONB NOT NULL DEFAULT '{}',    -- e.g. {"symbol":"ZEC"}
  status       TEXT NOT NULL DEFAULT 'pending',-- pending | done | failed
  result       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_miner_commands_pending ON miner_commands (status, id);
