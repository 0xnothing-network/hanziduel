// Game server logic with no runtime dependencies: the Durable Object (src/worker.js) drives it in production,
// the Node tests drive it directly.
//   conn: { data: {}, send(obj), close(), persist?() }   one per WebSocket
//   sql:  Durable Object SQL API shape, sql.exec(query, ...params).toArray()
// Wire format: client -> { e: event, a: arg, i?: ackId }, server -> { e, a } (event) or { i, a } (ack reply).
import * as G from '../game.js';
import WORDS from '../data/words.json' with { type: 'json' };

const WORD_LEVEL = new Map(Object.entries(WORDS).flatMap(([lv, ws]) => ws.map(w => [w.h, +lv])));
const WORD = new Map(Object.values(WORDS).flat().map(w => [w.h, w]));
const INVITE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
// Days and months roll over at midnight Vietnam time (UTC+7).
const vnDate = t => new Date(t + 7 * 3_600_000).toISOString();
const dayOf = t => vnDate(t).slice(0, 10);
const monthOf = t => vnDate(t).slice(0, 7);
const TOTALS = Object.fromEntries(Object.entries(WORDS).map(([lv, ws]) => [lv, ws.length]));
const MAX_MESSAGE = 10_000; // every client message is tiny; cap it so a client can't push megabytes
const validLevel = lv => Number.isInteger(lv) && lv >= 1 && lv <= 7;
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export function createCore({ sql, clientId = '', verifyGoogle, now = Date.now }) {
  // Without a Google client id the server runs in dev mode and allows guest login.
  const GUEST_OK = !clientId;

  sql.exec('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL)');
  // Invites are stored, not kept in memory: the object may hibernate while the host waits for a friend.
  sql.exec('CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, host TEXT NOT NULL, at INTEGER NOT NULL)');
  // All players live in memory (one game server); every change is written through to SQLite at once.
  const players = Object.fromEntries(sql.exec('SELECT id, data FROM players').toArray().map(r => [r.id, JSON.parse(r.data)]));
  const save = id => sql.exec('INSERT INTO players (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, JSON.stringify(players[id]));

  // Streak = consecutive days with any play; shown as 0 once a day has been missed.
  const streakOf = p => p.day && (p.day.d === dayOf(now()) || p.day.d === dayOf(now() - DAY_MS)) ? p.day.n : 0;
  function playedToday(id) {
    const p = players[id], today = dayOf(now());
    if (p.day?.d === today) return;
    p.day = { d: today, n: p.day?.d === dayOf(now() - DAY_MS) ? p.day.n + 1 : 1 };
    save(id);
  }
  const monthGain = p => p.month?.m === monthOf(now()) ? p.month.gain : 0;
  const pub = p => ({ pid: p.pid, name: p.name, rating: p.rating, rank: G.rankOf(p.rating).name, hsk: G.rankOf(p.rating).hsk, wins: p.wins, losses: p.losses, streak: streakOf(p), gain: monthGain(p) });
  // "month": Elo gained this month, only players who played a ranked match in it.
  let boards = {};
  const leaderboard = period => {
    const b = boards[period];
    if (b && now() - b.at < 5000) return b.list;
    const list = period === 'month'
      ? Object.values(players).filter(p => p.month?.m === monthOf(now())).sort((a, b) => b.month.gain - a.month.gain)
      : Object.values(players).sort((a, b) => b.rating - a.rating);
    boards[period] = { at: now(), list: list.slice(0, 20).map(pub) };
    return boards[period].list;
  };
  const missed = (id, h) => { (players[id].wrong ??= {})[h] = now(); };
  // pid: short public id so a client can find itself on the leaderboard without exposing the real id.
  const newPlayer = name => ({ pid: randomHex(5), name: name.slice(0, 20), rating: G.START_RATING, wins: 0, losses: 0, learned: {}, wrong: {} });
  const emit = (conn, e, a) => conn.send({ e, a });

  const online = new Map(); // player id -> conn
  let queue = [];           // { id, since }

  // Last tab wins: a new login for the same account kicks the old connection.
  function attach(conn, id) {
    const old = online.get(id);
    if (old && old !== conn) { detach(old); emit(old, 'kicked'); old.close(); }
    if (conn.data.id && conn.data.id !== id) detach(conn);
    conn.data.id = id;
    conn.persist?.();
    online.set(id, conn);
  }
  function detach(conn) {
    const id = conn.data.id;
    if (!id || online.get(id) !== conn) return;
    online.delete(id);
    queue = queue.filter(q => q.id !== id);
    sql.exec('DELETE FROM invites WHERE host = ?', id);
    if (conn.data.match) conn.data.match.forfeit(id);
  }
  async function newSession(conn, id) {
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    save(id);
    sql.exec('INSERT INTO sessions (token_hash, player_id) VALUES (?, ?)', await sha256(token), id);
    attach(conn, id);
    return { token, me: pub(players[id]), ranks: G.RANKS };
  }
  const me = conn => players[conn.data.id];

  // Events that expect a reply. Each returns the reply.
  const calls = {
    async login(conn, { credential }) {
      if (!clientId) return { error: 'Máy chủ chưa cấu hình Google' };
      if (typeof credential !== 'string' || credential.length > 4096) return { error: 'Thiếu token' };
      let p;
      try { p = await verifyGoogle(credential); } catch { return { error: 'Đăng nhập Google thất bại' }; }
      const id = 'g:' + p.sub;
      players[id] ??= newPlayer(p.name || (p.email || 'Người chơi').split('@')[0]);
      return newSession(conn, id);
    },
    async guest(conn, { name }) {
      if (!GUEST_OK) return { error: 'Hãy đăng nhập bằng Google' };
      name = typeof name === 'string' ? name.trim() : '';
      if (!name) return { error: 'Hãy nhập tên' };
      const id = 'u:' + crypto.randomUUID();
      players[id] = newPlayer(name);
      return newSession(conn, id);
    },
    async resume(conn, { token }) {
      const row = typeof token === 'string' && sql.exec('SELECT player_id FROM sessions WHERE token_hash = ?', await sha256(token)).toArray()[0];
      if (!row || !players[row.player_id]) return { error: 'Phiên đã hết hạn, hãy đăng nhập lại' };
      attach(conn, row.player_id);
      return { me: pub(players[row.player_id]), ranks: G.RANKS };
    },
    async logout(conn, { token }) {
      if (typeof token === 'string') sql.exec('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
      detach(conn);
      conn.data.id = null;
      conn.persist?.();
      return {};
    },
    rename(conn, { name }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      name = typeof name === 'string' ? name.trim().slice(0, 20) : '';
      if (!name) return { error: 'Tên không hợp lệ' };
      p.name = name;
      save(conn.data.id);
      boards = {};
      return { me: pub(p) };
    },
    me(conn) { const p = me(conn); return p ? { me: pub(p) } : { error: 'Chưa đăng nhập' }; },
    leaderboard: (conn, { period }) => leaderboard(period === 'month' ? 'month' : 'all'),
    // Practice: the answer is sent to the client because nothing is at stake.
    practice(conn, { level }) {
      if (!me(conn)) return { error: 'Chưa đăng nhập' };
      if (!validLevel(level)) return { error: 'Cấp HSK không hợp lệ' };
      playedToday(conn.data.id);
      return G.makeQuestion(WORDS, level, level);
    },
    // Review: the 10 most recently missed words.
    review(conn) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      const wrong = Object.entries(p.wrong || {}).filter(([h]) => WORD.has(h)).sort((a, b) => b[1] - a[1]);
      return { words: wrong.slice(0, 10).map(([h]) => WORD.get(h)), total: wrong.length };
    },
    // Friendly match by link. Unranked so nobody can farm Elo off a second account.
    invite(conn) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      if (conn.data.match) return { error: 'Bạn đang trong trận' };
      sql.exec('DELETE FROM invites WHERE host = ? OR at < ?', id, now() - INVITE_MS);
      const code = randomHex(4);
      sql.exec('INSERT INTO invites (code, host, at) VALUES (?, ?, ?)', code, id, now());
      return { code };
    },
    join(conn, { code }) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      const inv = typeof code === 'string' && sql.exec('SELECT host, at FROM invites WHERE code = ?', code).toArray()[0];
      if (!inv || inv.at < now() - INVITE_MS) return { error: 'Lời mời đã hết hạn' };
      if (inv.host === id) return { error: 'Đây là lời mời của bạn — gửi link cho bạn bè nhé' };
      const host = online.get(inv.host);
      if (!host) return { error: 'Người mời đã rời đi' };
      if (host.data.match || conn.data.match) return { error: 'Một trong hai người đang trong trận khác' };
      sql.exec('DELETE FROM invites WHERE code = ?', code);
      queue = queue.filter(q => q.id !== id && q.id !== inv.host);
      runMatch(inv.host, id, false).catch(e => console.error('match error', e));
      return {};
    },
    // Learn: next 10 words of a level the player hasn't marked as known, in list order.
    learn(conn, { level }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      if (!validLevel(level)) return { error: 'Cấp HSK không hợp lệ' };
      const fresh = WORDS[level].filter(w => !p.learned[w.h]);
      return { words: fresh.slice(0, 10), learned: WORDS[level].length - fresh.length, total: WORDS[level].length };
    },
    progress(conn) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      const learned = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
      for (const h in p.learned) learned[WORD_LEVEL.get(h)]++;
      return { learned, total: TOTALS, wrong: Object.keys(p.wrong || {}).length };
    },
    learned(conn, { h, known }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      if (typeof h !== 'string' || !WORD_LEVEL.has(h)) return { error: 'Từ không tồn tại' };
      // Knowing a word also takes it off the review list.
      if (known) { p.learned[h] = 1; if (p.wrong) delete p.wrong[h]; } else delete p.learned[h];
      save(conn.data.id);
      if (known) playedToday(conn.data.id);
      return {};
    },
  };

  // Fire-and-forget events.
  const fires = {
    queue(conn) {
      const id = conn.data.id;
      if (id && players[id] && !conn.data.match && !queue.some(q => q.id === id)) { queue.push({ id, since: Date.now() }); startMatchmaker(); }
    },
    unqueue(conn) { queue = queue.filter(q => q.id !== conn.data.id); },
    answer(conn, i) {
      const m = conn.data.match;
      if (m && Number.isInteger(i) && i >= 0 && i < 4) m.answer(conn.data.id, i);
    },
    // Drill answers are checked in the browser, so the browser reports its misses.
    missed(conn, h) {
      const id = conn.data.id;
      if (!players[id] || typeof h !== 'string' || !WORD.has(h)) return;
      missed(id, h);
      save(id);
    },
  };

  // Pair closest ratings; allowed gap widens the longer people wait.
  // Runs only while someone is queued, so an idle Durable Object can hibernate.
  let matchmaker = null;
  function startMatchmaker() { matchmaker ??= setInterval(matchmake, 1000); }
  function matchmake() {
    queue = queue.filter(q => online.has(q.id) && !online.get(q.id).data.match);
    if (!queue.length) { clearInterval(matchmaker); matchmaker = null; return; }
    queue.sort((a, b) => players[a.id].rating - players[b.id].rating);
    const now = Date.now();
    for (let i = 0; i < queue.length - 1; i++) {
      const a = queue[i], b = queue[i + 1];
      const gap = 100 + 20 * Math.min(now - a.since, now - b.since) / 1000;
      if (Math.abs(players[a.id].rating - players[b.id].rating) <= gap) {
        queue.splice(i, 2);
        i--;
        runMatch(a.id, b.id).catch(e => console.error('match error', e));
      }
    }
  }

  async function runMatch(idA, idB, ranked = true) {
    const ids = [idA, idB];
    const conns = ids.map(id => online.get(id));
    // Pool is capped by the lower-ranked player so neither gets words above their rank.
    const hsk = Math.min(...ids.map(id => G.rankOf(players[id].rating).hsk));
    const score = { [idA]: 0, [idB]: 0 };
    let picks = {}, sentAt = 0, roundDone = () => {}, forfeiter = null;
    // Waits ms or until roundDone(). Armed before anything is sent, so an answer that arrives
    // while we are still sending can't hit a stale roundDone; the timer is cleared so nothing idles.
    const arm = ms => {
      let timer;
      const p = new Promise(r => { roundDone = r; timer = setTimeout(r, ms); });
      return p.then(() => clearTimeout(timer));
    };

    const match = {
      answer(id, i) {
        if (id in picks || !sentAt) return;
        picks[id] = { i, ms: Date.now() - sentAt };
        emit(conns[1 - ids.indexOf(id)], 'oppAnswered'); // only that they answered, never what
        if (Object.keys(picks).length === 2) roundDone();
      },
      // First player to leave loses, even if the other leaves afterwards.
      forfeit(id) { forfeiter ??= id; roundDone(); },
    };
    let waiting = arm(3000);
    conns.forEach((c, k) => {
      c.data.match = match;
      emit(c, 'start', { opponent: pub(players[ids[1 - k]]), hsk, rounds: G.ROUNDS, ranked });
    });
    await waiting;

    for (let n = 1; n <= G.ROUNDS && !forfeiter; n++) {
      const q = G.makeQuestion(WORDS, hsk);
      picks = {};
      waiting = arm(G.ROUND_MS + 500);
      sentAt = Date.now();
      conns.forEach(c => emit(c, 'question', { n, type: q.type, listen: q.listen, hint: q.hint, level: q.level, prompt: q.prompt, options: q.options, ms: G.ROUND_MS }));
      await waiting;
      sentAt = 0;
      if (forfeiter) break;
      for (const id of ids) {
        const p = picks[id];
        if (p) score[id] += G.points(p.i === q.answer, G.ROUND_MS - p.ms);
        if (p?.i !== q.answer) missed(id, q.word.h);
      }
      waiting = arm(2000);
      conns.forEach((c, k) => emit(c, 'reveal', {
        answer: q.answer, word: q.word,
        you: picks[ids[k]]?.i ?? null, opp: picks[ids[1 - k]]?.i ?? null,
        score: score[ids[k]], oppScore: score[ids[1 - k]],
      }));
      await waiting;
    }

    const result = forfeiter ? (forfeiter === idB ? 1 : 0)
      : score[idA] > score[idB] ? 1 : score[idA] < score[idB] ? 0 : 0.5;
    const [pa, pb] = [players[idA], players[idB]];
    const before = [pa.rating, pb.rating];
    if (ranked) {
      [pa.rating, pb.rating] = G.elo(pa.rating, pb.rating, result);
      if (result === 1) { pa.wins++; pb.losses++; } else if (result === 0) { pb.wins++; pa.losses++; }
      const m = monthOf(now());
      ids.forEach((id, k) => {
        const p = players[id];
        if (p.month?.m !== m) p.month = { m, gain: 0 };
        p.month.gain += p.rating - before[k];
      });
    }
    ids.forEach(save);
    ids.forEach(playedToday);
    boards = {};

    conns.forEach((c, k) => {
      c.data.match = null;
      emit(c, 'end', {
        ranked, result: k === 0 ? result : 1 - result, forfeit: !!forfeiter, left: forfeiter === ids[k],
        score: score[ids[k]], oppScore: score[ids[1 - k]],
        delta: players[ids[k]].rating - before[k], me: pub(players[ids[k]]),
      });
    });
  }

  return {
    guest: GUEST_OK,
    async message(conn, text) {
      if (typeof text !== 'string' || text.length > MAX_MESSAGE) return;
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m.e !== 'string') return;
      if (Object.hasOwn(fires, m.e)) return fires[m.e](conn, m.a);
      if (!Object.hasOwn(calls, m.e) || !Number.isInteger(m.i)) return;
      let res;
      try { res = await calls[m.e](conn, m.a && typeof m.a === 'object' ? m.a : {}); }
      catch (e) { console.error(m.e, e.message); res = { error: 'Lỗi máy chủ, thử lại sau' }; }
      conn.send({ i: m.i, a: res });
    },
    close: detach,
    // After a Durable Object wakes from hibernation its sockets survive but memory does not.
    restore(conns) { for (const c of conns) if (c.data.id && players[c.data.id]) online.set(c.data.id, c); },
  };
}
