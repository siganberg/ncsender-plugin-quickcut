// The Stock button by Pattern Angle: the angle read from Spoilboard
// Toolbox's settings (stockTurnDeg), and which origins it warns about.
// Both helpers live only in config.html, so they're taken from there.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
function source(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
// A helper and those it calls, together.
function take(name, ...uses) {
  return new Function(uses.map(source).join('\n') + '\nreturn ' + source(name))();
}
const stockTurnFrom = take('stockTurnFrom');
const stockAngleBoxOrigin = take('stockAngleBoxOrigin');
const stockSidesFrom = take('stockSidesFrom', 'stockTurnFrom');
const stockSideFirst = take('stockSideFirst');
const stockSideDeg = take('stockSideDeg');

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

test('stockSidesFrom: both sides when Spoilboard Toolbox saves them', () => {
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 63.4349, stockTurnLongDeg: 63.4349, stockTurnShortDeg: -26.5651 }),
    [{ side: 'long', deg: 63.4349 }, { side: 'short', deg: -26.5651 }]);
  // Width X along the short side: stockTurnDeg is that side's, the sides are as saved.
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: -26.5651, stockTurnLongDeg: 63.4349, stockTurnShortDeg: -26.5651 }),
    [{ side: 'long', deg: 63.4349 }, { side: 'short', deg: -26.5651 }]);
  // Only one side known (the other missing or unreadable): the other is square to it.
  assert.deepEqual(stockSidesFrom({ stockTurnLongDeg: 18.4242 }), [{ side: 'long', deg: 18.4242 }, { side: 'short', deg: -71.5758 }]);
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 5, stockTurnShortDeg: -26.5651 }), [{ side: 'long', deg: 63.4349 }, { side: 'short', deg: -26.5651 }]);
  assert.deepEqual(stockSidesFrom({ stockTurnLongDeg: -30, stockTurnShortDeg: 'x' }), [{ side: 'long', deg: -30 }, { side: 'short', deg: 60 }]);
  assert.deepEqual(stockSidesFrom({ stockTurnLongDeg: 90 }), [{ side: 'long', deg: 90 }, { side: 'short', deg: 0 }]);
  // Both saved, one of them 0 (square to X): kept as saved.
  assert.deepEqual(stockSidesFrom({ stockTurnLongDeg: 0, stockTurnShortDeg: 90 }), [{ side: 'long', deg: 0 }, { side: 'short', deg: 90 }]);
});

test('stockSidesFrom: square is none; an older Spoilboard Toolbox gives stockTurnDeg alone', () => {
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 0, stockTurnLongDeg: 0, stockTurnShortDeg: 0 }), []);
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 18.4242, stockTurnLongDeg: 0, stockTurnShortDeg: 0 }), []);
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 18.4242 }), [{ side: 'stock', deg: 18.4242 }]);
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 18.4242, stockTurnLongDeg: null, stockTurnShortDeg: null }), [{ side: 'stock', deg: 18.4242 }]);
  assert.deepEqual(stockSidesFrom({ stockTurnDeg: 0 }), []);
  assert.deepEqual(stockSidesFrom({}), []);
  assert.deepEqual(stockSidesFrom(null), []);
  assert.deepEqual(stockSidesFrom({ stockTurnLongDeg: 'x', stockTurnShortDeg: '' }), []);
});

test('stockSideFirst: the long side for the pattern\'s longer way, when it\'s clear', () => {
  assert.equal(stockSideFirst(200, 40), 'long');
  assert.equal(stockSideFirst(40, 200), 'short');
  assert.equal(stockSideFirst(200, 0), 'long');
  assert.equal(stockSideFirst(0, 60), 'short');
  assert.equal(stockSideFirst(-200, 40), 'long');
  assert.equal(stockSideFirst(0, 0), null);
  assert.equal(stockSideFirst(100, 100), null);
  assert.equal(stockSideFirst(104, 100), null);
  assert.equal(stockSideFirst(100, 104), null);
  assert.equal(stockSideFirst(NaN, 50), 'short');
});

test('stockSideDeg: two decimals and a true minus sign', () => {
  assert.equal(stockSideDeg(63.4349), '63.43\u00b0');
  assert.equal(stockSideDeg(-26.5651), '\u221226.57\u00b0');
  assert.equal(stockSideDeg(18.4242), '18.42\u00b0');
  assert.equal(stockSideDeg(-0.001), '0\u00b0');
  assert.equal(stockSideDeg(90), '90\u00b0');
});
