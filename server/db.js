const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v);              // DATE  -> 'YYYY-MM-DD' string
types.setTypeParser(20, (v) => parseInt(v, 10));  // INT8  -> number

function makePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 10,   // keep this small (3) on serverless hosts
    idleTimeoutMillis: 10000,        // close idle connections before Neon closes them for us
    connectionTimeoutMillis: 20000,  // give a sleeping Neon database time to wake up
    keepAlive: true
  });
  // Neon drops idle connections and restarts its compute from time to time. node-postgres reports
  // that as an 'error' event on the pool. With no listener Node treats it as fatal and the whole
  // server crashes, which is what was happening. The pool discards the dead connection by itself.
  pool.on('error', (err) => console.error('Idle database connection dropped (safe to ignore):', err.message));
  return pool;
}

async function migrate(pool) {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
module.exports = { makePool, migrate, withTx };
