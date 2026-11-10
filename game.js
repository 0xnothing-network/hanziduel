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

// Correct answers earn 50 + up to 50 speed bonus. `window` is the time the bonus is spread over.
const points = (correct, msLeft, window = ROUND_MS) =>
  correct ? 50 + Math.round(50 * Math.max(0, Math.min(msLeft, window)) / window) : 0;

// One shared daily paper: a fixed ramp, not the PvP "half from the top" mix, so every player
// faces the same ten questions. No listening — a missing voice would make the day unfair.
const DAILY_ROUNDS = 10;
const DAILY_MS = 12000;
const DAILY_GRACE_MS = 3000; // late packets still count; after this the question is wrong
const DAILY_PLAN = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function dailySet(words, day) {
  const rand = mulberry32(hashString(`hanziduel:${day}`));
  return DAILY_PLAN.map(lv => makeQuestion(words, lv, lv, rand, PVP_TYPES));
}
// A teaching card, never one of today's questions, so revealing it does not hand over an answer.
function wordOfDay(words, day) {
  const used = new Set(dailySet(words, day).map(q => q.word.id));
  const pool = words[1];
  const start = hashString(`wotd:${day}`) % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const w = pool[(start + k) % pool.length];
    if (!used.has(w.id)) return { id: w.id, h: w.h, p: w.p, m: w.m, vi: w.vi, en: w.en, level: 1 };
  }
  const w = pool[start];
  return { id: w.id, h: w.h, p: w.p, m: w.m, vi: w.vi, en: w.en, level: 1 };
}

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

