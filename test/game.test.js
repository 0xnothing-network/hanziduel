import test from 'node:test';
import assert from 'node:assert';
import * as G from '../game.js';
import WORDS from '../data/words.json' with { type: 'json' };

test('rank unlocks HSK by rating', () => {
  assert.strictEqual(G.rankOf(0).hsk, 1);
  assert.strictEqual(G.rankOf(1000).hsk, 1);
  assert.strictEqual(G.rankOf(1099).hsk, 1);
  assert.strictEqual(G.rankOf(1100).hsk, 2);
  assert.strictEqual(G.rankOf(1250).hsk, 3);
  assert.strictEqual(G.rankOf(1700).hsk, 7);
});

test('elo is zero-sum, favours upsets, never negative', () => {
  assert.deepStrictEqual(G.elo(1000, 1000, 1), [1016, 984]);
  assert.deepStrictEqual(G.elo(1000, 1000, 0.5), [1000, 1000]);
  const [c] = G.elo(1000, 1400, 1);
  assert.ok(c - 1000 > 16);
  assert.ok(G.elo(5, 2000, 0)[0] >= 0);
});

test('points reward speed only when correct', () => {
  assert.strictEqual(G.points(false, 9000), 0);
  assert.strictEqual(G.points(true, G.ROUND_MS), 100);
  assert.strictEqual(G.points(true, G.ROUND_MS * 2), 100);
  assert.strictEqual(G.points(true, -5), 50);
});

test('pinyin: tone marks and tone numbers match, neutral tone is 5 or nothing', () => {
  assert.strictEqual(G.samePinyin('zhōngguó', 'zhong1 guo2'), true);
  assert.strictEqual(G.samePinyin('  Mei2 ', 'méi'), true);
  assert.strictEqual(G.samePinyin('Nǚ', 'nv3'), true);
  assert.strictEqual(G.samePinyin('nü3', 'nv3'), true);
  assert.strictEqual(G.samePinyin('nu:3', 'nǚ'), true);
  assert.strictEqual(G.samePinyin('le', 'le5'), true);
  assert.strictEqual(G.samePinyin("xī'ān", 'xi1an1'), true);
  assert.strictEqual(G.samePinyin("xī'ān", 'xian1'), false);
  assert.strictEqual(G.samePinyin('nǚháir', 'nv3hair2'), true);
  assert.strictEqual(G.samePinyin('le', 'le1'), false);
  assert.strictEqual(G.samePinyin('ma', 'ma1'), false);
  assert.strictEqual(G.samePinyin('', 'le'), false);
  assert.strictEqual(G.samePinyin('   ', 'le'), false);
});

