// Persistence. All data is held in memory (one game server); this module loads it at boot and writes changes.
// DATABASE_URL set -> Postgres (players + sessions tables); otherwise a JSON file for dev.
const fs = require('fs');

const FLUSH_MS = 1000;

async function openStore({ databaseUrl, file }) {
  return databaseUrl ? openPostgres(databaseUrl) : openFile(file);
}

function openFile(file) {
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { players: {}, sessions: {} };
  let timer = null;
  const flush = async () => {
    clearTimeout(timer); timer = null;
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file); // atomic replace so a crash can't truncate the file
  };
  const soon = () => { timer ??= setTimeout(flush, FLUSH_MS); };
  return {
    players: data.players,
    sessions: data.sessions,
    touch: soon,
    addSession: async (hash, id) => { data.sessions[hash] = id; soon(); },
    removeSession: async hash => { delete data.sessions[hash]; soon(); },
    flush,
    close: flush,
  };
}

async function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5 });
  pool.on('error', e => console.error('pg pool error', e.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    player_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`);
  const players = Object.fromEntries((await pool.query('SELECT id, data FROM players')).rows.map(r => [r.id, r.data]));
  const sessions = Object.fromEntries((await pool.query('SELECT token_hash, player_id FROM sessions')).rows.map(r => [r.token_hash, r.player_id]));

  // Changed players are batched into one upsert per second. A failed write keeps the ids dirty for the next try.
  const dirty = new Set();
  let timer = null, running = Promise.resolve();
  const flush = () => (running = running.then(async () => {
    clearTimeout(timer); timer = null;
    if (!dirty.size) return;
    const ids = [...dirty];
    dirty.clear();
    try {
      await pool.query(
        `INSERT INTO players (id, data) SELECT * FROM unnest($1::text[], $2::jsonb[])
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [ids, ids.map(id => JSON.stringify(players[id]))]);
    } catch (e) {
      ids.forEach(id => dirty.add(id));
      timer ??= setTimeout(flush, FLUSH_MS * 5);
      console.error('pg flush failed, will retry:', e.message);
    }
  }));

  return {
    players,
    sessions,
    touch(id) { dirty.add(id); timer ??= setTimeout(flush, FLUSH_MS); },
    async addSession(hash, id) {
      sessions[hash] = id;
      await pool.query('INSERT INTO sessions (token_hash, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [hash, id]);
    },
    async removeSession(hash) {
      delete sessions[hash];
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
    },
    flush,
    async close() { await flush(); await pool.end(); },
  };
}

module.exports = { openStore };