// Tone marks and tone numbers are the same answer. The digit sits on the vowel that would
// carry the mark, so zhōng and zhong1 both become zho1ng. Neutral tone (no mark, or 5) adds nothing.
// ü may be written ü, v, or u:. Spaces, case, and apostrophes are ignored; an apostrophe still
// splits syllables, so xī'ān and xi1an1 match each other and not xian1.
const TONE_MARK = {
  ā: 'a1', á: 'a2', ǎ: 'a3', à: 'a4',
  ē: 'e1', é: 'e2', ě: 'e3', è: 'e4',
  ī: 'i1', í: 'i2', ǐ: 'i3', ì: 'i4',
  ō: 'o1', ó: 'o2', ǒ: 'o3', ò: 'o4',
  ū: 'u1', ú: 'u2', ǔ: 'u3', ù: 'u4',
  ǖ: 'v1', ǘ: 'v2', ǚ: 'v3', ǜ: 'v4',
  ń: 'n2', ň: 'n3', ǹ: 'n4',
};
const PINYIN_INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];
const PINYIN_FINALS = ['iang', 'iong', 'uang', 'ueng', 'ang', 'eng', 'ing', 'ong', 'iao', 'ian', 'uan', 'uai', 'van', 'ia', 'ie', 'iu', 'in', 'un', 'ui', 'ua', 'uo', 'ue', 've', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'er', 'vn', 'ng', 'a', 'o', 'e', 'i', 'u', 'v', 'n', 'm'];
function toneIndex(final) {
  const a = final.indexOf('a'); if (a >= 0) return a;
  const e = final.indexOf('e'); if (e >= 0) return e;
  if (final.includes('ou')) return final.indexOf('o');
  for (let i = final.length - 1; i >= 0; i--) if ('aeiouüv'.includes(final[i])) return i;
  return -1;
}
function withTone(final, tone) {
  if (!tone || tone === '5') return final;
  const i = toneIndex(final);
  if (i < 0) return final;
  return final.slice(0, i + 1) + tone + final.slice(i + 1);
}
// Split pinyin into colored pieces. tone 1–4 and 5 (neutral) keep their mark or trailing
// digit on `text`; tone 0 is a separator (space, apostrophe, hyphen, slash) with no color job.
// Segmentation matches canonPinyin, so zhōngguó and zhong1guo2 stay the same answer.
function segmentPinyin(raw) {
  const src = String(raw ?? '').normalize('NFC');
  let letters = '';
  const inline = [];
  const spans = [];
  const trails = [];
  const breaks = new Set();
  let i = 0;
  while (i < src.length) {
    if (src.slice(i, i + 2).toLowerCase() === 'u:') {
      letters += 'v';
      spans.push([i, i + 2]);
      i += 2;
      continue;
    }
    const ch = src[i];
    const low = ch.toLowerCase();
    if (low === "'" || ch === '’' || low === ' ') { breaks.add(letters.length); i++; continue; }
    if (low.length === 1 && low >= '1' && low <= '5') {
      trails.push({ at: letters.length, tone: low, start: i, end: i + 1 });
      i++;
      continue;
    }
    const marked = low.length === 1 ? TONE_MARK[low] : null;
    if (marked) {
      letters += marked[0];
      inline[letters.length - 1] = marked[1];
      spans.push([i, i + 1]);
      i++;
      continue;
    }
    if (low === 'ü') { letters += 'v'; spans.push([i, i + 1]); i++; continue; }
    if (low.length === 1 && low >= 'a' && low <= 'z') { letters += low; spans.push([i, i + 1]); i++; continue; }
    i++;
  }
  const initials = [...PINYIN_INITIALS].sort((a, b) => b.length - a.length);
  const finals = [...PINYIN_FINALS].sort((a, b) => b.length - a.length);
  const crosses = (from, end) => [...breaks].some(b => b > from && b < end) || trails.some(tr => tr.at > from && tr.at < end);
  const syl = [];
  let n = 0;
  while (n < letters.length) {
    let ini = '';
    for (const s of initials) {
      if (letters.startsWith(s, n) && finals.some(f => letters.startsWith(f, n + s.length))) { ini = s; break; }
    }
    const from = n + ini.length;
    let fin = '';
    for (const f of finals) {
      if (!letters.startsWith(f, from) || crosses(from, from + f.length)) continue;
      fin = f;
      break;
    }
    if (!fin) {
      syl.push({ canon: letters[n], tone: inline[n] ? +inline[n] : 5, start: spans[n][0], end: spans[n][1] });
      n++;
      continue;
    }
    let end = from + fin.length;
    // 儿 at the end of a syllable (háir) is not the start of a new one (hǎo rè).
    let er = '';
    if (letters[end] === 'r' && !breaks.has(end) && !finals.some(f => letters.startsWith(f, end + 1))) er = 'r';
    end += er.length;
    let tone = '';
    for (let k = from; k < end - er.length; k++) if (inline[k]) tone = inline[k];
    const hooked = trails.filter(tr => tr.at === end);
    tone = tone || hooked[0]?.tone || '';
    let stop = spans[end - 1][1];
    if (hooked.length && hooked[0].start === stop) stop = hooked[hooked.length - 1].end;
    syl.push({ canon: ini + withTone(fin, tone) + er, tone: !tone || tone === '5' ? 5 : +tone, start: spans[n][0], end: stop });
    n = end;
  }
  const parts = [];
  let cursor = 0;
  for (const s of syl) {
    if (s.start > cursor) parts.push({ text: src.slice(cursor, s.start), tone: 0 });
    if (s.end > s.start) parts.push({ text: src.slice(s.start, s.end), tone: s.tone, canon: s.canon });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < src.length) parts.push({ text: src.slice(cursor), tone: 0 });
  return parts;
}
function pinyinSyllables(raw) {
  return segmentPinyin(raw).map(({ text, tone }) => ({ text, tone }));
}
function canonPinyin(raw) {
  return segmentPinyin(raw).map(p => p.canon || '').join('');
}
const TONE_CHOICES = ['Thanh 1', 'Thanh 2', 'Thanh 3', 'Thanh 4', 'Thanh nhẹ'];
// One question per syllable. A slash is two readings (谁 shéi/shuí), not a compound;
// callers that want a compound skip those words. Nothing here is ranked.
function toneDrill(word) {
  const p = typeof word === 'string' ? word : word?.p;
  if (typeof p !== 'string') return [];
  return pinyinSyllables(p).filter(s => s.tone >= 1 && s.tone <= 5).map(s => ({
    text: s.text,
    tone: s.tone,
    options: [...TONE_CHOICES],
    answer: s.tone === 5 ? 4 : s.tone - 1,
  }));
}
function samePinyin(a, b) {
  const x = canonPinyin(a), y = canonPinyin(b);
  return x.length > 0 && x === y;
}

export {
  RANKS, START_RATING, ROUNDS, ROUND_MS, TYPES, PVP_TYPES, DAILY_ROUNDS, DAILY_MS, DAILY_GRACE_MS,
  rankOf, elo, points, makeQuestion, dailySet, wordOfDay, samePinyin, pinyinSyllables, toneDrill,
};
