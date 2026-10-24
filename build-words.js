// Builds data/words.json from three pinned sources:
// - Word list, levels and pinyin: github.com/ivankra/hsk30 (MIT), a transcription of the official HSK 3.0
//   standard GF 0025-2021 that matches its per-level counts exactly. Level 7 = band 7-9.
// - Vietnamese meanings: CVDICT by Phong Phan (CC BY-SA 4.0). The original ph0ngp/CVDICT repo is offline;
//   this uses the unmodified CVDICT.u8 kept in github.com/phucbm/xue-hanzi.
// - English meanings: CC-CEDICT (CC BY-SA 4.0), snapshot kept in github.com/licryle/CxDICT.
// Both dictionaries are matched on the exact entry hsk30 names ("trad|simp[pin1 yin1]"), so each reading gets
// its own meaning (了 le vs liǎo) instead of a guess.
// Fields: id official id (L1-0066), h hanzi, p pinyin, m short meaning for quiz options (Vietnamese, English
//         fallback), vi fuller Vietnamese meaning, en English meaning.
import fs from 'node:fs';
const dataDir = new URL('./data/', import.meta.url);
const HSK30 = 'https://raw.githubusercontent.com/ivankra/hsk30/4ff9e3915ce87baaecd7ebe263085573a4ea3192/hsk30.csv';
const CVDICT = 'https://raw.githubusercontent.com/phucbm/xue-hanzi/c1e7610546454e32db2b3332435902bf78181152/src/data/CVDICT.u8';
const CEDICT = 'https://raw.githubusercontent.com/licryle/CxDICT/ece18b7a92b3a34965430a165594bf006f4fcc99/dictionaries/cc-cedict/2026-09-12.u8';

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// RFC 4180 CSV (quoted fields, "" escapes, CRLF) -> array of objects keyed by the header row.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [head, ...body] = rows;
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Drop dictionary-meta senses (measure words, "variant of ...", usage notes) that make bad quiz answers.
const META = /^(CL:|LT:|biến thể|dạng khác|cách viết cũ|xem |variant of|old variant|see |also written|abbr\. for|erhua variant)/i;
const senses = def => (def || '')
  .replace(/\s*\(((LT|CL|Lượng từ|Lưu ý|Ghi chú)\s*[:：]|biến thể của|variant of)[^)]*\)/gi, '')
  // Cross-references "詞典|词典[ci2 dian3]" / "五等爵位[wu3 deng3]" -> just the simplified word.
  .replace(/[^\s|/;,()]+\|([^\s|/;,()[]+)/g, '$1')
  .replace(/\s?\[[A-Za-z:1-5 ]+\]/g, '')
  .split('/')
  // Drop measure-word notes ("LT:个", "Lượng từ: 所", "CL:个") and parts that are only Chinese characters ("个,位,名").
  .map(s => s.split(';').map(p => p.trim()).filter(p => p && !/^(LT|CL|Lượng từ)\s*[:：]/i.test(p) && !/^[㐀-鿿,，、\s]+$/.test(p)).join('; '))
  .filter(s => s && !META.test(s));

// CEDICT-format line: "繁體 简体 [pin1 yin1] /sense/sense/", keyed exactly like hsk30's CEDICT column.
function parseDict(text) {
  const byKey = new Map(), bySimp = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/);
    if (!m) continue;
    const e = { py: m[3], senses: senses(m[4]) };
    byKey.set(`${m[1]}|${m[2]}[${m[3]}]`, e);
    (bySimp.get(m[2]) || bySimp.set(m[2], []).get(m[2])).push(e);
  }
  return { byKey, bySimp };
}

// The exact entry first. Rows hsk30 could not link (phrases like 车上, 能不能) fall back to any common-noun entry
// for the same characters, with erhua 儿 stripped (一点儿 -> 一点).
function lookup(dict, row, simp) {
  const exact = dict.byKey.get(row.CEDICT);
  if (exact?.senses.length) return { senses: exact.senses, exact: true };
  const real = s => (dict.bySimp.get(s) || []).filter(e => e.senses.length);
  const entries = real(simp).length ? real(simp) : real(simp.replace(/儿$/, ''));
  return { senses: (entries.find(e => e.py === e.py.toLowerCase()) || entries[0])?.senses || [], exact: false };
}