test('daily set is the same paper all day and a different one tomorrow', () => {
  const day = '2026-11-10';
  const a = G.dailySet(WORDS, day);
  const b = G.dailySet(WORDS, day);
  assert.strictEqual(a.length, G.DAILY_ROUNDS);
  assert.deepStrictEqual(a.map(q => [q.type, q.prompt, q.options, q.answer]), b.map(q => [q.type, q.prompt, q.options, q.answer]));
  assert.deepStrictEqual(a.map(q => q.level), [1, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.ok(a.every(q => !q.listen && q.options.length === 4));
  const other = G.dailySet(WORDS, '2026-11-11');
  assert.notDeepStrictEqual(a.map(q => q.prompt + q.options.join('\0')), other.map(q => q.prompt + q.options.join('\0')));
  const w = G.wordOfDay(WORDS, day);
  assert.ok(w.h && w.p && w.m);
  assert.strictEqual(w.level, 1);
  assert.ok(!a.some(q => q.word.id === w.id));
  assert.strictEqual(G.points(true, 6000, 12000), 75);
  assert.strictEqual(G.points(true, 0, 12000), 50);
});

test('every word has a meaning, almost all in Vietnamese', () => {
  const all = Object.values(WORDS).flat();
  assert.ok(all.length > 10000);
  assert.ok(all.every(w => w.id && w.h && w.p && w.m && typeof w.en === "string"));
  assert.ok(all.filter(w => w.vi).length / all.length > 0.99);
  assert.ok(!all.some(w => /\b(LT|CL):|Lượng từ\s*[:：]|biến thể của/.test(w.m + w.vi)));
  assert.ok(!all.some(w => /\[[a-z]+\d|\|/i.test(w.m + w.vi)), 'no raw dictionary cross-references');
  const find = h => all.find(w => w.h === h);
  assert.strictEqual(new Set(all.map(w => w.id)).size, all.length, 'official ids are unique');
  // Official readings, not guessed ones; homographs are separate words.
  for (const [h, p] of [['没', 'méi'], ['那', 'nà'], ['胖', 'pàng'], ['血', 'xiě'], ['薄', 'báo']]) assert.strictEqual(find(h).p, p, h);
  assert.deepStrictEqual(all.filter(w => w.h === '了').map(w => w.p), ['le', 'liǎo']);
  assert.ok(find('表示') && find('森林'), 'words missing from the old list are present');
  assert.ok(all.every(w => /^[^0-9:|∥·˙]+$/.test(w.p)), 'no raw pinyin artefacts');
  assert.strictEqual(find('吃').m, 'ăn');
  assert.strictEqual(find('说').m, 'nói');
  assert.strictEqual(find('国').m, 'quốc gia');
});

test('pinyin syllables keep the tone mark and number every tone', () => {
  assert.deepStrictEqual(G.pinyinSyllables('zhōngguó'), [
    { text: 'zhōng', tone: 1 },
    { text: 'guó', tone: 2 },
  ]);
  assert.deepStrictEqual(G.pinyinSyllables('zhong1guo2'), [
    { text: 'zhong1', tone: 1 },
    { text: 'guo2', tone: 2 },
  ]);
  assert.deepStrictEqual(G.pinyinSyllables('bàba'), [
    { text: 'bà', tone: 4 },
    { text: 'ba', tone: 5 },
  ]);
  assert.deepStrictEqual(G.pinyinSyllables("xī'ān"), [
    { text: 'xī', tone: 1 },
    { text: "'", tone: 0 },
    { text: 'ān', tone: 1 },
  ]);
  assert.deepStrictEqual(G.pinyinSyllables('bàn nián').map(p => p.tone), [4, 0, 2]);
  const mei = G.pinyinSyllables('  Mei2 ');
  assert.ok(mei.some(p => p.text === 'Mei2' && p.tone === 2));
  assert.strictEqual(mei.map(p => p.text).join(''), '  Mei2 ');
  assert.strictEqual(G.pinyinSyllables('le')[0].tone, 5);
  assert.deepStrictEqual(G.pinyinSyllables('le5'), [{ text: 'le5', tone: 5 }]);
  assert.strictEqual(G.pinyinSyllables('nǚ')[0].tone, 3);
  assert.ok(G.pinyinSyllables('nǚ')[0].text.includes('ǚ'));
  assert.strictEqual(G.pinyinSyllables('nv3')[0].tone, 3);
  assert.ok(G.pinyinSyllables('nv3')[0].text.includes('3'));
  for (const [marked, tone] of [['bā', 1], ['bá', 2], ['bǎ', 3], ['bà', 4], ['ba', 5]])
    assert.strictEqual(G.pinyinSyllables(marked)[0].tone, tone, marked);
  const all = Object.values(WORDS).flat();
  for (const w of all) {
    const parts = G.pinyinSyllables(w.p);
    assert.strictEqual(parts.map(p => p.text).join(''), w.p.normalize('NFC'), w.id);
    assert.ok(parts.some(p => p.tone >= 1 && p.tone <= 5), w.id);
    assert.ok(parts.every(p => p.tone >= 0 && p.tone <= 5), w.id);
  }
  const hyphen = all.find(w => w.p.includes('-'));
  assert.ok(G.pinyinSyllables(hyphen.p).some(p => p.text === '-'));
});

test('tone drill asks one question per syllable', () => {
  const choices = ['Thanh 1', 'Thanh 2', 'Thanh 3', 'Thanh 4', 'Thanh nhẹ'];
  const ai = Object.values(WORDS).flat().find(w => w.h === '爱');
  const one = G.toneDrill(ai);
  assert.strictEqual(one.length, 1);
  assert.deepStrictEqual(one[0].options, choices);
  assert.strictEqual(one[0].answer, 3);
  assert.strictEqual(one[0].options[one[0].answer], 'Thanh 4');
  assert.ok(one[0].text.includes('à'));
  const two = G.toneDrill({ p: 'bàba' });
  assert.strictEqual(two.length, 2);
  assert.strictEqual(two[0].tone, 4);
  assert.strictEqual(two[1].answer, 4);
  assert.strictEqual(two[1].options[two[1].answer], 'Thanh nhẹ');
  assert.deepStrictEqual(G.toneDrill({ p: '' }), []);
  assert.deepStrictEqual(G.toneDrill(null), []);
  const spaced = Object.values(WORDS).flat().find(w => w.p.includes(' '));
  const qs = G.toneDrill(spaced);
  const syl = G.pinyinSyllables(spaced.p).filter(s => s.tone >= 1);
  assert.strictEqual(qs.length, syl.length);
  assert.ok(qs.length >= 2, spaced.h);
  qs.forEach((q, i) => {
    assert.deepStrictEqual(q.options, choices);
    assert.strictEqual(q.text, syl[i].text);
    assert.strictEqual(q.answer, syl[i].tone === 5 ? 4 : syl[i].tone - 1);
    assert.ok(q.answer >= 0 && q.answer < 5);
  });
});

test('questions: three types, level range respected, 4 distinct options with one answer', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const max = 1 + (i % 7);
    const q = G.makeQuestion(WORDS, max);
    seen.add(q.type);
    if (q.type === 'Việt → Hán') {
      assert.strictEqual(q.prompt, q.word.m);
      assert.strictEqual(q.options[q.answer], q.word.h);
      // No other option may share the asked meaning, or two answers would be right.
      assert.ok(q.options.every((o, k) => k === q.answer || Object.values(WORDS).flat().find(w => w.h === o)?.m !== q.word.m));
    } else {
      assert.strictEqual(q.prompt, q.word.h);
      assert.strictEqual(q.options[q.answer], q.word.m);
      assert.strictEqual(q.listen, q.type === 'Nghe → nghĩa');
      assert.strictEqual(q.hint, q.listen ? q.word.p : undefined);
    }
    assert.ok(q.level >= 1 && q.level <= max);
    assert.strictEqual(new Set(q.options).size, 4);
    assert.strictEqual(G.makeQuestion(WORDS, max, max).level, max);
  }
  assert.deepStrictEqual([...seen].sort(), ['Hán → Việt', 'Nghe → nghĩa', 'Việt → Hán']);
  for (let i = 0; i < 300; i++) assert.ok(!G.makeQuestion(WORDS, 3, 1, Math.random, G.PVP_TYPES).listen, 'PvP types exclude listening');
});
