import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../src/core.js';
import * as G from '../game.js';
import WORDS from '../data/words.json' with { type: 'json' };

// node:sqlite behind the Durable Object SQL API shape: sql.exec(query, ...params).toArray()
function sqlite(file = ':memory:') {
  const db = new DatabaseSync(file);
  return { db, exec: (q, ...p) => { const st = db.prepare(q); const rows = /^\s*(select|pragma)/i.test(q) ? st.all(...p) : (st.run(...p), []); return { toArray: () => rows }; } };
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

test('abuse: per-connection rate limit, repeated writes are skipped', async () => {
  let t = Date.now();
  const sql = sqlite();
  let writes = 0;
  const exec = sql.exec;
  sql.exec = (q, ...p) => { if (/^\s*insert into players/i.test(q)) writes++; return exec(q, ...p); };
  const core = createCore({ sql, now: () => t });
  const s = await guest(core, 'spammer');
  writes = 0;
  for (let i = 0; i < 50; i++) s.emit('missed', '爱');
  for (let i = 0; i < 10; i++) await s.call('learned', { h: '八', known: true });
  assert.strictEqual(writes, 3, 'new miss, new learned word, first play of the day — repeats write nothing');
  // 60 messages per 10 s per account: the next one is dropped, never answered.
  const dropped = await Promise.race([s.call('me'), new Promise(r => setTimeout(() => r('dropped'), 50))]);
  assert.strictEqual(dropped, 'dropped');
  t += 10_001;
  assert.strictEqual((await s.call('me')).me.name, 'spammer', 'allowed again after the window');
});

test('abuse: reconnecting does not reset the rate limit', async () => {
  const core = createCore({ sql: sqlite() });
  const s = await guest(core, 'hopper');
  for (let i = 0; i < 60; i++) s.emit('unqueue');
  const again = client(core); // same account, new socket
  assert.ok((await again.call('resume', { token: s.token })).me);
  const dropped = await Promise.race([again.call('me'), new Promise(r => setTimeout(() => r('dropped'), 50))]);
  assert.strictEqual(dropped, 'dropped', 'the bucket belongs to the account, not the socket');
});

test('sessions expire after 60 days idle, a visit renews them, old tables are upgraded', async () => {
  const DAY = 86_400_000;
  let t = Date.now();
  const sql = sqlite();
  // A database from before sessions had a timestamp.
  sql.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL)');
  const core = createCore({ sql, now: () => t });
  const s = await guest(core, 'sleeper');
  t += 59 * DAY;
  assert.ok((await client(core).call('resume', { token: s.token })).me, 'still valid at 59 days');
  t += 59 * DAY;
  assert.ok((await client(core).call('resume', { token: s.token })).me, 'the visit at day 59 renewed it');
  t += 61 * DAY;
  assert.match((await client(core).call('resume', { token: s.token })).error, /hết hạn/);
  assert.strictEqual(sql.exec('SELECT count(*) AS n FROM sessions').toArray()[0].n, 0, 'expired row removed');
  // Restart on an old-format row with no timestamp: the session survives and gets a fresh 60 days.
  sql.exec("INSERT INTO sessions (token_hash, player_id) VALUES ('legacy', 'x')");
  createCore({ sql, now: () => t });
  assert.strictEqual(sql.exec("SELECT at FROM sessions WHERE token_hash = 'legacy'").toArray()[0].at, t);
});