// Phrases neither dictionary has; meanings written for this project.
const OWN = {
  车上: 'trên xe', 不太: 'không lắm', 不一会儿: 'chẳng mấy chốc', 见过: 'đã từng gặp', 送到: 'đưa đến',
  这时候: 'lúc này', 放到: 'đặt vào', 能不能: 'có thể… không', 收看: 'xem (truyền hình)',
  干吗: 'làm gì; tại sao', 纪录: 'kỷ lục; ghi chép', 眼里: 'trong mắt', 城里: 'trong thành phố', 很难说: 'khó nói',
  一番: 'một phen; một hồi', 指着: 'chỉ vào', 不利于: 'bất lợi cho', 不肯: 'không chịu', 不难: 'không khó',
  不如说: 'nói đúng hơn là', 趁着: 'nhân lúc', 纯朴: 'chất phác', 得意扬扬: 'dương dương tự đắc',
  定为: 'xác định là', 飞往: 'bay đến', 公益性: 'tính công ích', 怀着: 'mang (tâm trạng)', 火暴: 'sôi động; nóng nảy',
  难以想象: 'khó tưởng tượng', 水灵灵: 'tươi tắn', 说起来: 'nói ra thì', 无可厚非: 'không có gì đáng trách',
  下功夫: 'bỏ công sức', 效仿: 'bắt chước', 抑扬顿挫: 'trầm bổng', 着眼于: 'chú trọng vào', 做证: 'làm chứng',
  看成: 'coi là', 不予: 'không (cho)', 审视: 'xem xét kỹ', 嫌弃: 'ghét bỏ', 致力于: 'dốc sức vào',
};

const firstSense = list => list[0]?.split(';')[0].trim() || '';
// "chū∥·lái" -> "chūlái": ∥ marks a separable word, · an optional neutral tone; learners need neither.
// "chà(yì)diǎnr" -> "chàdiǎnr": the bracketed syllable is optional, matching the hanzi shown without it.
const cleanPinyin = p => p.split('|')[0].replace(/\([^)]*\)|[∥·]/g, '').trim();

(async () => {
  const [rows, vi, en] = await Promise.all([get(HSK30).then(parseCsv), get(CVDICT).then(parseDict), get(CEDICT).then(parseDict)]);
  const out = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  const seen = new Set();
  let collapsed = 0, inexact = 0, own = 0, english = 0;
  const none = [];
  for (const row of rows) {
    const lv = row.Level === '7-9' ? 7 : +row.Level;
    const h = row.Simplified.split('|')[0].replace(/（[^）]*）/g, '');
    const p = cleanPinyin(row.WebPinyin || row.Pinyin);
    // The standard repeats a word at a higher level when it adds a sense (白 bái at 1 and 3). The dictionaries
    // can't tell those senses apart, so keep the first (lowest) level; different readings stay separate.
    const key = `${h} ${p}`;
    if (seen.has(key)) { collapsed++; continue; }
    seen.add(key);
    const v = lookup(vi, row, h), e = lookup(en, row, h);
    if (!v.exact) inexact++;
    const enShort = firstSense(e.senses);
    let short = firstSense(v.senses);
    if (!short && OWN[h]) { short = OWN[h]; own++; }
    if (!short) { short = enShort; english++; }
    if (!short) { none.push(`${row.ID} ${h} ${p}`); continue; }
    out[lv].push({
      id: row.ID, h, p,
      // Quiz options drop "(...)" usage notes unless that would leave nothing.
      m: short.replace(/\s*\([^)]*\)/g, '').trim() || short,
      vi: v.senses.slice(0, 3).join('; ') || OWN[h] || '',
      en: enShort,
    });
  }
  if (none.length) throw new Error(`no meaning at all (add them to OWN):\n${none.join('\n')}`);
  for (const lv in out) console.log(`HSK ${lv === '7' ? '7-9' : lv}: ${out[lv].length} words`);
  console.log(`rows ${rows.length}; same word+reading repeated at a higher level, kept once: ${collapsed}`);
  console.log(`Vietnamese: matched by fallback ${inexact}, own meaning ${own}, English fallback ${english}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(new URL('words.json', dataDir), JSON.stringify(out));
})();
