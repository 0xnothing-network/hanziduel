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
