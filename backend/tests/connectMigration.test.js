const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '../../database/migrations/026_connect_orders.sql'
);

function migrationSql() {
  return fs.readFileSync(migrationPath, 'utf8');
}

test('migration 026 defines the additive Connect state machine', () => {
  const sql = migrationSql();

  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS connect_orders/i);
  expect(sql).toMatch(/request_id VARCHAR\(64\) UNIQUE NOT NULL/i);
  expect(sql).toMatch(/target_pool IN \('KASPA',\s*'ZCASH',\s*'BTC'\)/i);
  expect(sql).toMatch(/length_hours IN \(1,\s*3,\s*6,\s*12,\s*24,\s*48,\s*72\)/i);
  expect(sql).toMatch(/processing_lease_until TIMESTAMPTZ/i);
  expect(sql).toMatch(/rent_attempts INT NOT NULL DEFAULT 0/i);
  expect(sql).toMatch(/last_attempt_at TIMESTAMPTZ/i);
  expect(sql).toMatch(/'FAILED_REVIEW'/i);
  expect(sql).toMatch(
    /ADD COLUMN IF NOT EXISTS connect_order_id UUID REFERENCES connect_orders\(id\)/i
  );
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_connect_orders_user/i);
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_connect_orders_status/i);
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_protocol_revenue_connect_order/i);
});

test('migration 026 changes no pre-existing table except the revenue-ledger link', () => {
  const sql = migrationSql();
  const alteredTables = [...sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_]+)/gi)]
    .map((match) => match[1].toLowerCase());

  expect(alteredTables).toEqual(['protocol_revenue_ledger']);
});
