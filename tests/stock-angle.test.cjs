// The Stock button by Pattern Angle: the angle read from Spoilboard
// Toolbox's settings (stockTurnDeg), and which origins it warns about.
// Both helpers live only in config.html, so they're taken from there.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
function take(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return new Function('return ' + html.slice(start, i + 1))();
}
const stockTurnFrom = take('stockTurnFrom');
const stockAngleBoxOrigin = take('stockAngleBoxOrigin');

test('stockTurnFrom: the saved angle, counterclockwise positive', () => {
  assert.equal(stockTurnFrom({ stockTurnDeg: 18.4242 }), 18.4242);
  assert.equal(stockTurnFrom({ stockTurnDeg: -7.5 }), -7.5);
  assert.equal(stockTurnFrom({ stockTurnDeg: '18.4242' }), 18.4242);
});

test('stockTurnFrom: square, missing or unreadable is 0 (no button)', () => {
  [undefined, null, {}, { stockTurnDeg: 0 }, { stockTurnDeg: null }, { stockTurnDeg: '' }, { stockTurnDeg: ' ' },
   { stockTurnDeg: 'abc' }, { stockTurnDeg: NaN }, { stockTurnDeg: Infinity }, { stockTurnDeg: true },
   { stockTurnDeg: 0.004 }, { stockTurnDeg: -0.004 }, { stockTurnDeg: 360 }, { stockTurnDeg: -720 }]
    .forEach((s) => assert.equal(stockTurnFrom(s), 0, JSON.stringify(s)));
});

test('stockTurnFrom: kept within -180 to 180 and to 0.0001', () => {
  assert.equal(stockTurnFrom({ stockTurnDeg: 378.4242 }), 18.4242);
  assert.equal(stockTurnFrom({ stockTurnDeg: 350 }), -10);
  assert.equal(stockTurnFrom({ stockTurnDeg: -190 }), 170);
  assert.equal(stockTurnFrom({ stockTurnDeg: 18.42424242 }), 18.4242);
  assert.equal(stockTurnFrom({ stockTurnDeg: 0.005 }), 0.005);
});

test('stockAngleBoxOrigin: only the pattern box\'s corners and edges', () => {
  ['front-left', 'front-center', 'front-right', 'back-left', 'back-center', 'back-right', 'left-center', 'right-center']
    .forEach((o) => assert.equal(stockAngleBoxOrigin(o), true, o));
  ['center', 'shape-center', 'corner:1', 'corner:9', 'hole', '', undefined]
    .forEach((o) => assert.equal(stockAngleBoxOrigin(o), false, String(o)));
});
