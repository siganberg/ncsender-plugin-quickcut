const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startingFeeds } = require('../lib/starting-feeds.cjs');

test('a 1/4" 2-flute bit in MDF: 18000 RPM, chip 0.0762 mm, plunge 30%', () => {
  const f = startingFeeds(6.35, 2, 'mdf');
  assert.equal(f.rpm, 18000);
  assert.ok(Math.abs(f.chipMm - 0.0762) < 1e-9);
  assert.equal(f.feedMm, 2743);
  assert.equal(f.plungeMm, 823);
  assert.equal(f.capped, false);
  assert.ok(Math.abs(f.stepMm - 3.175) < 1e-9);
});

test('the chip is capped for big bits, and the feed by the machine', () => {
  const big = startingFeeds(25, 2, 'aluminum');
  assert.equal(big.chipMm, 0.06);
  const fast = startingFeeds(12, 4, 'mdf', { maxFeed: 2500 });
  assert.equal(fast.feedMm, 2500);
  assert.equal(fast.capped, true);
  assert.equal(startingFeeds(12, 4, 'mdf').feedMm, 4000);
});

test('spindle range and minimum feeds', () => {
  assert.equal(startingFeeds(6, 2, 'mdf', { maxRpm: 12000 }).rpm, 12000);
  assert.equal(startingFeeds(6, 2, 'foam', { minRpm: 15000 }).rpm, 15000);
  const tiny = startingFeeds(0.5, 1, 'aluminum');
  assert.equal(tiny.feedMm, 150);
  assert.equal(tiny.plungeMm, 60);
  assert.equal(startingFeeds(6, 1, 'mdf').feedMm * 2 - startingFeeds(6, 2, 'mdf').feedMm, 0);
});

test('an unknown material is read as MDF', () => {
  assert.deepEqual(startingFeeds(6, 2, 'balsa'), startingFeeds(6, 2, 'mdf'));
});

test('config.html carries the same startingFeeds as lib/starting-feeds.cjs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'starting-feeds.cjs'), 'utf8');
  const body = (src) => {
    const start = src.indexOf('function startingFeeds(');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1).split('\n').map(l => l.trim()).join('\n');
  };
  assert.ok(html.indexOf('function startingFeeds(') >= 0);
  assert.equal(body(html), body(lib));
});
