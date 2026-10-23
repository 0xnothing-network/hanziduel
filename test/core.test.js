import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../src/core.js';
import * as G from '../game.js';

// node:sqlite behind the Durable Object SQL API shape: sql.exec(query, ...params).toArray()
function sqlite(file = ':memory:') {
  const db = new DatabaseSync(file);
  return { db, exec: (q, ...p) => { const st = db.prepare(q); const rows = /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []); return { toArray: () => rows }; } };
}
const tmpDb = () => path.join(os.tmpdir(), `duel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

// A fake WebSocket client speaking the same { e, a, i } frames as the browser.
function client(core) {
  const listeners = {}, acks = new Map();
  let seq = 0;
  const c = {
    data: { id: null },
    closed: false,
    send(msg) { if (msg.i) { acks.get(msg.i)?.(msg.a); acks.delete(msg.i); } else (listeners[msg.e] || []).slice().forEach(fn => fn(msg.a)); },
    close() { c.closed = true; core.close(c); },
    call: (e, a = {}) => new Promise(r => { const i = ++seq; acks.set(i, r); core.message(c, JSON.stringify({ e, a, i })); }),
    emit: (e, a) => core.message(c, JSON.stringify({ e, a })),
    on: (e, fn) => (listeners[e] ||= []).push(fn),
    next: e => new Promise(r => { const fn = a => { listeners[e].splice(listeners[e].indexOf(fn), 1); r(a); }; c.on(e, fn); }),
  };
  return c;
}
async function guest(core, name) {
  const c = client(core);
  const res = await c.call('guest', { name });
  assert.ok(res.token, JSON.stringify(res));
  return Object.assign(c, { token: res.token, me: res.me });
}

test('accounts: guest, resume, bad input, logout, rename, kick on second login', async () => {
  const core = createCore({ sql: sqlite() });
  const a = await guest(core, '  Alice  ');
  assert.strictEqual(a.me.name, 'Alice');
  assert.strictEqual(a.me.rating, G.START_RATING);
  assert.match(a.me.pid, /^[0-9a-f]{10}$/);

  const anon = client(core);
  for (const [ev, arg] of [['learn', { level: 1 }], ['practice', { level: 1 }], ['progress'], ['rename', { name: 'x' }], ['learned', { h: '爱', known: true }]])
    assert.strictEqual((await anon.call(ev, arg)).error, 'Chưa đăng nhập', ev);
  assert.ok((await anon.call('guest', { name: '   ' })).error);
  assert.ok((await anon.call('guest', { name: 123 })).error);
  assert.ok((await anon.call('resume', { token: 'bogus' })).error);
  assert.ok((await anon.call('resume', null)).error);
  assert.ok((await anon.call('login', { credential: 'x' })).error, 'no Google login in dev mode');
  assert.ok(Array.isArray(await anon.call('leaderboard')));

  // Garbage frames are ignored, never crash.
  for (const junk of ['', 'not json', 'null', '[]', '{"e":5}', '{"e":"constructor","i":1}', '{"e":"__proto__","i":2}', 'x'.repeat(20000)])
    await core.message(anon, junk);
  assert.strictEqual(anon.closed, false);

  assert.ok((await a.call('rename', { name: '' })).error);
  assert.strictEqual((await a.call('rename', { name: 'A'.repeat(50) })).me.name.length, 20);

  const b = client(core);
  const kicked = a.next('kicked');
  assert.strictEqual((await b.call('resume', { token: a.token })).me.name, 'A'.repeat(20));
  await kicked;
  assert.strictEqual(a.closed, true);

  await b.call('logout', { token: a.token });
  assert.ok((await client(core).call('resume', { token: a.token })).error, 'token revoked after logout');
});

test('seal avatar: only the 12 earthly branches, shown on the leaderboard', async () => {
  const sql = sqlite();
  const core = createCore({ sql });
  const s = await guest(core, 'tiger');
  assert.strictEqual(s.me.seal, null);
  for (const bad of ['猫', '虎', '寅寅', '<b>', 1, null]) assert.ok((await s.call('seal', { seal: bad })).error, String(bad));
  assert.ok((await client(core).call('seal', { seal: '寅' })).error, 'login required');
  assert.strictEqual((await s.call('seal', { seal: '寅' })).me.seal, '寅');
  assert.strictEqual((await s.call('leaderboard'))[0].seal, '寅');
  // A player saved with the old animal seal is shown the matching branch.
  const row = sql.exec('SELECT data FROM players').toArray()[0];
  sql.exec('UPDATE players SET data = ?', JSON.stringify({ ...JSON.parse(row.data), seal: '虎' }));
  assert.strictEqual((await client(createCore({ sql })).call('resume', { token: s.token })).me.seal, '寅');
});

test('google login uses the verifier and creates one player per Google account', async () => {
  const verifyGoogle = async t => { if (t !== 'good') throw new Error('bad'); return { sub: '42', name: 'Lan Anh', email: 'lan@example.com' }; };
  const core = createCore({ sql: sqlite(), clientId: 'cid', verifyGoogle });
  assert.ok((await client(core).call('guest', { name: 'x' })).error, 'no guests when Google is configured');
  assert.strictEqual((await client(core).call('login', { credential: 'bad' })).error, 'Đăng nhập Google thất bại');
  assert.ok((await client(core).call('login', { credential: 'y'.repeat(5000) })).error);
  const first = await client(core).call('login', { credential: 'good' });
  const second = await client(core).call('login', { credential: 'good' });
  assert.strictEqual(first.me.name, 'Lan Anh');
  assert.strictEqual(first.me.pid, second.me.pid);
  assert.notStrictEqual(first.token, second.token);
});

test('learn, progress and practice', async () => {
  const core = createCore({ sql: sqlite() });
  const s = await guest(core, 'learner');
  const first = await s.call('learn', { level: 1 });
  assert.strictEqual(first.words.length, 10);
  assert.strictEqual(first.learned, 0);
  assert.deepStrictEqual(await s.call('learned', { h: first.words[0].h, known: true }), {});
  assert.deepStrictEqual(await s.call('learned', { h: first.words[0].h, known: true }), {}, 'idempotent');
  const next = await s.call('learn', { level: 1 });
  assert.strictEqual(next.learned, 1);
  assert.ok(!next.words.some(w => w.h === first.words[0].h));
  assert.strictEqual((await s.call('progress')).learned[1], 1);
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
  assert.ok(['Hán → Việt', 'Việt → Hán', 'Nghe → nghĩa'].includes(q.type));
});

test('wrong words: drill misses are reviewed, knowing a word clears it', async () => {
  const core = createCore({ sql: sqlite() });
  const s = await guest(core, 'reviewer');
  assert.deepStrictEqual(await s.call('review'), { words: [], total: 0 });
  s.emit('missed', '爱'); s.emit('missed', '八'); s.emit('missed', 'not-a-word'); s.emit('missed', { h: '爱' });
  await new Promise(r => setTimeout(r, 5));
  s.emit('missed', '爱'); // missed again: moves to the top, not duplicated
  const r = await s.call('review');
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.words.map(w => w.h), ['爱', '八']);
  assert.strictEqual((await s.call('progress')).wrong, 2);
  await s.call('learned', { h: '爱', known: true });
  assert.deepStrictEqual((await s.call('review')).words.map(w => w.h), ['八']);
  assert.ok((await client(core).call('review')).error);
});

test('streak counts consecutive days of any play, in Vietnam time', async () => {
  let t = Date.parse('2026-10-24T16:59:00Z'); // 23:59 in Vietnam
  const core = createCore({ sql: sqlite(), now: () => t });
  const s = await guest(core, 'daily');
  const streak = async () => (await s.call('me')).me.streak;
  assert.strictEqual(await streak(), 0);
  await s.call('practice', { level: 1 });
  await s.call('practice', { level: 1 });
  assert.strictEqual(await streak(), 1, 'twice in a day still counts once');
  t += 2 * 60_000; // 00:01 next day in Vietnam
  assert.strictEqual(await streak(), 1, 'yesterday still keeps the streak alive');
  const w = (await s.call('learn', { level: 1 })).words[0];
  await s.call('learned', { h: w.h, known: true });
  assert.strictEqual(await streak(), 2);
  t += 2 * 86_400_000; // skip a whole day
  assert.strictEqual(await streak(), 0);
  await s.call('practice', { level: 1 });
  assert.strictEqual(await streak(), 1);
});

test('invite link: friendly match, no Elo, invite errors', { timeout: 30000 }, async () => {
  const core = createCore({ sql: sqlite() });
  const [host, friend, other] = await Promise.all([guest(core, 'host'), guest(core, 'friend'), guest(core, 'other')]);
  assert.ok((await client(core).call('invite')).error, 'login required');
  const { code } = await host.call('invite');
  assert.match(code, /^[0-9a-f]{8}$/);
  assert.match((await host.call('join', { code })).error, /lời mời của bạn/);
  assert.ok((await friend.call('join', { code: 'nope' })).error);
  assert.ok((await friend.call('join', {})).error);
  const started = host.next('start');
  assert.deepStrictEqual(await friend.call('join', { code }), {});
  const st = await started;
  assert.strictEqual(st.ranked, false);
  assert.strictEqual(st.opponent.name, 'friend');
  assert.ok((await other.call('join', { code })).error, 'an invite works once');
  await host.next('question');
  friend.close();
  const end = await host.next('end');
  assert.strictEqual(end.ranked, false);
  assert.strictEqual(end.result, 1);
  assert.strictEqual(end.delta, 0);
  assert.strictEqual(end.me.wins, 0);
  assert.strictEqual(end.me.streak, 1, 'a friendly match still counts as playing');
  assert.deepStrictEqual(await host.call('leaderboard', { period: 'month' }), [], 'friendly matches stay off the monthly board');
});

test('invite expires after 15 minutes and when the host leaves', async () => {
  let t = Date.now();
  const core = createCore({ sql: sqlite(), now: () => t });
  const [host, friend] = await Promise.all([guest(core, 'host'), guest(core, 'friend')]);
  const { code } = await host.call('invite');
  t += 16 * 60_000;
  assert.match((await friend.call('join', { code })).error, /hết hạn/);
  const { code: code2 } = await host.call('invite');
  host.close();
  assert.ok((await friend.call('join', { code: code2 })).error);
});

test('monthly leaderboard: Elo gained this month, resets next month', { timeout: 30000 }, async () => {
  let t = Date.parse('2026-10-31T10:00:00Z');
  const core = createCore({ sql: sqlite(), now: () => t });
  const [a, b] = await Promise.all([guest(core, 'winner'), guest(core, 'loser')]);
  const q = a.next('question');
  a.emit('queue'); b.emit('queue');
  await q;
  b.close();
  await a.next('end');
  const month = await a.call('leaderboard', { period: 'month' });
  assert.deepStrictEqual(month.map(p => [p.name, p.gain]), [['winner', 16], ['loser', -16]]);
  assert.strictEqual((await a.call('leaderboard')).length, 2, 'all-time board unchanged in shape');
  t = Date.parse('2026-11-01T10:00:00Z');
  assert.deepStrictEqual(await a.call('leaderboard', { period: 'month' }), [], 'new month starts empty');
  assert.strictEqual((await a.call('me')).me.gain, 0);
});

test('pvp: full match, answers validated, elo applied and persisted', { timeout: 60000 }, async () => {
  const file = tmpDb();
  const core = createCore({ sql: sqlite(file) });
  const [a, b] = await Promise.all([guest(core, 'bot-a'), guest(core, 'bot-b')]);
  const startA = a.next('start');
  a.emit('queue'); a.emit('queue');
  b.emit('queue');
  const st = await startA;
  assert.strictEqual(st.opponent.name, 'bot-b');
  assert.strictEqual(st.hsk, 1);
  a.emit('answer', 0); // before any question: ignored

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

  // A fresh core on the same database (a Durable Object restart) still has the rating and the session.
  const core2 = createCore({ sql: sqlite(file) });
  assert.strictEqual((await client(core2).call('resume', { token: a.token })).me.rating, ea.me.rating);
});

test('pvp: leaving mid-match forfeits', { timeout: 30000 }, async () => {
  const core = createCore({ sql: sqlite() });
  const [a, b] = await Promise.all([guest(core, 'stay'), guest(core, 'leave')]);
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

test('restore after hibernation: connections keep their player', async () => {
  const sql = sqlite();
  const core = createCore({ sql });
  const a = await guest(core, 'sleepy');
  // Durable Object hibernates: memory is gone, the socket (and its attachment) survives.
  const woken = createCore({ sql });
  const conn = client(woken);
  conn.data.id = a.data.id;
  woken.restore([conn]);
  assert.strictEqual((await conn.call('progress')).learned[1], 0);
  const other = await guest(woken, 'other');
  const started = conn.next('start');
  conn.emit('queue'); other.emit('queue');
  assert.strictEqual((await started).opponent.name, 'other');
  conn.close(); other.close();
});
