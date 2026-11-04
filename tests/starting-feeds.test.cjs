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

test('stepover by material', () => {
  assert.equal(startingFeeds(6, 2, 'mdf').stepoverPct, 45);
  assert.equal(startingFeeds(6, 1, 'aluminum').stepoverPct, 25);
});

test('feeds style: average is as before; conservative and aggressive scale the feed, depth of cut and stepover', () => {
  assert.deepEqual(startingFeeds(6.35, 2, 'mdf', null, 'average'), startingFeeds(6.35, 2, 'mdf'));
  const avg = startingFeeds(6.35, 2, 'hardwood'), con = startingFeeds(6.35, 2, 'hardwood', null, 'conservative'), agg = startingFeeds(6.35, 2, 'hardwood', null, 'aggressive');
  assert.equal(con.rpm, avg.rpm);
  assert.ok(Math.abs(con.chipMm - avg.chipMm * 0.75) < 1e-12 && Math.abs(agg.chipMm - avg.chipMm * 1.25) < 1e-12);
  assert.equal(con.feedMm, Math.round(avg.chipMm * 0.75 * 18000 * 2));
  assert.ok(Math.abs(con.stepMm - avg.stepMm * 0.75) < 1e-12 && Math.abs(agg.stepMm - avg.stepMm * 1.2) < 1e-12);
  assert.equal(agg.stepoverPct, 48);
  assert.equal(con.plungeMm, Math.round(con.feedMm * 0.3));
  // Still within the machine: the feed cap holds, and stepover stops at 90 %.
  assert.equal(startingFeeds(12, 4, 'mdf', { maxFeed: 2500 }, 'aggressive').feedMm, 2500);
  assert.equal(startingFeeds(6, 2, 'foam', null, 'aggressive').stepoverPct, 72);
});

test('conservative slows the feed even when the machine max holds it', () => {
  const avg = startingFeeds(12.7, 2, 'mdf', { maxFeed: 2500 }), con = startingFeeds(12.7, 2, 'mdf', { maxFeed: 2500 }, 'conservative');
  assert.equal(avg.feedMm, 2500);
  assert.equal(avg.capped, true);
  assert.equal(con.feedMm, 1875);
  assert.equal(con.capped, false);
  // The chip shown is the one the held feed cuts, not the formula's.
  assert.ok(Math.abs(avg.chipMm - 2500 / 36000) < 1e-12);
});

test('conservative keeps the chip where a thin one melts or rubs: plastics and aluminum', () => {
  for (const m of ['hdpe', 'acrylic', 'polycarbonate', 'aluminum']) {
    const avg = startingFeeds(3.175, 2, m), con = startingFeeds(3.175, 2, m, null, 'conservative');
    assert.equal(con.feedMm, avg.feedMm, m);
    assert.ok(Math.abs(con.stepMm - avg.stepMm * 0.75) < 1e-12, m);
  }
});

test('aggressive stops at the material chip limit', () => {
  assert.ok(Math.abs(startingFeeds(30, 2, 'aluminum', null, 'aggressive').chipMm - 0.06) < 1e-12);
  assert.ok(startingFeeds(12.7, 1, 'hdpe', null, 'aggressive').chipMm <= 0.25 + 1e-12);
});

test('the plunge stays within the Z max rate ($112)', () => {
  assert.equal(startingFeeds(6.35, 2, 'mdf', { maxPlunge: 500 }).plungeMm, 500);
  assert.equal(startingFeeds(6.35, 2, 'mdf', { maxPlunge: 5000 }).plungeMm, 823);
});
