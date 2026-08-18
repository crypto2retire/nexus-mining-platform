const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

// SSL handling:
//   - DATABASE_SSL=false  -> never use SSL (local Postgres, droplet-local Postgres)
//   - production          -> SSL with relaxed cert check (managed cloud Postgres)
//   - otherwise           -> whatever the connection string implies
function sslConfig() {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.NODE_ENV === 'production') return { rejectUnauthorized: false };
  return undefined;
}

const pool = new Pool({
  connectionString,
  ...(sslConfig() === undefined ? {} : { ssl: sslConfig() }),
});

module.exports = { pool };
