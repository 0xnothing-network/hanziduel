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
  assert.ok(all.every(w => w.h && w.p && w.m && w.en));
  assert.ok(all.filter(w => w.vi).length / all.length > 0.99);
  assert.ok(!all.some(w => /\b(LT|CL):|Lượng từ|biến thể của/.test(w.m + w.vi)));
  assert.ok(!all.some(w => /\[[a-z]+\d|\|/i.test(w.m + w.vi)), 'no raw dictionary cross-references');
  const find = h => all.find(w => w.h === h);
  assert.strictEqual(find('吃').m, 'ăn');
  assert.strictEqual(find('说').m, 'nói');
  assert.strictEqual(find('国').m, 'quốc gia');
});

test('questions: only Hán → Việt, level range respected, 4 distinct options with one answer', () => {
  for (let i = 0; i < 2000; i++) {
    const max = 1 + (i % 7);
    const q = G.makeQuestion(WORDS, max);
    assert.strictEqual(q.type, 'Hán → Việt');
    assert.strictEqual(q.prompt, q.word.h);
    assert.ok(q.level >= 1 && q.level <= max);
    assert.strictEqual(new Set(q.options).size, 4);
    assert.strictEqual(q.options[q.answer], q.word.m);
    assert.strictEqual(G.makeQuestion(WORDS, max, max).level, max);
  }
});
