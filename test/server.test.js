const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { io } = require('socket.io-client');
const { start } = require('../server');
const G = require('../game');

const tmpFile = () => path.join(os.tmpdir(), `duel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
const get = (port, url, headers = {}) => new Promise((resolve, reject) =>
  http.get({ port, path: url, headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c)).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject));

function client(port) {
  const s = io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
  s.call = (ev, arg = {}) => new Promise(r => s.emit(ev, arg, r));
  s.next = ev => new Promise(r => s.once(ev, r));
  return s;
}
async function guest(port, name) {
  const s = client(port);
  const res = await s.call('guest', { name });
  assert.ok(res.token, JSON.stringify(res));
  return Object.assign(s, { token: res.token, me: res.me });
}

test('http: compression, etag, 404, health, socket.io client', async t => {
  const app = await start({ port: 0, file: tmpFile() });
  t.after(() => app.close());
  const raw = await get(app.port, '/');
  assert.strictEqual(raw.status, 200);
  assert.match(raw.body.toString(), /HanziDuel/);
  assert.doesNotMatch(raw.body.toString(), /%GOOGLE_CLIENT_ID%/);
  assert.strictEqual(raw.headers['x-content-type-options'], 'nosniff');
  const br = await get(app.port, '/', { 'accept-encoding': 'gzip, br' });
  assert.strictEqual(br.headers['content-encoding'], 'br');
  assert.ok(br.body.length < raw.body.length / 3);
  assert.strictEqual(zlib.brotliDecompressSync(br.body).toString(), raw.body.toString());
  const gz = await get(app.port, '/', { 'accept-encoding': 'gzip' });
  assert.strictEqual(zlib.gunzipSync(gz.body).toString(), raw.body.toString());
  assert.strictEqual((await get(app.port, '/', { 'if-none-match': raw.headers.etag })).status, 304);
  assert.strictEqual((await get(app.port, '/nope')).status, 404);
  assert.strictEqual((await get(app.port, '/../server.js')).status, 404);
  assert.strictEqual((await get(app.port, '/healthz')).body.toString(), 'ok');
  assert.strictEqual((await get(app.port, '/socket.io/socket.io.min.js')).status, 200);
});

test('google mode: client id injected, guest login refused', async t => {
  const app = await start({ port: 0, file: tmpFile(), clientId: 'abc.apps.googleusercontent.com' });
  t.after(() => app.close());
  assert.match((await get(app.port, '/')).body.toString(), /abc\.apps\.googleusercontent\.com/);
  const s = client(app.port);
  t.after(() => s.close());
  assert.ok((await s.call('guest', { name: 'x' })).error);
  assert.ok((await s.call('login', { credential: 'not-a-jwt' })).error);
  assert.ok((await s.call('login', {})).error);
});

test('accounts: resume, bad input, logout, rename, kick on second login', async t => {
  const app = await start({ port: 0, file: tmpFile() });
  t.after(() => app.close());
  const a = await guest(app.port, '  Alice  ');
  t.after(() => a.close());
  assert.strictEqual(a.me.name, 'Alice');
  assert.strictEqual(a.me.rating, G.START_RATING);

  const anon = client(app.port);
  t.after(() => anon.close());
  for (const [ev, arg] of [['learn', { level: 1 }], ['practice', { level: 1 }], ['progress'], ['rename', { name: 'x' }], ['learned', { h: '爱', known: true }]])
    assert.strictEqual((await anon.call(ev, arg)).error, 'Chưa đăng nhập', ev);
  assert.ok((await anon.call('guest', { name: '   ' })).error);
  assert.ok((await anon.call('guest', { name: 123 })).error);
  assert.ok((await anon.call('resume', { token: 'bogus' })).error);
  assert.ok((await anon.call('resume', null)).error);
  assert.ok(Array.isArray(await anon.call('leaderboard')));

  assert.ok((await a.call('rename', { name: '' })).error);
  assert.strictEqual((await a.call('rename', { name: 'A'.repeat(50) })).me.name.length, 20);

  // Same account in a second tab: the first is kicked.
  const b = client(app.port);
  t.after(() => b.close());
  const kicked = a.next('kicked');
  assert.strictEqual((await b.call('resume', { token: a.token })).me.name, 'A'.repeat(20));
  await kicked;

  await b.call('logout', { token: a.token });
  const c = client(app.port);
  t.after(() => c.close());
  assert.ok((await c.call('resume', { token: a.token })).error, 'token revoked after logout');
});

test('learn, progress and practice', async t => {
  const app = await start({ port: 0, file: tmpFile() });
  t.after(() => app.close());
  const s = await guest(app.port, 'learner');
  t.after(() => s.close());
  const first = await s.call('learn', { level: 1 });
  assert.strictEqual(first.words.length, 10);
  assert.strictEqual(first.learned, 0);
  assert.ok(first.words.every(w => w.vi !== undefined && w.m));
  assert.deepStrictEqual((await s.call('learned', { h: first.words[0].h, known: true })), {});
  assert.deepStrictEqual((await s.call('learned', { h: first.words[0].h, known: true })), {}, 'idempotent');
  const next = await s.call('learn', { level: 1 });
  assert.strictEqual(next.learned, 1);
  assert.ok(!next.words.some(w => w.h === first.words[0].h));
  const prog = await s.call('progress');
  assert.strictEqual(prog.learned[1], 1);
  assert.strictEqual(prog.total[1], first.total);
  await s.call('learned', { h: first.words[0].h, known: false });
  assert.strictEqual((await s.call('progress')).learned[1], 0);
  for (const bad of [{ h: 'không phải từ', known: true }, { h: { x: 1 }, known: true }, {}])
    assert.ok((await s.call('learned', bad)).error);
  for (const level of [0, 8, 1.5, '3', null]) {
    assert.ok((await s.call('practice', { level })).error, `practice ${level}`);
    assert.ok((await s.call('learn', { level })).error, `learn ${level}`);
  }
  const q = await s.call('practice', { level: 7 });
  assert.strictEqual(q.level, 7);
  assert.strictEqual(q.type, 'Hán → Việt');
});

test('pvp: full match, answers validated, elo applied and persisted', { timeout: 60000 }, async t => {
  const file = tmpFile();
  let app = await start({ port: 0, file });
  const [a, b] = await Promise.all([guest(app.port, 'bot-a'), guest(app.port, 'bot-b')]);
  t.after(() => { a.close(); b.close(); });
  const startA = a.next('start');
  a.emit('queue'); a.emit('queue'); // double queue is harmless
  b.emit('queue');
  const st = await startA;
  assert.strictEqual(st.opponent.name, 'bot-b');
  assert.strictEqual(st.hsk, 1);
  a.emit('answer', 0); // before any question: ignored

  // A picks 0; B first sends junk (must be ignored) then picks 1, then tries to change its answer.
  let questions = 0, aCorrect = 0, bCorrect = 0;
  a.on('question', q => {
    questions++;
    assert.ok(!('answer' in q) && !('word' in q), 'answer must not be sent during the round');
    a.emit('answer', 0);
  });
  b.on('question', () => { for (const junk of [7, -1, '1', 1.5, null]) b.emit('answer', junk); b.emit('answer', 1); b.emit('answer', 0); });
  a.on('reveal', r => { if (r.you === r.answer) aCorrect++; assert.strictEqual(r.you, 0); assert.strictEqual(r.opp, 1); });
  b.on('reveal', r => { if (r.you === r.answer) bCorrect++; assert.strictEqual(r.you, 1, 'first valid answer is final'); });
  const oppSeen = b.next('oppAnswered');
  const [ea, eb] = await Promise.all([a.next('end'), b.next('end')]);
  await oppSeen;
  assert.strictEqual(questions, G.ROUNDS);
  assert.strictEqual(ea.score > 0, aCorrect > 0);
  assert.strictEqual(eb.score > 0, bCorrect > 0);
  assert.ok(ea.score <= aCorrect * 100 && ea.score >= aCorrect * 50);
  assert.strictEqual(ea.delta + eb.delta, 0);
  assert.strictEqual(ea.result + eb.result, 1);
  const ratingA = ea.me.rating;
  await app.close();

  // Restart on the same file: rating survived.
  app = await start({ port: 0, file });
  t.after(() => app.close());
  const a2 = client(app.port);
  t.after(() => a2.close());
  assert.strictEqual((await a2.call('resume', { token: a.token })).me.rating, ratingA);
});

test('pvp: leaving mid-match forfeits', { timeout: 30000 }, async t => {
  const app = await start({ port: 0, file: tmpFile() });
  t.after(() => app.close());
  const [a, b] = await Promise.all([guest(app.port, 'stay'), guest(app.port, 'leave')]);
  t.after(() => a.close());
  const qA = a.next('question');
  a.emit('queue'); b.emit('queue');
  await qA;
  b.close();
  const end = await a.next('end');
  assert.strictEqual(end.result, 1);
  assert.strictEqual(end.forfeit, true);
  assert.strictEqual(end.left, false);
  assert.strictEqual(end.delta, 16);
  const board = await a.call('leaderboard');
  assert.strictEqual(board[0].name, 'stay');
  assert.strictEqual(board[0].pid, end.me.pid);
});

test('postgres store: data survives restart (PGlite over the wire)', { timeout: 60000 }, async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  // Default is 1 connection; the app's pool opens several in parallel, as against a real server.
  const pgsrv = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 20 });
  await pgsrv.start();
  t.after(async () => { await pgsrv.stop(); await db.close(); });
  const databaseUrl = `postgres://postgres@127.0.0.1:${pgsrv.port}/postgres`;

  let app = await start({ port: 0, databaseUrl });
  const s = await guest(app.port, 'pg-user');
  const w = (await s.call('learn', { level: 2 })).words[0];
  await s.call('learned', { h: w.h, known: true });
  await s.call('rename', { name: 'pg-renamed' });
  s.close();
  await app.close(); // flushes pending writes

  // Inspect over the wire like any client (querying PGlite in-process while the socket server is attached corrupts it).
  const { Client } = require('pg');
  const sql = async q => { const c = new Client(databaseUrl); await c.connect(); try { return (await c.query(q)).rows; } finally { await c.end(); } };
  const rows = await sql('SELECT data FROM players');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].data.name, 'pg-renamed');
  assert.strictEqual((await sql('SELECT count(*)::int AS n FROM sessions'))[0].n, 1);

  app = await start({ port: 0, databaseUrl });
  const s2 = client(app.port);
  const res = await s2.call('resume', { token: s.token });
  assert.strictEqual(res.me.name, 'pg-renamed');
  assert.strictEqual((await s2.call('progress')).learned[2], 1);
  await s2.call('logout', { token: s.token });
  s2.close();
  await app.close();
  assert.strictEqual((await sql('SELECT count(*)::int AS n FROM sessions'))[0].n, 0);
});
