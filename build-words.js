// Builds data/words.json:
// - HSK 3.0 lists (MIT, github.com/drkameleon/complete-hsk-vocabulary); level 7 = band 7-9.
// - Vietnamese meanings from CVDICT by Phong Phan (CC BY-SA 4.0). The original ph0ngp/CVDICT repo is
//   offline; this uses the unmodified CVDICT.u8 kept in github.com/phucbm/xue-hanzi, pinned to a commit.
// Fields: h hanzi, p pinyin, m short meaning for quiz options (Vietnamese, English fallback),
//         vi fuller Vietnamese meaning, en English meaning.
const fs = require('fs');
const HSK = 'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/wordlists/exclusive/new/';
const CVDICT = 'https://raw.githubusercontent.com/phucbm/xue-hanzi/c1e7610546454e32db2b3332435902bf78181152/src/data/CVDICT.u8';

async function get(url, as = 'json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res[as]();
}

// Drop dictionary-meta senses (measure words, "variant of ...", usage notes) that make bad quiz answers.
const META = /^(CL:|LT:|biến thể|dạng khác|cách viết cũ|xem |variant of|old variant|see )/i;
const senses = def => (def || '')
  .replace(/\s*\(((LT|CL|Lượng từ|Lưu ý|Ghi chú)\s*[:：]|biến thể của|variant of)[^)]*\)/gi, '')
  // Cross-references "詞典|词典[ci2 dian3]" / "五等爵位[wu3 deng3]" -> just the simplified word.
  .replace(/[^\s|/;,()]+\|([^\s|/;,()[]+)/g, '$1')
  .replace(/\s?\[[A-Za-z:1-5 ]+\]/g, '')
  .split('/')
  // Drop measure-word notes ("LT:个", "Lượng từ: 所") and parts that are only Chinese characters ("个,位,名").
  .map(s => s.split(';').map(p => p.trim()).filter(p => p && !/^(LT|CL|Lượng từ)\s*[:：]/i.test(p) && !/^[㐀-鿿,，、\s]+$/.test(p)).join('; '))
  .filter(s => s && !META.test(s));
// "nü3 er2" / "nu:3 er2" -> "nv3er2"; neutral tone dropped so "men5" == "men".
// Case is kept: "Guo2" is the surname entry, "guo2" the common word.
const normPinyin = p => p.replace(/u:|ü/g, 'v').replace(/[\s5]/g, '');

// CVDICT line: "繁體 简体 [pin1 yin1] /sense/sense/"
function parseCvdict(text) {
  const bySimp = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\S+ (\S+) \[([^\]]*)\] \/(.*)\/\s*$/);
    if (!m) continue;
    const list = bySimp.get(m[1]) || bySimp.set(m[1], []).get(m[1]);
    list.push({ py: normPinyin(m[2]), senses: senses(m[3]) });
  }
  return bySimp;
}

// Same reading first; otherwise any lowercase (non-proper-noun) entry with real senses.
function vietnamese(dict, simp, numeric) {
  // Erhua words (一点儿) are usually listed without the 儿 in CVDICT.
  const real = s => (dict.get(s) || []).filter(e => e.senses.length);
  const entries = real(simp).length ? real(simp) : real(simp.replace(/儿$/, ''));
  const want = normPinyin(numeric);
  return (entries.find(e => e.py === want) || entries.find(e => e.py === e.py.toLowerCase()) || entries[0])?.senses || [];
}

(async () => {
  const dict = parseCvdict(await get(CVDICT, 'text'));
  const out = {};
  let missing = 0, fuzzy = 0;
  for (let lv = 1; lv <= 7; lv++) {
    const seen = new Set();
    out[lv] = (await get(`${HSK}${lv}.json`)).flatMap(w => {
      // Pick the main reading: not a surname/proper noun (国 guó, not Guó); for a single character the
      // neutral-tone particle if any (了 le, 着 zhe); otherwise the one with the most meanings (说 shuō, not shuì).
      const lower = w.forms.filter(x => { const p = x.transcriptions.pinyin; return p[0] === p[0].toLowerCase(); });
      const pool = lower.length ? lower : w.forms;
      const particle = w.simplified.length === 1 && pool.find(x => /^[a-z:ü]+5?$/.test(x.transcriptions.numeric));
      const f = particle || pool.reduce((a, b) => b.meanings.length > a.meanings.length ? b : a);
      const en = f && (senses(f.meanings.join('/'))[0] || f.meanings[0])?.split(';')[0].trim();
      if (!en || seen.has(w.simplified)) return [];
      seen.add(w.simplified);
      const v = vietnamese(dict, w.simplified, f.transcriptions.numeric);
      if (!v.length) missing++;
      else if (!(dict.get(w.simplified) || []).some(e => e.py === normPinyin(f.transcriptions.numeric))) fuzzy++;
      // Quiz options drop "(...)" usage notes unless that would leave nothing.
      const first = v.length ? v[0].split(';')[0].trim() : en;
      return [{ h: w.simplified, p: f.transcriptions.pinyin, m: first.replace(/\s*\([^)]*\)/g, '').trim() || first, vi: v.slice(0, 3).join('; '), en }];
    });
    console.log(`HSK ${lv}: ${out[lv].length} words`);
  }
  console.log(`Vietnamese: no entry ${missing} (English fallback), reading mismatch ${fuzzy}`);
  fs.mkdirSync(__dirname + '/data', { recursive: true });
  fs.writeFileSync(__dirname + '/data/words.json', JSON.stringify(out));
})();
