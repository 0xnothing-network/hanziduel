// Game server logic with no runtime dependencies: the Durable Object (src/worker.js) drives it in production,
// the Node tests drive it directly.
//   conn: { data: {}, send(obj), close(), persist?() }   one per WebSocket
//   sql:  Durable Object SQL API shape, sql.exec(query, ...params).toArray()
// Wire format: client -> { e: event, a: arg, i?: ackId }, server -> { e, a } (event) or { i, a } (ack reply).
import * as G from '../game.js';
import WORDS from '../data/words.json' with { type: 'json' };

// Words are keyed by their official id (L1-0210): one hanzi can be several words (了 le / liǎo).
const WORD_LEVEL = new Map(Object.entries(WORDS).flatMap(([lv, ws]) => ws.map(w => [w.id, +lv])));
const WORD = new Map(Object.values(WORDS).flat().map(w => [w.id, w]));
// Progress used to be keyed by hanzi, and older tabs may still send hanzi: map it to its lowest-level reading.
const BY_HANZI = new Map();
for (const w of Object.values(WORDS).flat()) if (!BY_HANZI.has(w.h)) BY_HANZI.set(w.h, w.id);
// Words that contain a character, lowest HSK first. Built once; a lookup only slices it.
const FAMILY = new Map();
for (const [lv, ws] of Object.entries(WORDS)) {
  for (const w of ws) {
    for (const ch of new Set([...w.h])) {
      const row = { h: w.h, p: w.p, m: w.m, level: +lv };
      const list = FAMILY.get(ch);
      if (list) list.push(row); else FAMILY.set(ch, [row]);
    }
  }
}
const FAMILY_CAP = 24;
const GROUP_CAP = 12;
const wordId = x => typeof x !== 'string' ? null : WORD.has(x) ? x : BY_HANZI.get(x) ?? null;
const rekey = obj => Object.fromEntries(Object.entries(obj || {}).flatMap(([k, v]) => wordId(k) ? [[wordId(k), v]] : []));
const INVITE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
// Days and months roll over at midnight Vietnam time (UTC+7).
const vnDate = t => new Date(t + 7 * 3_600_000).toISOString();
const dayOf = t => vnDate(t).slice(0, 10);
const monthOf = t => vnDate(t).slice(0, 7);
const TOTALS = Object.fromEntries(Object.entries(WORDS).map(([lv, ws]) => [lv, ws.length]));
const SEALS = [...'子丑寅卯辰巳午未申酉戌亥']; // the 12 earthly branches (Tý…Hợi), the only avatars on offer
// Seals were briefly the animal characters; show those players their branch instead.
const BRANCH_OF = Object.fromEntries([...'鼠牛虎兔龙蛇马羊猴鸡狗猪'].map((a, i) => [a, SEALS[i]]));
const MAX_MESSAGE = 10_000; // every client message is tiny; cap it so a client can't push megabytes
// Normal play sends under 3 messages a second. The cap stops one client from burning the
// Durable Object's daily write quota (100k rows on the free plan) and taking the game down.
const RATE_WINDOW_MS = 10_000, RATE_MAX = 60;
// Sessions expire after 60 days without a visit; a visit renews at most once a day to save writes.
const SESSION_MS = 60 * DAY_MS, RENEW_MS = DAY_MS;
const validLevel = lv => Number.isInteger(lv) && lv >= 1 && lv <= 7;
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export function createCore({ sql, clientId = '', verifyGoogle, now = Date.now }) {
  // Without a Google client id the server runs in dev mode and allows guest login.
  const GUEST_OK = !clientId;

  sql.exec('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL)');
  // Sessions got a last-seen time later; older rows start their 60 days now instead of being logged out.
  if (!sql.exec('PRAGMA table_info(sessions)').toArray().some(c => c.name === 'at')) sql.exec('ALTER TABLE sessions ADD COLUMN at INTEGER');
  sql.exec('UPDATE sessions SET at = ? WHERE at IS NULL', now());
  sql.exec('DELETE FROM sessions WHERE at < ?', now() - SESSION_MS);
  // Invites are stored, not kept in memory: the object may hibernate while the host waits for a friend.
  sql.exec('CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, host TEXT NOT NULL, at INTEGER NOT NULL)');
  // One study group per player. Rows, not memory: a hibernating object must still know the group.
  sql.exec('CREATE TABLE IF NOT EXISTS study_groups (code TEXT PRIMARY KEY, created INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS study_members (player_id TEXT PRIMARY KEY, code TEXT NOT NULL, joined INTEGER NOT NULL)');
  // All players live in memory (one game server); every change is written through to SQLite at once.
  const players = Object.fromEntries(sql.exec('SELECT id, data FROM players').toArray().map(r => [r.id, JSON.parse(r.data)]));
  // In memory only; the new keys are written the next time the player changes anything.
  for (const p of Object.values(players)) { p.learned = rekey(p.learned); p.wrong = rekey(p.wrong); }
  const save = id => sql.exec('INSERT INTO players (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, JSON.stringify(players[id]));

  // Streak = consecutive days with any play; shown as 0 once a day has been missed.
  const streakOf = p => p.day && (p.day.d === dayOf(now()) || p.day.d === dayOf(now() - DAY_MS)) ? p.day.n : 0;
  // Returns true when the day rolled, so the caller can fold the change into a write it was already going to do.
  function rollDay(p) {
    const today = dayOf(now());
    if (p.day?.d === today) return false;
    const cont = p.day?.d === dayOf(now() - DAY_MS);
    const n = cont ? (p.day.n || 0) + 1 : 1;
    const best = Math.max(p.day?.best || 0, cont ? (p.day.n || 0) : 0, n);
    p.day = { d: today, n, best };
    return true;
  }
  function playedToday(id) { if (rollDay(players[id])) save(id); }
  const monthGain = p => p.month?.m === monthOf(now()) ? p.month.gain : 0;
  const bestStreakOf = p => Math.max(p.day?.best || 0, streakOf(p));
  const learnedCount = p => Object.keys(p.learned || {}).length;
  const sealOf = p => BRANCH_OF[p.seal] || (SEALS.includes(p.seal) ? p.seal : null);
  const pub = p => ({ pid: p.pid, name: p.name, seal: sealOf(p), rating: p.rating, rank: G.rankOf(p.rating).name, hsk: G.rankOf(p.rating).hsk, wins: p.wins, losses: p.losses, streak: streakOf(p), gain: monthGain(p) });
  // Own profile only. The public card stays small and does not carry match history.
  const DRILL_CAP = 300; // 60s of honest play, even with no network wait, stays under this
  function cappedBest(src) {
    const out = {};
    const box = src && typeof src === 'object' ? src : {};
    for (let lv = 1; lv <= 7; lv++) {
      const n = box[lv] ?? box[String(lv)];
      if (Number.isInteger(n) && n > 0 && n <= DRILL_CAP) out[lv] = n;
    }
    return out;
  }
  const drillBestOf = p => cappedBest(p.drillBest);
  const surviveBestOf = p => cappedBest(p.surviveBest);
  function badgeList(p) {
    const learned = learnedCount(p);
    const bestStreak = bestStreakOf(p);
    const peak = Math.max(p.peak || 0, p.rating || 0);
    const bestWin = Math.max(p.bestWin || 0, p.winStreak || 0);
    const specs = [
      ['debut', '初', 'Ra trận', p.wins + p.losses >= 1],
      ['win', '胜', 'Thắng trận đầu', p.wins >= 1],
      ['win3', '三', '3 thắng liên tiếp', bestWin >= 3],
      ['win5', '五', '5 thắng liên tiếp', bestWin >= 5],
      ['fire7', '火', 'Chuỗi 7 ngày', bestStreak >= 7],
      ['fire30', '月', 'Chuỗi 30 ngày', bestStreak >= 30],
      ['gold', '金', 'Lên hạng Vàng', peak >= 1200],
      ['diamond', '钻', 'Lên hạng Kim Cương', peak >= 1400],
      ['master', '师', 'Đại Sư', peak >= 1600],
      ['words100', '百', 'Thuộc 100 từ', learned >= 100],
      ['words1000', '千', 'Thuộc 1000 từ', learned >= 1000],
      ['perfect', '完', 'Một trận không sai', (p.perfect || 0) >= 1],
      ['daily', '日', 'Xong thử thách ngày', (p.dailyDone || 0) >= 1],
      ['daily7', '习', '7 ngày thử thách', (p.dailyDone || 0) >= 7],
    ];
    return specs.map(([id, zh, name, on]) => ({ id, zh, name, on: !!on }));
  }
  const self = p => ({
    ...pub(p),
    bestStreak: bestStreakOf(p),
    winStreak: p.winStreak || 0,
    bestWin: Math.max(p.bestWin || 0, p.winStreak || 0),
    peak: Math.max(p.peak || 0, p.rating),
    perfect: p.perfect || 0,
    drillBest: drillBestOf(p),
    surviveBest: surviveBestOf(p),
    dailyDone: p.dailyDone || 0,
    recent: (Array.isArray(p.recent) ? p.recent : []).slice(0, 8).filter(r => r && typeof r === 'object'),
    badges: badgeList(p),
  });
  // "month": Elo gained this month, only players who played a ranked match in it.
  let boards = {};
  let dailyCache = null;
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
  function dailyBoard() {
    const day = dayOf(now());
    if (dailyCache && dailyCache.day === day && now() - dailyCache.at < 5000) return dailyCache.list;
    const list = Object.values(players)
      .filter(p => p.daily?.d === day)
      .sort((a, c) => c.daily.correct - a.daily.correct || c.daily.score - a.daily.score || a.daily.ms - c.daily.ms)
      .slice(0, 20)
      .map(p => ({ ...pub(p), correct: p.daily.correct, score: p.daily.score, ms: p.daily.ms }));
    dailyCache = { at: now(), day, list };
    return list;
  }
  function questionView(p) {
    const att = p.attempt;
    const q = G.dailySet(WORDS, att.d)[att.i];
    return {
      n: att.i + 1, total: G.DAILY_ROUNDS, type: q.type, level: q.level, prompt: q.prompt, options: q.options,
      ms: Math.max(0, G.DAILY_MS - (now() - att.last)), correct: att.correct, score: att.score,
    };
  }
  function finishDaily(id) {
    const p = players[id], att = p.attempt;
    p.daily = { d: att.d, correct: att.correct, score: att.score, ms: Math.max(0, now() - att.at) };
    p.dailyDone = (p.dailyDone || 0) + 1;
    delete p.attempt;
    save(id);
    boards = {};
    dailyCache = null;
    return { done: true, correct: p.daily.correct, score: p.daily.score, ms: p.daily.ms, total: G.DAILY_ROUNDS, me: self(p), board: dailyBoard() };
  }
  // The open question is graded wrong once, then the clock starts on whatever comes next.
  // Resuming does not refill the timer, so leaving and coming back cannot buy extra time.
  function expireCurrent(id) {
    const p = players[id], att = p.attempt;
    if (!att || now() - att.last <= G.DAILY_MS + G.DAILY_GRACE_MS) return null;
    const q = G.dailySet(WORDS, att.d)[att.i];
    if (!q) return null;
    missed(id, q.word.id);
    att.i++;
    att.last = now();
    const reveal = { answer: q.answer, word: q.word, you: null, ok: false, gain: 0 };
    if (att.i >= G.DAILY_ROUNDS) return { reveal, ...finishDaily(id) };
    save(id);
    return { reveal, next: questionView(p), correct: att.correct, score: att.score };
  }
  // pid: short public id so a client can find itself on the leaderboard without exposing the real id.
  const newPlayer = name => ({ pid: randomHex(5), name: name.slice(0, 20), rating: G.START_RATING, wins: 0, losses: 0, learned: {}, wrong: {} });
  const emit = (conn, e, a) => conn.send({ e, a });

  const online = new Map(); // player id -> conn
  // Rate buckets follow the account once logged in, so reconnecting doesn't reset the count.
  const rates = new Map();  // player id or anonymous conn -> { t, n }
  let queue = [];           // { id, since }
  const challenges = new Map(); // target player id -> { from, at }
  const REACTIONS = ['加油', '厉害', '谢谢'];
  const CHALLENGE_MS = 60_000;
  let presenceSent = null;
  const presenceCounts = () => ({ online: online.size, queued: queue.length });
  function pushPresence() {
    const p = presenceCounts();
    if (presenceSent && presenceSent.online === p.online && presenceSent.queued === p.queued) return;
    presenceSent = p;
    for (const c of online.values()) emit(c, 'presence', p);
  }
  function idByPid(pid) {
    if (typeof pid !== 'string' || !/^[0-9a-f]{10}$/.test(pid)) return null;
    for (const id in players) if (players[id].pid === pid) return id;
    return null;
  }
  function clearChallenges(id) {
    const incoming = challenges.get(id);
    if (incoming) {
      challenges.delete(id);
      const from = online.get(incoming.from);
      if (from) emit(from, 'challengeClosed');
    }
    for (const [tid, c] of challenges) if (c.from === id) {
      challenges.delete(tid);
      const target = online.get(tid);
      if (target) emit(target, 'challengeClosed');
    }
  }

  // Last tab wins: a new login for the same account kicks the old connection.
  function attach(conn, id) {
    const old = online.get(id);
    if (old && old !== conn) { detach(old); emit(old, 'kicked'); old.close(); }
    if (conn.data.id && conn.data.id !== id) detach(conn);
    conn.data.id = id;
    conn.persist?.();
    online.set(id, conn);
    pushPresence();
  }
  function detach(conn) {
    const id = conn.data.id;
    if (!id || online.get(id) !== conn) return;
    online.delete(id);
    queue = queue.filter(q => q.id !== id);
    sql.exec('DELETE FROM invites WHERE host = ?', id);
    clearChallenges(id);
    if (conn.data.match) conn.data.match.forfeit(id);
    pushPresence();
  }
  async function newSession(conn, id) {
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    save(id);
    sql.exec('INSERT INTO sessions (token_hash, player_id, at) VALUES (?, ?, ?)', await sha256(token), id, now());
    attach(conn, id);
    return { token, me: self(players[id]), ranks: G.RANKS, presence: presenceCounts() };
  }
  const me = conn => players[conn.data.id];

  function membership(id) {
    return sql.exec('SELECT code FROM study_members WHERE player_id = ?', id).toArray()[0] || null;
  }
  // Names, seals, streaks and today's paper only. No Elo, and reading this writes nothing.
  function groupView(id) {
    const row = membership(id);
    if (!row) return { code: null, members: [] };
    const day = dayOf(now());
    const members = sql.exec('SELECT player_id FROM study_members WHERE code = ? ORDER BY joined, rowid', row.code).toArray();
    return {
      code: row.code,
      members: members.flatMap(r => {
        const p = players[r.player_id];
        if (!p) return [];
        return [{ name: p.name, seal: sealOf(p), streak: streakOf(p), daily: p.daily?.d === day, you: r.player_id === id }];
      }),
    };
  }

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
      const th = typeof token === 'string' && await sha256(token);
      const row = th && sql.exec('SELECT player_id, at FROM sessions WHERE token_hash = ?', th).toArray()[0];
      if (row && row.at < now() - SESSION_MS) sql.exec('DELETE FROM sessions WHERE token_hash = ?', th);
      if (!row || !players[row.player_id] || row.at < now() - SESSION_MS) return { error: 'Phiên đã hết hạn, hãy đăng nhập lại' };
      if (row.at < now() - RENEW_MS) sql.exec('UPDATE sessions SET at = ? WHERE token_hash = ?', now(), th);
      attach(conn, row.player_id);
      return { me: self(players[row.player_id]), ranks: G.RANKS, presence: presenceCounts() };
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
      return { me: self(p) };
    },
    seal(conn, { seal }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      if (!SEALS.includes(seal)) return { error: 'Con dấu không hợp lệ' };
      p.seal = seal;
      save(conn.data.id);
      boards = {};
      return { me: self(p) };
    },
    me(conn) { const p = me(conn); return p ? { me: self(p) } : { error: 'Chưa đăng nhập' }; },
    leaderboard: (conn, { period }) => leaderboard(period === 'month' ? 'month' : 'all'),
    // Practice: the answer is sent to the client because nothing is at stake.
    // `type` limits the question to one of the three real drills. Omitted means all three.
    practice(conn, { level, type } = {}) {
      if (!me(conn)) return { error: 'Chưa đăng nhập' };
      if (!validLevel(level)) return { error: 'Cấp HSK không hợp lệ' };
      let types;
      if (type !== undefined) {
        if (typeof type !== 'string' || !G.TYPES.some(t => t.type === type)) return { error: 'Dạng câu không hợp lệ' };
        types = G.TYPES.filter(t => t.type === type);
      }
      playedToday(conn.data.id);
      return types ? G.makeQuestion(WORDS, level, level, Math.random, types) : G.makeQuestion(WORDS, level, level);
    },
    // Review: the 10 most recently missed words.
    review(conn) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      const wrong = Object.entries(p.wrong || {}).filter(([id]) => WORD.has(id)).sort((a, b) => b[1] - a[1]);
      return { words: wrong.slice(0, 10).map(([id]) => WORD.get(id)), total: wrong.length };
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
      pushPresence();
      runMatch(inv.host, id, false).catch(e => console.error('match error', e));
      return {};
    },
    // Learn: next 10 words of a level the player hasn't marked as known, in list order.
    learn(conn, { level }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      if (!validLevel(level)) return { error: 'Cấp HSK không hợp lệ' };
      const fresh = WORDS[level].filter(w => !p.learned[w.id]);
      return { words: fresh.slice(0, 10), learned: WORDS[level].length - fresh.length, total: WORDS[level].length };
    },
    progress(conn) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      const learned = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
      for (const id in p.learned) learned[WORD_LEVEL.get(id)]++;
      return { learned, total: TOTALS, wrong: Object.keys(p.wrong || {}).length };
    },
    learned(conn, { id, h: legacy, known }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      const h = wordId(id ?? legacy);
      if (!h) return { error: 'Từ không tồn tại' };
      // Knowing a word also takes it off the review list.
      const before = JSON.stringify([p.learned[h], p.wrong?.[h]]);
      if (known) { p.learned[h] = 1; if (p.wrong) delete p.wrong[h]; } else delete p.learned[h];
      if (JSON.stringify([p.learned[h], p.wrong?.[h]]) !== before) save(conn.data.id);
      if (known) playedToday(conn.data.id);
      return {};
    },
    // Today's paper. Same ten questions for everyone; the server scores them. One finished run per day.
    // Progress is stored on the player (not in memory) so a hibernating Durable Object can resume it.
    // Each answer is one write: the run has to survive a restart, and a second begin must not rewind it.
    daily(conn) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      const day = dayOf(now());
      const w = G.wordOfDay(WORDS, day);
      return {
        day,
        word: { h: w.h, p: w.p, m: w.m, vi: w.vi || '', en: w.en || '', level: w.level },
        mine: p.daily?.d === day ? { correct: p.daily.correct, score: p.daily.score, ms: p.daily.ms } : null,
        attempt: p.attempt?.d === day ? { n: p.attempt.i + 1, correct: p.attempt.correct, score: p.attempt.score } : null,
        board: dailyBoard(),
        total: G.DAILY_ROUNDS,
      };
    },
    dailyBegin(conn) {
      const id = conn.data.id;
      const p = players[id];
      if (!p) return { error: 'Chưa đăng nhập' };
      if (conn.data.match) return { error: 'Bạn đang trong trận' };
      const day = dayOf(now());
      if (p.daily?.d === day) return { error: 'Bạn đã hoàn thành thử thách hôm nay' };
      queue = queue.filter(q => q.id !== id);
      pushPresence();
      if (p.attempt && p.attempt.d !== day) delete p.attempt;
      if (p.attempt?.d === day && (!Number.isInteger(p.attempt.i) || p.attempt.i < 0 || p.attempt.i >= G.DAILY_ROUNDS)) delete p.attempt;
      if (p.attempt?.d === day) {
        const skipped = expireCurrent(id);
        if (skipped) return skipped;
        return questionView(p);
      }
      rollDay(p);
      p.attempt = { d: day, i: 0, correct: 0, score: 0, at: now(), last: now() };
      save(id);
      return questionView(p);
    },
    dailyAnswer(conn, { i } = {}) {
      const id = conn.data.id;
      const p = players[id];
      if (!p) return { error: 'Chưa đăng nhập' };
      const day = dayOf(now());
      const att = p.attempt;
      if (att && att.d !== day) { delete p.attempt; save(id); return { error: 'Thử thách đã sang ngày mới. Hãy bắt đầu lại.' }; }
      if (!att) return p.daily?.d === day ? { error: 'Bạn đã hoàn thành thử thách hôm nay' } : { error: 'Hãy bắt đầu thử thách' };
      if (!Number.isInteger(att.i) || att.i < 0 || att.i >= G.DAILY_ROUNDS) {
        delete p.attempt; save(id);
        return { error: 'Thử thách bị lỗi, hãy bắt đầu lại' };
      }
      const q = G.dailySet(WORDS, day)[att.i];
      const elapsed = now() - att.last;
      const tooSlow = elapsed > G.DAILY_MS + G.DAILY_GRACE_MS;
      const choice = Number.isInteger(i) && i >= 0 && i < 4 ? i : null;
      const ok = choice !== null && !tooSlow && choice === q.answer;
      const gain = ok ? G.points(true, Math.max(0, G.DAILY_MS - elapsed), G.DAILY_MS) : 0;
      if (ok) { att.correct++; att.score += gain; }
      else missed(id, q.word.id);
      att.i++;
      att.last = now();
      const reveal = { answer: q.answer, word: q.word, you: choice, ok, gain };
      if (att.i >= G.DAILY_ROUNDS) return { reveal, ...finishDaily(id) };
      save(id);
      return { reveal, next: questionView(p), correct: att.correct, score: att.score };
    },
    // Personal best only — there is no public drill ladder, so a capped self-report is enough.
    drillBest(conn, { level, score }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      if (!validLevel(level) || !Number.isInteger(score) || score < 1 || score > DRILL_CAP) return { error: 'Kỷ lục không hợp lệ' };
      p.drillBest ??= {};
      if (score > (p.drillBest[level] || 0)) { p.drillBest[level] = score; save(conn.data.id); }
      return { drillBest: drillBestOf(p) };
    },
    // Survival is the same kind of record: own account, capped, never a ladder and never Elo.
    surviveBest(conn, { level, score }) {
      const p = me(conn);
      if (!p) return { error: 'Chưa đăng nhập' };
      if (!validLevel(level) || !Number.isInteger(score) || score < 1 || score > DRILL_CAP) return { error: 'Kỷ lục không hợp lệ' };
      p.surviveBest ??= {};
      if (score > (p.surviveBest[level] || 0)) { p.surviveBest[level] = score; save(conn.data.id); }
      return { surviveBest: surviveBestOf(p) };
    },
    // Up to 24 words that contain one listed character. Empty and multi-character queries are rejected.
    family(conn, { q } = {}) {
      if (!me(conn)) return { error: 'Chưa đăng nhập' };
      const raw = typeof q === 'string' ? q.trim() : '';
      const chars = [...raw];
      if (chars.length !== 1) return { error: 'Hãy nhập một chữ' };
      const list = FAMILY.get(chars[0]);
      if (!list) return { error: 'Không có chữ này trong danh sách' };
      return { ch: chars[0], words: list.slice(0, FAMILY_CAP) };
    },
    group(conn) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      return groupView(id);
    },
    groupCreate(conn) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      if (membership(id)) return { error: 'Bạn đã ở trong một nhóm' };
      let code = '';
      for (let n = 0; n < 5 && !code; n++) {
        const next = randomHex(3);
        if (!sql.exec('SELECT code FROM study_groups WHERE code = ?', next).toArray()[0]) code = next;
      }
      if (!code) return { error: 'Chưa tạo được mã, thử lại' };
      const t = now();
      sql.exec('INSERT INTO study_groups (code, created) VALUES (?, ?)', code, t);
      sql.exec('INSERT INTO study_members (player_id, code, joined) VALUES (?, ?, ?)', id, code, t);
      return groupView(id);
    },
    groupJoin(conn, { code } = {}) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
      if (!/^[0-9a-f]{6}$/.test(c)) return { error: 'Mã nhóm không hợp lệ' };
      if (!sql.exec('SELECT code FROM study_groups WHERE code = ?', c).toArray()[0]) return { error: 'Không thấy nhóm này' };
      const cur = membership(id);
      if (cur?.code === c) return groupView(id);
      if (cur) return { error: 'Hãy rời nhóm hiện tại trước' };
      const n = sql.exec('SELECT count(*) AS n FROM study_members WHERE code = ?', c).toArray()[0].n;
      if (Number(n) >= GROUP_CAP) return { error: 'Nhóm đã đủ người' };
      sql.exec('INSERT INTO study_members (player_id, code, joined) VALUES (?, ?, ?)', id, c, now());
      return groupView(id);
    },
    groupLeave(conn) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      const cur = membership(id);
      if (!cur) return { error: 'Bạn chưa có nhóm' };
      sql.exec('DELETE FROM study_members WHERE player_id = ?', id);
      const left = sql.exec('SELECT count(*) AS n FROM study_members WHERE code = ?', cur.code).toArray()[0].n;
      if (!Number(left)) sql.exec('DELETE FROM study_groups WHERE code = ?', cur.code);
      return { code: null, members: [] };
    },
    // Unranked, like an invite: a public pid is not a way to mint Elo.
    challenge(conn, { pid }) {
      const id = conn.data.id;
      const p = players[id];
      if (!p) return { error: 'Chưa đăng nhập' };
      if (conn.data.match) return { error: 'Bạn đang trong trận' };
      const oppId = idByPid(pid);
      if (!oppId) return { error: 'Không tìm thấy người chơi' };
      if (oppId === id) return { error: 'Không thể thách đấu chính mình' };
      const opp = online.get(oppId);
      if (!opp) return { error: 'Người này đang offline' };
      if (opp.data.match) return { error: 'Người này đang trong trận' };
      const prev = challenges.get(oppId);
      if (prev && prev.from !== id) {
        const old = online.get(prev.from);
        if (old) emit(old, 'challengeClosed');
      }
      challenges.set(oppId, { from: id, at: now() });
      emit(opp, 'challenge', pub(p));
      return {};
    },
    accept(conn) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      const c = challenges.get(id);
      if (!c || now() - c.at > CHALLENGE_MS) { challenges.delete(id); return { error: 'Lời thách đấu đã hết' }; }
      challenges.delete(id);
      if (conn.data.match) return { error: 'Bạn đang trong trận' };
      const from = online.get(c.from);
      if (!from || !players[c.from]) return { error: 'Người thách đấu đã rời đi' };
      if (from.data.match) return { error: 'Người này đang trong trận' };
      queue = queue.filter(q => q.id !== id && q.id !== c.from);
      pushPresence();
      runMatch(c.from, id, false).catch(e => console.error('match error', e));
      return {};
    },
    decline(conn) {
      const id = conn.data.id;
      if (!players[id]) return { error: 'Chưa đăng nhập' };
      const c = challenges.get(id);
      challenges.delete(id);
      if (c) { const from = online.get(c.from); if (from) emit(from, 'challengeClosed'); }
      return {};
    },
  };

  // Fire-and-forget events.
  const fires = {
    queue(conn) {
      const id = conn.data.id;
      if (id && players[id] && !conn.data.match && !queue.some(q => q.id === id)) { queue.push({ id, since: Date.now() }); startMatchmaker(); pushPresence(); }
    },
    unqueue(conn) { queue = queue.filter(q => q.id !== conn.data.id); pushPresence(); },
    // Fixed phrases only. Anything else is ignored, and the sender does not hear their own.
    react(conn, text) {
      const m = conn.data.match;
      if (!m || typeof text !== 'string' || !REACTIONS.includes(text)) return;
      m.react(conn.data.id, text);
    },
    answer(conn, i) {
      const m = conn.data.match;
      if (m && Number.isInteger(i) && i >= 0 && i < 4) m.answer(conn.data.id, i);
    },
    // Drill answers are checked in the browser, so the browser reports its misses.
    missed(conn, word) {
      const id = conn.data.id, h = wordId(word);
      if (!players[id] || !h) return;
      const fresh = !players[id].wrong?.[h];
      missed(id, h);
      if (fresh) save(id); // a repeat miss only reorders the list; not worth a write
    },
  };

  // Pair closest ratings; allowed gap widens the longer people wait.
  // Runs only while someone is queued, so an idle Durable Object can hibernate.
  let matchmaker = null;
  function startMatchmaker() { matchmaker ??= setInterval(matchmake, 1000); }
  function matchmake() {
    queue = queue.filter(q => online.has(q.id) && !online.get(q.id).data.match);
    if (!queue.length) { clearInterval(matchmaker); matchmaker = null; pushPresence(); return; }
    queue.sort((a, b) => players[a.id].rating - players[b.id].rating);
    const now = Date.now();
    for (let i = 0; i < queue.length - 1; i++) {
      const a = queue[i], b = queue[i + 1];
      const gap = 100 + 20 * Math.min(now - a.since, now - b.since) / 1000;
      if (Math.abs(players[a.id].rating - players[b.id].rating) <= gap) {
        queue.splice(i, 2);
        i--;
        pushPresence();
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
    const wrongs = { [idA]: 0, [idB]: 0 };
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
      react(id, text) {
        const k = ids.indexOf(id);
        if (k >= 0) emit(conns[1 - k], 'react', text);
      },
    };
    let waiting = arm(3000);
    conns.forEach((c, k) => {
      c.data.match = match;
      emit(c, 'start', { opponent: pub(players[ids[1 - k]]), hsk, rounds: G.ROUNDS, ranked });
    });
    await waiting;

    for (let n = 1; n <= G.ROUNDS && !forfeiter; n++) {
      const q = G.makeQuestion(WORDS, hsk, 1, Math.random, G.PVP_TYPES);
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
        if (p?.i !== q.answer) { wrongs[id]++; missed(id, q.word.id); }
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
    ids.forEach((id, k) => {
      const p = players[id];
      const res = k === 0 ? result : 1 - result;
      if (ranked) {
        if (res === 1) p.winStreak = (p.winStreak || 0) + 1;
        else if (res === 0) p.winStreak = 0;
        p.bestWin = Math.max(p.bestWin || 0, p.winStreak || 0);
      }
      p.peak = Math.max(p.peak || 0, p.rating);
      const clean = !forfeiter && wrongs[id] === 0;
      if (clean) p.perfect = (p.perfect || 0) + 1;
      const opp = players[ids[1 - k]];
      const recent = Array.isArray(p.recent) ? p.recent : [];
      p.recent = [{
        t: now(), opp: opp.name, pid: opp.pid, seal: sealOf(opp), ranked: !!ranked, result: res,
        score: score[id], oppScore: score[ids[1 - k]], delta: p.rating - before[k],
        forfeit: !!forfeiter, perfect: clean,
      }, ...recent].slice(0, 8);
    });
    ids.forEach(save);
    ids.forEach(playedToday);
    boards = {};

    conns.forEach((c, k) => {
      c.data.match = null;
      emit(c, 'end', {
        ranked, result: k === 0 ? result : 1 - result, forfeit: !!forfeiter, left: forfeiter === ids[k],
        score: score[ids[k]], oppScore: score[ids[1 - k]],
        perfect: !forfeiter && wrongs[ids[k]] === 0,
        delta: players[ids[k]].rating - before[k], me: self(players[ids[k]]),
      });
    });
  }

  return {
    guest: GUEST_OK,
    async message(conn, text) {
      if (typeof text !== 'string' || text.length > MAX_MESSAGE) return;
      const key = conn.data.id || conn;
      let rate = rates.get(key);
      if (!rate || now() - rate.t > RATE_WINDOW_MS) rates.set(key, rate = { t: now(), n: 0 });
      if (++rate.n > RATE_MAX) return;
      // shortcut: anonymous buckets are swept only here; fine while the object restarts on every deploy.
      if (rates.size > 5000) for (const [k, r] of rates) if (now() - r.t > RATE_WINDOW_MS) rates.delete(k);
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
    restore(conns) { for (const c of conns) if (c.data.id && players[c.data.id]) online.set(c.data.id, c); pushPresence(); },
  };
}
