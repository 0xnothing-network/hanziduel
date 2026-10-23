const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');
const G = require('./game');
const { openStore } = require('./store');

const WORDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/words.json'), 'utf8'));
const WORD_LEVEL = new Map(Object.entries(WORDS).flatMap(([lv, ws]) => ws.map(w => [w.h, +lv])));
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const validLevel = lv => Number.isInteger(lv) && lv >= 1 && lv <= 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start({
  port = process.env.PORT || 3000,
  clientId = process.env.GOOGLE_CLIENT_ID || '',
  databaseUrl = process.env.DATABASE_URL || '',
  file = process.env.DB_FILE || path.join(__dirname, 'data/db.json'),
} = {}) {
  // Without a Google client id the server runs in dev mode and allows guest login.
  const GUEST_OK = !clientId;
  const google = clientId && new OAuth2Client(clientId);
  const store = await openStore({ databaseUrl, file });
  const players = store.players;

  // pid: short public id so a client can find itself on the leaderboard without exposing the real id.
  const pidOf = new Map();
  const pid = id => pidOf.get(id) || pidOf.set(id, hash('pid:' + id).slice(0, 10)).get(id);
  const pub = (p, id) => ({ pid: pid(id), name: p.name, rating: p.rating, rank: G.rankOf(p.rating).name, hsk: G.rankOf(p.rating).hsk, wins: p.wins, losses: p.losses });
  let board = null, boardAt = 0;
  const leaderboard = () => {
    if (!board || Date.now() - boardAt > 5000) {
      board = Object.entries(players).sort((a, b) => b[1].rating - a[1].rating).slice(0, 20).map(([id, p]) => pub(p, id));
      boardAt = Date.now();
    }
    return board;
  };

  // The page is built once, precompressed, and revalidated by ETag.
  const html = Buffer.from(fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').replace('%GOOGLE_CLIENT_ID%', clientId));
  const page = {
    etag: `"${hash(html).slice(0, 16)}"`,
    raw: html,
    gzip: zlib.gzipSync(html, { level: 9 }),
    br: zlib.brotliCompressSync(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
  };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url !== '/' && url !== '/index.html') { res.writeHead(404); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: page.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === page.etag) { res.writeHead(304, headers); return res.end(); }
    const enc = req.headers['accept-encoding'] || '';
    const [body, ce] = /\bbr\b/.test(enc) ? [page.br, 'br'] : /\bgzip\b/.test(enc) ? [page.gzip, 'gzip'] : [page.raw, null];
    if (ce) headers['Content-Encoding'] = ce;
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  // Every client message is tiny; cap it so a client can't push megabytes.
  const io = new Server(server, { maxHttpBufferSize: 10_000 });

  const online = new Map(); // player id -> socket
  let queue = [];           // { id, since }

  // Last tab wins: a new login for the same account kicks the old socket.
  function attach(socket, id) {
    const old = online.get(id);
    if (old && old !== socket) { detach(old); old.emit('kicked'); old.disconnect(true); }
    if (socket.data.id && socket.data.id !== id) detach(socket);
    socket.data.id = id;
    online.set(id, socket);
  }
  function detach(socket) {
    const id = socket.data.id;
    if (!id || online.get(id) !== socket) return;
    online.delete(id);
    queue = queue.filter(q => q.id !== id);
    if (socket.data.match) socket.data.match.forfeit(id);
  }
  async function newSession(socket, id, ack) {
    const token = crypto.randomBytes(32).toString('base64url');
    store.touch(id);
    await store.addSession(hash(token), id);
    attach(socket, id);
    ack({ token, me: pub(players[id], id), ranks: G.RANKS });
  }
  const newPlayer = name => ({ name: name.slice(0, 20), rating: G.START_RATING, wins: 0, losses: 0, learned: {} });

  io.on('connection', socket => {
    const on = (ev, fn) => socket.on(ev, (arg, ack) => {
      if (typeof ack !== 'function') return;
      const input = arg && typeof arg === 'object' ? arg : {};
      Promise.resolve().then(() => fn(input, ack)).catch(e => { console.error(ev, e.message); ack({ error: 'Lỗi máy chủ, thử lại sau' }); });
    });
    const authed = fn => (arg, ack) => socket.data.id ? fn(arg, ack, players[socket.data.id]) : ack({ error: 'Chưa đăng nhập' });

    on('login', async ({ credential }, ack) => {
      if (!google) return ack({ error: 'Máy chủ chưa cấu hình Google' });
      if (typeof credential !== 'string' || credential.length > 4096) return ack({ error: 'Thiếu token' });
      let p;
      try { p = (await google.verifyIdToken({ idToken: credential, audience: clientId })).getPayload(); }
      catch { return ack({ error: 'Đăng nhập Google thất bại' }); }
      const id = 'g:' + p.sub;
      players[id] ??= newPlayer(p.name || (p.email || 'Người chơi').split('@')[0]);
      await newSession(socket, id, ack);
    });

    on('guest', async ({ name }, ack) => {
      if (!GUEST_OK) return ack({ error: 'Hãy đăng nhập bằng Google' });
      name = typeof name === 'string' ? name.trim() : '';
      if (!name) return ack({ error: 'Hãy nhập tên' });
      const id = 'u:' + crypto.randomUUID();
      players[id] = newPlayer(name);
      await newSession(socket, id, ack);
    });

    on('resume', ({ token }, ack) => {
      const id = typeof token === 'string' && store.sessions[hash(token)];
      if (!id || !players[id]) return ack({ error: 'Phiên đã hết hạn, hãy đăng nhập lại' });
      attach(socket, id);
      ack({ me: pub(players[id], id), ranks: G.RANKS });
    });

    on('logout', async ({ token }, ack) => {
      if (typeof token === 'string') await store.removeSession(hash(token));
      detach(socket);
      socket.data.id = null;
      ack({});
    });

    on('rename', authed(({ name }, ack, p) => {
      name = typeof name === 'string' ? name.trim().slice(0, 20) : '';
      if (!name) return ack({ error: 'Tên không hợp lệ' });
      p.name = name;
      store.touch(socket.data.id);
      board = null;
      ack({ me: pub(p, socket.data.id) });
    }));

    on('leaderboard', (_, ack) => ack(leaderboard()));

    // Practice: answer is sent to the client because nothing is at stake.
    on('practice', authed(({ level }, ack) => {
      if (!validLevel(level)) return ack({ error: 'Cấp HSK không hợp lệ' });
      ack(G.makeQuestion(WORDS, level, level));
    }));

    // Learn: next 10 words of a level the player hasn't marked as known, in list order.
    on('learn', authed(({ level }, ack, p) => {
      if (!validLevel(level)) return ack({ error: 'Cấp HSK không hợp lệ' });
      const fresh = WORDS[level].filter(w => !p.learned[w.h]);
      ack({ words: fresh.slice(0, 10), learned: WORDS[level].length - fresh.length, total: WORDS[level].length });
    }));
    on('progress', authed((_, ack, p) => {
      const learned = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
      for (const h in p.learned) learned[WORD_LEVEL.get(h)]++;
      ack({ learned, total: Object.fromEntries(Object.entries(WORDS).map(([lv, ws]) => [lv, ws.length])) });
    }));
    on('learned', authed(({ h, known }, ack, p) => {
      if (typeof h !== 'string' || !WORD_LEVEL.has(h)) return ack({ error: 'Từ không tồn tại' });
      if (known) p.learned[h] = 1; else delete p.learned[h];
      store.touch(socket.data.id);
      ack({});
    }));

    socket.on('queue', () => {
      const id = socket.data.id;
      if (id && !socket.data.match && !queue.some(q => q.id === id)) queue.push({ id, since: Date.now() });
    });
    socket.on('unqueue', () => { queue = queue.filter(q => q.id !== socket.data.id); });

    socket.on('answer', i => {
      const m = socket.data.match;
      if (m && Number.isInteger(i) && i >= 0 && i < 4) m.answer(socket.data.id, i);
    });

    socket.on('disconnect', () => detach(socket));
  });

  // Pair closest ratings; allowed gap widens the longer people wait.
  const matchmaker = setInterval(() => {
    queue = queue.filter(q => online.has(q.id) && !online.get(q.id).data.match);
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
  }, 1000);
  matchmaker.unref();

  async function runMatch(idA, idB) {
    const ids = [idA, idB];
    const sockets = ids.map(id => online.get(id));
    // Pool is capped by the lower-ranked player so neither gets words above their rank.
    const hsk = Math.min(...ids.map(id => G.rankOf(players[id].rating).hsk));
    const score = { [idA]: 0, [idB]: 0 };
    let picks = {}, sentAt = 0, roundDone = () => {}, forfeiter = null;

    const match = {
      answer(id, i) {
        if (id in picks || !sentAt) return;
        picks[id] = { i, ms: Date.now() - sentAt };
        sockets[1 - ids.indexOf(id)].emit('oppAnswered'); // only that they answered, never what
        if (Object.keys(picks).length === 2) roundDone();
      },
      // First player to leave loses, even if the other leaves afterwards.
      forfeit(id) { forfeiter ??= id; roundDone(); },
    };
    sockets.forEach((s, k) => {
      s.data.match = match;
      s.emit('start', { opponent: pub(players[ids[1 - k]], ids[1 - k]), hsk, rounds: G.ROUNDS });
    });
    await Promise.race([sleep(3000), new Promise(r => { roundDone = r; })]);

    for (let n = 1; n <= G.ROUNDS && !forfeiter; n++) {
      const q = G.makeQuestion(WORDS, hsk);
      picks = {};
      sentAt = Date.now();
      io.to(sockets.map(s => s.id)).emit('question', { n, type: q.type, level: q.level, prompt: q.prompt, options: q.options, ms: G.ROUND_MS });
      await Promise.race([sleep(G.ROUND_MS + 500), new Promise(r => { roundDone = r; })]);
      sentAt = 0;
      if (forfeiter) break;
      for (const id of ids) {
        const p = picks[id];
        if (p) score[id] += G.points(p.i === q.answer, G.ROUND_MS - p.ms);
      }
      sockets.forEach((s, k) => s.emit('reveal', {
        answer: q.answer, word: q.word,
        you: picks[ids[k]]?.i ?? null, opp: picks[ids[1 - k]]?.i ?? null,
        score: score[ids[k]], oppScore: score[ids[1 - k]],
      }));
      await Promise.race([sleep(2000), new Promise(r => { roundDone = r; })]);
    }

    const result = forfeiter ? (forfeiter === idB ? 1 : 0)
      : score[idA] > score[idB] ? 1 : score[idA] < score[idB] ? 0 : 0.5;
    const [pa, pb] = [players[idA], players[idB]];
    const before = [pa.rating, pb.rating];
    [pa.rating, pb.rating] = G.elo(pa.rating, pb.rating, result);
    if (result === 1) { pa.wins++; pb.losses++; } else if (result === 0) { pb.wins++; pa.losses++; }
    ids.forEach(id => store.touch(id));
    board = null;
    await store.flush(); // ratings are the data people care about most: write now, not later

    sockets.forEach((s, k) => {
      s.data.match = null;
      const me = players[ids[k]];
      s.emit('end', {
        result: k === 0 ? result : 1 - result, forfeit: !!forfeiter, left: forfeiter === ids[k],
        score: score[ids[k]], oppScore: score[ids[1 - k]],
        delta: me.rating - before[k], me: pub(me, ids[k]),
      });
    });
  }

  await new Promise(r => server.listen(port, r));
  return {
    server,
    port: server.address().port,
    guest: GUEST_OK,
    async close() {
      clearInterval(matchmaker);
      io.close();
      await store.close();
    },
  };
}

if (require.main === module) {
  start().then(app => {
    console.log(`http://localhost:${app.port}${app.guest ? ' (dev: guest login on)' : ''}${process.env.DATABASE_URL ? ' [postgres]' : ' [json file]'}`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => app.close().finally(() => process.exit(0)));
  }).catch(e => { console.error('failed to start:', e.message); process.exit(1); });
}

module.exports = { start };
