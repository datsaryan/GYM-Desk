const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v);              // DATE  -> 'YYYY-MM-DD' string
types.setTypeParser(20, (v) => parseInt(v, 10));  // INT8  -> number

function makePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
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
