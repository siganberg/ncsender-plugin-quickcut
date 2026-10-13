const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseUnitValue } = require('../lib/unit-input.cjs');

const METRIC = false, IMPERIAL = true;

test('plain numbers pass through untouched in either unit system', () => {
  assert.equal(parseUnitValue('6.35', METRIC, 'length'), 6.35);
  assert.equal(parseUnitValue('.25', IMPERIAL, 'length'), 0.25);
  assert.equal(parseUnitValue(' -30 ', METRIC, 'length'), -30);
  assert.equal(parseUnitValue('3.14159', METRIC, 'length'), 3.14159);
});

test('inch input converts to mm on a metric machine', () => {
  assert.equal(parseUnitValue('.25in', METRIC, 'length'), 6.35);
  assert.equal(parseUnitValue('.25"', METRIC, 'length'), 6.35);
  assert.equal(parseUnitValue('0.25 inch', METRIC, 'length'), 6.35);
  assert.equal(parseUnitValue('1/4"', METRIC, 'length'), 6.35);
  assert.equal(parseUnitValue('1-1/2"', METRIC, 'length'), 38.1);
  assert.equal(parseUnitValue('1 1/2 in', METRIC, 'length'), 38.1);
  assert.equal(parseUnitValue('1/4”', METRIC, 'length'), 6.35);
});

test('mm/cm input converts to inches on an imperial machine', () => {
  assert.equal(parseUnitValue('6.35mm', IMPERIAL, 'length'), 0.25);
  assert.equal(parseUnitValue('6.35 MM', IMPERIAL, 'length'), 0.25);
  assert.equal(parseUnitValue('2.54cm', IMPERIAL, 'length'), 1);
  assert.equal(parseUnitValue('3mm', IMPERIAL, 'length'), 0.1181);
});

test('fractions with no unit stay in the active units', () => {
  assert.equal(parseUnitValue('1/4', IMPERIAL, 'length'), 0.25);
  assert.equal(parseUnitValue('-1-1/2', IMPERIAL, 'length'), -1.5);
});

test('feed fields accept per-minute units', () => {
  assert.equal(parseUnitValue('100ipm', METRIC, 'feed'), 2540);
  assert.equal(parseUnitValue('100 in/min', METRIC, 'feed'), 2540);
  assert.equal(parseUnitValue('2540 mm/min', IMPERIAL, 'feed'), 100);
  assert.equal(parseUnitValue('600mm', IMPERIAL, 'feed'), 23.622);
  assert.equal(parseUnitValue('100ipm', METRIC, 'length'), null, 'ipm is a feed unit only');
});

test('unreadable text returns null', () => {
  for (const bad of ['', 'abc', '1/0', '1.5/2', '1-1/0', '6.35 furlongs', '1..2', '--1', '1/4/2']) {
    assert.equal(parseUnitValue(bad, METRIC, 'length'), null, JSON.stringify(bad));
  }
});

test('inline copy in config.html matches lib/unit-input.cjs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'unit-input.cjs'), 'utf8');
  const body = (src) => {
    const start = src.indexOf('function parseUnitValue(');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1).split('\n').map(l => l.trim()).join('\n');
  };
  assert.equal(body(html), body(lib));
});
