// Pure game rules (no I/O) so they can be tested.

// Higher rank unlocks higher HSK levels; level 7 = HSK 7-9.
const RANKS = [
  { name: 'Đồng', min: 0, hsk: 1 },
  { name: 'Bạc', min: 1100, hsk: 2 },
  { name: 'Vàng', min: 1200, hsk: 3 },
  { name: 'Bạch Kim', min: 1300, hsk: 4 },
  { name: 'Kim Cương', min: 1400, hsk: 5 },
  { name: 'Cao Thủ', min: 1500, hsk: 6 },
  { name: 'Đại Sư', min: 1600, hsk: 7 },
];
const START_RATING = 1000;
const ROUNDS = 10;
const ROUND_MS = 10000;

const rankOf = rating => RANKS.findLast(r => rating >= r.min);

// Standard Elo; scoreA is 1 (A wins), 0.5 (draw) or 0.
function elo(ra, rb, scoreA, k = 32) {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const d = Math.round(k * (scoreA - ea));
  return [Math.max(0, ra + d), Math.max(0, rb - d)];
}

// Correct answers earn 50 + up to 50 speed bonus.
const points = (correct, msLeft) =>
  correct ? 50 + Math.round(50 * Math.max(0, Math.min(msLeft, ROUND_MS)) / ROUND_MS) : 0;

// Listening asks for the meaning, not the character: the spoken hanzi has to reach the browser,
// so "listen → pick the character" would hand every player the answer.
const TYPES = [
  { type: 'Hán → Việt', ask: 'h', show: 'm' },
  { type: 'Việt → Hán', ask: 'm', show: 'h' },
  { type: 'Nghe → nghĩa', ask: 'h', show: 'm', listen: true },
];
// No listening in PvP: a player without sound or a Chinese voice would be at a disadvantage.
const PVP_TYPES = TYPES.filter(t => !t.listen);

// Half the questions come from maxLevel, the rest from minLevel..maxLevel-1.
function makeQuestion(words, maxLevel, minLevel = 1, rand = Math.random, types = TYPES) {
  const level = maxLevel === minLevel || rand() < 0.5 ? maxLevel : minLevel + Math.floor(rand() * (maxLevel - minLevel));
  const pool = words[level];
  const word = pool[Math.floor(rand() * pool.length)];
  const t = types[Math.floor(rand() * types.length)];
  const options = [word[t.show]];
  for (let tries = 0; options.length < 4 && tries < 200; tries++) {
    const w = pool[Math.floor(rand() * pool.length)];
    if (!options.includes(w[t.show]) && w[t.ask] !== word[t.ask]) options.push(w[t.show]);
  }
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  // hint: pinyin, shown only when the browser has no Chinese voice.
  return { type: t.type, listen: !!t.listen, hint: t.listen ? word.p : undefined, level, prompt: word[t.ask], options, answer: options.indexOf(word[t.show]), word };
}

export { RANKS, START_RATING, ROUNDS, ROUND_MS, PVP_TYPES, rankOf, elo, points, makeQuestion };