test('progress keyed by word id; old hanzi-keyed progress is carried over', async () => {
  const sql = sqlite();
  const core = createCore({ sql });
  const s = await guest(core, 'veteran');
  const [le, liao] = Object.values(WORDS).flat().filter(w => w.h === '了');
  await s.call('learned', { id: liao.id, known: true });
  assert.ok(!(await s.call('learn', { level: 3 })).words.some(w => w.id === liao.id));
  assert.strictEqual((await s.call('progress')).learned[1], 0, 'knowing 了 liǎo does not mark 了 le');
  // A player saved before ids existed: hanzi keys move to the lowest-level reading.
  const row = sql.exec('SELECT data FROM players').toArray()[0];
  sql.exec('UPDATE players SET data = ?', JSON.stringify({ ...JSON.parse(row.data), learned: { 了: 1, 爱: 1, gone: 1 }, wrong: { 八: 5 } }));
  const c = client(createCore({ sql }));
  await c.call('resume', { token: s.token });
  assert.strictEqual((await c.call('progress')).learned[1], 2, '了 → le and 爱, unknown key dropped');
  assert.ok((await c.call('learn', { level: 1 })).words.every(w => w.id !== le.id));
  assert.deepStrictEqual((await c.call('review')).words.map(w => w.h), ['八']);
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
    assert.ok(!q.listen && q.type !== 'Nghe → nghĩa', 'no listening questions in PvP');
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
  assert.strictEqual(end.me.winStreak, 1);
  assert.strictEqual(end.perfect, false);
  assert.strictEqual(end.me.recent[0].forfeit, true);
  assert.strictEqual(end.me.recent[0].pid, b.me.pid);
  assert.strictEqual(end.me.recent[0].ranked, true);
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

function solveDaily(q) {
  const pools = [WORDS[q.level], Object.values(WORDS).flat()];
  for (const pool of pools) {
    const hits = q.type === 'Việt → Hán'
      ? q.options.map((o, i) => pool.some(w => w.h === o && w.m === q.prompt) ? i : -1).filter(i => i >= 0)
      : q.options.map((o, i) => pool.some(w => w.h === q.prompt && w.m === o) ? i : -1).filter(i => i >= 0);
    if (hits.length === 1) return hits[0];
  }
  assert.fail('ambiguous daily question ' + JSON.stringify({ type: q.type, prompt: q.prompt, options: q.options }));
}

test('daily paper is shared, scored on the server, and survives a restart', async () => {
  let t = Date.parse('2026-11-10T02:00:00Z');
  const sql = sqlite();
  const core = createCore({ sql, now: () => t });
  const [a, b] = await Promise.all([guest(core, 'a'), guest(core, 'b')]);
  assert.ok((await client(core).call('daily')).error);
  const paper = await a.call('daily');
  assert.strictEqual(paper.day, '2026-11-10');
  assert.ok(paper.word.h && paper.word.p && paper.word.id === undefined);
  const qa = await a.call('dailyBegin');
  const qb = await b.call('dailyBegin');
  assert.deepStrictEqual([qa.prompt, qa.options], [qb.prompt, qb.options]);
  assert.ok(!('answer' in qa) && !('word' in qa) && !qa.listen);
  t += 3000;
  const held = await a.call('dailyBegin');
  assert.strictEqual(held.prompt, qa.prompt);
  assert.strictEqual(held.ms, G.DAILY_MS - 3000);
  const first = await a.call('dailyAnswer', { i: solveDaily(qa) });
  assert.strictEqual(first.reveal.ok, true);
  assert.strictEqual(first.reveal.gain, G.points(true, G.DAILY_MS - 3000, G.DAILY_MS));
  assert.strictEqual(first.next.n, 2);
  const woken = createCore({ sql, now: () => t });
  const a2 = client(woken);
  await a2.call('resume', { token: a.token });
  const cont = await a2.call('dailyBegin');
  assert.strictEqual(cont.n, 2);
  assert.strictEqual(cont.prompt, first.next.prompt);
  t += G.DAILY_MS + G.DAILY_GRACE_MS + 1;
  const late = await a2.call('dailyAnswer', { i: solveDaily(cont) });
  assert.strictEqual(late.reveal.ok, false);
  let step = late;
  while (!step.done) {
    t += 500;
    step = await a2.call('dailyAnswer', { i: solveDaily(step.next) });
  }
  assert.strictEqual(step.correct, 9);
  assert.ok(step.board.some(p => p.pid === a.me.pid && p.correct === 9));
  assert.ok(step.me.badges.find(x => x.id === 'daily').on);
  assert.match((await a2.call('dailyBegin')).error, /hoàn thành/);
  assert.ok((await a2.call('review')).words.some(w => w.h === late.reveal.word.h));
});

test('drill record is personal and only saved when it improves', async () => {
  const sql = sqlite();
  let writes = 0;
  const exec = sql.exec;
  sql.exec = (q, ...p) => { if (/^\s*insert into players/i.test(q)) writes++; return exec(q, ...p); };
  const core = createCore({ sql });
  const s = await guest(core, 'sprinter');
  writes = 0;
  assert.ok((await client(core).call('drillBest', { level: 1, score: 10 })).error);
  for (const bad of [{ level: 0, score: 5 }, { level: 1, score: 0 }, { level: 1, score: 1.5 }, { level: 1, score: 301 }, { level: '1', score: 10 }])
    assert.ok((await s.call('drillBest', bad)).error, JSON.stringify(bad));
  assert.strictEqual((await s.call('drillBest', { level: 1, score: 10 })).drillBest[1], 10);
  assert.strictEqual((await s.call('drillBest', { level: 1, score: 10 })).drillBest[1], 10);
  assert.strictEqual((await s.call('drillBest', { level: 1, score: 4 })).drillBest[1], 10);
  assert.strictEqual(writes, 1, 'a repeat or a lower score does not write');
});

test('presence counts who is online and who is queued', async () => {
  const core = createCore({ sql: sqlite() });
  const a = await guest(core, 'here');
  const seen = a.next('presence');
  await guest(core, 'also');
  assert.deepStrictEqual(await seen, { online: 2, queued: 0 });
  const queued = a.next('presence');
  a.emit('queue');
  assert.deepStrictEqual(await queued, { online: 2, queued: 1 });
  const resumed = await client(core).call('resume', { token: a.token });
  assert.deepStrictEqual(resumed.presence, { online: 2, queued: 0 });
  assert.ok(!JSON.stringify(resumed.presence).includes('u:'));
});

test('practice can filter one real question type and rejects the rest', async () => {
  const core = createCore({ sql: sqlite() });
  const s = await guest(core, 'filter');
  assert.deepStrictEqual(G.TYPES.map(t => t.type), ['Hán → Việt', 'Việt → Hán', 'Nghe → nghĩa']);
  assert.ok((await client(core).call('practice', { level: 1, type: 'Hán → Việt' })).error);
  for (const type of G.TYPES.map(t => t.type)) {
    for (let i = 0; i < 6; i++) {
      const q = await s.call('practice', { level: 1, type });
      assert.strictEqual(q.type, type);
      assert.strictEqual(!!q.listen, type === 'Nghe → nghĩa');
    }
  }
  const mixed = new Set();
  for (let i = 0; i < 24 && mixed.size < 3; i++) mixed.add((await s.call('practice', { level: 1 })).type);
  assert.strictEqual(mixed.size, 3, 'omitted type still uses all three');
  for (const type of ['listen', 'Hán', 'Nghe', 'pinyin', '', 1, null, { type: 'Hán → Việt' }])
    assert.ok((await s.call('practice', { level: 1, type })).error, JSON.stringify(type));
});

function familyList(ch) {
  const list = [];
  for (const [lv, ws] of Object.entries(WORDS)) {
    for (const w of ws) if (new Set([...w.h]).has(ch)) list.push({ h: w.h, p: w.p, m: w.m, level: +lv });
  }
  return list;
}

test('character family is capped, ordered, and rejects empty or multi-character queries', async () => {
  const core = createCore({ sql: sqlite() });
  const s = await guest(core, 'family');
  assert.ok((await client(core).call('family', { q: '不' })).error);
  for (const q of ['', '   ', '不好', '不 好', '不人', 'QQ', 1, null, ['不']])
    assert.match((await s.call('family', { q })).error, /một chữ/, JSON.stringify(q));
  assert.match((await s.call('family', { q: 'Q' })).error, /Không có/);
  const all = familyList('不');
  assert.ok(all.length > 24);
  const res = await s.call('family', { q: ' 不 ' });
  assert.strictEqual(res.ch, '不');
  assert.strictEqual(res.words.length, 24);
  assert.deepStrictEqual(res.words, all.slice(0, 24));
  assert.deepStrictEqual(Object.keys(res.words[0]).sort(), ['h', 'level', 'm', 'p']);
  assert.ok(res.words.every((w, i) => i === 0 || w.level >= res.words[i - 1].level));
  assert.ok(res.words.every(w => [...w.h].includes('不') && w.m && w.p));
  const love = await s.call('family', { q: '爱' });
  assert.deepStrictEqual(love, await s.call('family', { q: ' 爱 ' }));
  assert.ok(love.words.length <= 24);
  assert.ok(love.words.some(w => w.h === '爱'));
});

test('survival best is personal, capped, and does not move Elo', async () => {
  const sql = sqlite();
  let writes = 0;
  const exec = sql.exec;
  sql.exec = (q, ...p) => { if (/^\s*insert into players/i.test(q)) writes++; return exec(q, ...p); };
  const core = createCore({ sql });
  const s = await guest(core, 'survivor');
  writes = 0;
  assert.ok((await client(core).call('surviveBest', { level: 1, score: 4 })).error);
  for (const bad of [{ level: 0, score: 5 }, { level: 1, score: 0 }, { level: 1, score: 301 }, { level: '1', score: 3 }])
    assert.ok((await s.call('surviveBest', bad)).error, JSON.stringify(bad));
  assert.strictEqual((await s.call('surviveBest', { level: 2, score: 5 })).surviveBest[2], 5);
  assert.strictEqual((await s.call('surviveBest', { level: 2, score: 3 })).surviveBest[2], 5);
  assert.strictEqual(writes, 1, 'a lower or repeated survival score does not write');
  const me = (await s.call('me')).me;
  assert.strictEqual(me.rating, G.START_RATING);
  assert.strictEqual(me.surviveBest[2], 5);
  assert.ok(!me.drillBest[2]);
});

test('study group survives hibernation and does not change Elo', async () => {
  let t = Date.parse('2026-11-10T02:00:00Z');
  const file = tmpDb();
  const sql = sqlite(file);
  const core = createCore({ sql, now: () => t });
  const host = await guest(core, 'host');
  const friend = await guest(core, 'friend');
  assert.strictEqual(host.me.rating, G.START_RATING);
  assert.ok((await client(core).call('group')).error);
  assert.ok((await client(core).call('groupCreate')).error);
  assert.deepStrictEqual(await host.call('group'), { code: null, members: [] });
  for (const code of ['', 'abc', 'zzzzzz', null])
    assert.ok((await friend.call('groupJoin', { code })).error, String(code));
  const created = await host.call('groupCreate');
  assert.match(created.code, /^[0-9a-f]{6}$/);
  assert.strictEqual(created.members.length, 1);
  assert.strictEqual(created.members[0].name, 'host');
  assert.strictEqual(created.members[0].you, true);
  assert.strictEqual(created.members[0].daily, false);
  assert.ok((await host.call('groupCreate')).error, 'one group per player');
  if (created.code !== 'abcdef') assert.ok((await friend.call('groupJoin', { code: 'abcdef' })).error);
  const joined = await friend.call('groupJoin', { code: created.code.toUpperCase() });
  assert.deepStrictEqual(joined.members.map(m => m.name), ['host', 'friend']);
  assert.strictEqual(joined.members[1].you, true);
  assert.strictEqual((await host.call('groupJoin', { code: created.code })).code, created.code);
  const other = await guest(core, 'other');
  const otherGroup = await other.call('groupCreate');
  assert.match((await friend.call('groupJoin', { code: otherGroup.code })).error, /rời nhóm/);
  await host.call('seal', { seal: '寅' });
  await host.call('practice', { level: 1 });
  const members = sql.exec('SELECT count(*) AS n FROM study_members').toArray()[0].n;
  await host.call('practice', { level: 1 });
  host.emit('missed', '爱');
  host.emit('missed', '爱');
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(sql.exec('SELECT count(*) AS n FROM study_members').toArray()[0].n, members, 'answering does not write the group');
  assert.strictEqual((await host.call('me')).me.rating, G.START_RATING);
  assert.strictEqual((await friend.call('me')).me.rating, G.START_RATING);
  const fr = sql.exec('SELECT id, data FROM players').toArray().find(r => JSON.parse(r.data).name === 'friend');
  const data = JSON.parse(fr.data);
  data.daily = { d: '2026-11-10', correct: 8, score: 10, ms: 1000 };
  sql.exec('UPDATE players SET data = ? WHERE id = ?', JSON.stringify(data), fr.id);

  const woken = createCore({ sql: sqlite(file), now: () => t });
  const host2 = client(woken);
  const resumed = await host2.call('resume', { token: host.token });
  assert.strictEqual(resumed.me.rating, G.START_RATING);
  const g = await host2.call('group');
  assert.strictEqual(g.code, created.code);
  assert.deepStrictEqual(g.members.map(m => [m.name, m.you, m.daily, m.streak]), [
    ['host', true, false, 1],
    ['friend', false, true, 0],
  ]);
  assert.strictEqual(g.members[0].seal, '寅');
  assert.ok(!JSON.stringify(g).includes('u:'));
  assert.ok(!('rating' in g.members[0]));
  await host2.call('groupLeave');
  const friend2 = client(woken);
  await friend2.call('resume', { token: friend.token });
  assert.deepStrictEqual((await friend2.call('group')).members.map(m => m.name), ['friend']);
  assert.deepStrictEqual(await friend2.call('groupLeave'), { code: null, members: [] });
  assert.match((await friend2.call('groupJoin', { code: created.code })).error, /Không thấy/);
  assert.match((await friend2.call('groupLeave')).error, /chưa có nhóm/);
  assert.strictEqual((await friend2.call('me')).me.rating, G.START_RATING);
  assert.strictEqual((await host2.call('me')).me.rating, G.START_RATING);
});

test('a study group holds at most 12 people', async () => {
  const core = createCore({ sql: sqlite() });
  const host = await guest(core, 'host');
  const { code } = await host.call('groupCreate');
  for (let i = 0; i < 11; i++) assert.strictEqual((await (await guest(core, 'p' + i)).call('groupJoin', { code })).members.length, i + 2);
  const extra = await guest(core, 'extra');
  assert.match((await extra.call('groupJoin', { code })).error, /đủ/);
  assert.strictEqual((await extra.call('me')).me.rating, G.START_RATING);
});

test('direct challenge is unranked, expires, and reactions are a fixed set', { timeout: 30000 }, async () => {
  let t = Date.now();
  const core = createCore({ sql: sqlite(), now: () => t });
  const [a, b] = await Promise.all([guest(core, 'a'), guest(core, 'b')]);
  const asleep = await guest(core, 'asleep');
  asleep.close();
  assert.match((await a.call('challenge', { pid: a.me.pid })).error, /chính mình/);
  assert.match((await a.call('challenge', { pid: 'zzzz' })).error, /Không tìm thấy/);
  assert.match((await a.call('challenge', { pid: asleep.me.pid })).error, /offline/);
  assert.ok((await client(core).call('challenge', { pid: b.me.pid })).error);
  const note = b.next('challenge');
  assert.deepStrictEqual(await a.call('challenge', { pid: b.me.pid }), {});
  const ch = await note;
  assert.strictEqual(ch.name, 'a');
  assert.strictEqual(ch.pid, a.me.pid);
  assert.ok(!JSON.stringify(ch).includes('u:'));
  const closed = a.next('challengeClosed');
  assert.deepStrictEqual(await b.call('decline'), {});
  await closed;
  assert.match((await b.call('accept')).error, /hết/);
  const again = b.next('challenge');
  await a.call('challenge', { pid: b.me.pid });
  await again;
  t += 61_000;
  assert.match((await b.call('accept')).error, /hết/);
  const live = b.next('challenge');
  await a.call('challenge', { pid: b.me.pid });
  await live;
  const started = a.next('start');
  const seen = [];
  b.on('react', x => seen.push(x));
  assert.deepStrictEqual(await b.call('accept'), {});
  const st = await started;
  assert.strictEqual(st.ranked, false);
  assert.strictEqual(st.opponent.recent, undefined);
  a.emit('react', 'hello');
  a.emit('react', '加油');
  a.emit('react', '谢谢');
  assert.deepStrictEqual(seen, ['加油', '谢谢']);
  b.close();
  const end = await a.next('end');
  assert.strictEqual(end.ranked, false);
  assert.strictEqual(end.delta, 0);
  assert.strictEqual(end.me.wins, 0);
  assert.strictEqual(end.me.winStreak, 0);
  assert.strictEqual(end.me.recent[0].pid, b.me.pid);
  assert.strictEqual(end.me.recent[0].ranked, false);
});

