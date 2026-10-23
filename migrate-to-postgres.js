// One-off: copy players and sessions from the JSON file into Postgres.
// Usage: DATABASE_URL=postgres://... node migrate-to-postgres.js [data/db.json]
// Safe to re-run: rows are upserted, nothing in Postgres is deleted.
const path = require('path');
const { openStore } = require('./store');

(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL first');
  const src = await openStore({ file: path.resolve(process.argv[2] || 'data/db.json') });
  const dst = await openStore({ databaseUrl });
  for (const [id, p] of Object.entries(src.players)) { dst.players[id] = p; dst.touch(id); }
  await dst.flush();
  for (const [hash, id] of Object.entries(src.sessions)) await dst.addSession(hash, id);
  console.log(`copied ${Object.keys(src.players).length} players, ${Object.keys(src.sessions).length} sessions`);
  await dst.close();
})().catch(e => { console.error(e.message); process.exit(1); });
