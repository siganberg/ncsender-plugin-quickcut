// $SAFEZ: ncSender's own retract to its Safe Z setting, used when the
// running ncSender has it (community 2.0.228, Pro 2.0.326 on).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeQuickCutGenerator } = require('../lib/quickcut-gcode.cjs');

const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'quickcut-gcode.cjs'), 'utf8');

// A function's source, from "function name(" to its closing brace.
function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const ctx = {};
vm.runInNewContext(fnSource(html, 'safeZVersionOk') + '\nthis.ok = safeZVersionOk;', ctx);
const ok = ctx.ok;

const rect = {
  width: 40, height: 20, cornerRadius: 0, cutType: 'outer', origin: 'center',
  bitDiameter: 3, depth: 2, depthOfCut: 1, feedRate: 800, plungeFeedRate: 200,
  spindleRpm: 15000, spindleDelay: 0, mistM7: false, floodM8: false
};

test('safeZVersionOk: community from 2.0.228, Pro from 2.0.326', () => {
  assert.equal(ok('community', '2.0.227'), false);
  assert.equal(ok('community', '2.0.228'), true);
  assert.equal(ok('community', '2.1.0'), true);
  assert.equal(ok('pro', '2.0.325'), false);
  assert.equal(ok('pro', '2.0.326'), true);
  assert.equal(ok('pro', 'v2.0.329'), true);
  // Pro's numbers run ahead of community's: 2.0.300 is an older Pro.
  assert.equal(ok('pro', '2.0.300'), false);
});

test('safeZVersionOk: a beta of the first version, dev builds, nonsense', () => {
  assert.equal(ok('pro', '2.0.326-beta.1'), false);
  assert.equal(ok('pro', '2.0.327-beta.1'), true);
  assert.equal(ok('community', '2.0.230-dev'), true);
  assert.equal(ok('community', 'dev'), true);
  assert.equal(ok('community', 'banana'), false);
  assert.equal(ok('community', ''), false);
  assert.equal(ok('community', undefined), false);
});

test('safeZVersionOk: no edition uses the community threshold', () => {
  assert.equal(ok(undefined, '2.0.227'), false);
  assert.equal(ok(undefined, '2.0.228'), true);
});

test('safeZCommand false or missing: the output is unchanged', () => {
  for (const imperial of [false, true]) {
    const gen = makeQuickCutGenerator(imperial).generateRectangleProgram;
    for (const safeZHeightMm of [-5, null]) {
      const p = { ...rect, safeZHeightMm, toolNumber: 2 };
      assert.equal(gen({ ...p, safeZCommand: false }), gen(p));
    }
  }
  const g = makeQuickCutGenerator(false).generateRectangleProgram({ ...rect, safeZHeightMm: -5, safeZCommand: false });
  assert.match(g, /^G53 G0 Z-5\.000 ; Move to safe Z$/m);
  assert.doesNotMatch(g, /\$SAFEZ/);
});

test('safeZCommand true: every retract is $SAFEZ, metric and inches', () => {
  for (const imperial of [false, true]) {
    for (const safeZHeightMm of [-5, null]) {
      const g = makeQuickCutGenerator(imperial).generateRectangleProgram(
        { ...rect, safeZHeightMm, safeZCommand: true, toolNumber: 2 });
      assert.doesNotMatch(g, /G53/);
      const lines = g.split('\n');
      assert.deepEqual(lines.filter(l => /SAFEZ/.test(l)),
        ['$SAFEZ ; Move to safe Z', '$SAFEZ ; Move to safe Z', '$SAFEZ ; Return to safe Z']);
      // Before and after the tool change, and before the program end.
      const m6 = lines.findIndex(l => /^M6 T2/.test(l));
      assert.equal(lines[m6 - 1], '$SAFEZ ; Move to safe Z');
      assert.equal(lines[m6 + 2], '$SAFEZ ; Move to safe Z');
      assert.ok(lines.indexOf('$SAFEZ ; Return to safe Z') < lines.indexOf('M30 ; Program end'));
    }
  }
});

test('safeZCommand true: a keepout inside the board lifts in Wasteboard Surfacing too', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const base = {
    mode: 'wasteboard', width: 812, height: 1230, origin: 'front-left', pattern: 'zigzagY', stepoverPct: 40,
    depth: 0.5, depthOfCut: 0.5, bitDiameter: 6, feedRate: 2000, plungeFeedRate: 500,
    spindleRpm: 15000, spindleDelay: 1, mistM7: false, floodM8: false, safeZHeightMm: -5,
    keepouts: [{ name: 'clamp', minX: 300, minY: 400, maxX: 500, maxY: 800 }]
  };
  const old = gen(base), now = gen({ ...base, safeZCommand: true });
  assert.ok(old.split('\n').filter(l => l === 'G53 G0 Z-5.000').length > 0);
  assert.doesNotMatch(now, /G53/);
  assert.equal(now.split('\n').filter(l => l === '$SAFEZ').length,
    old.split('\n').filter(l => l === 'G53 G0 Z-5.000').length);
});

test('safeZCommand true: a pen\'s Max plunge leaves $SAFEZ lines alone', () => {
  const g = makeQuickCutGenerator(false).generateCircleProgram({
    ...rect, diameter: 30, toolType: 'pen', toolMaxPlungeMm: 0.5, safeZHeightMm: -5, safeZCommand: true
  });
  assert.match(g, /^\$SAFEZ ; Move to safe Z$/m);
  assert.match(g, /^\$SAFEZ ; Return to safe Z$/m);
});

test('every $SAFEZ line fits in 79 plain ASCII characters', () => {
  const g = makeQuickCutGenerator(false).generateRectangleProgram(
    { ...rect, safeZHeightMm: -5, safeZCommand: true, toolNumber: 3, toolName: 'Endmill' });
  g.split('\n').forEach(l => {
    assert.ok(l.length <= 79, l);
    assert.match(l, /^[\x20-\x7e]*$/);
  });
});

test('config.html carries the same retract code as lib/quickcut-gcode.cjs', () => {
  const norm = (s) => s.split('\n').map(l => l.trim()).join('\n');
  for (const name of ['coreSafeZLine', 'safeZRetract', 'machineSafeZLine', 'programFooter', 'penLimited']) {
    assert.equal(norm(fnSource(html, name)), norm(fnSource(lib, name)), name);
  }
  // The header differs only in comments elsewhere; its retract lines match.
  const retracts = (s) => norm(fnSource(s, 'programHeader')).split('\n').filter(l => /csz|sz\b|SAFEZ/.test(l));
  assert.deepEqual(retracts(html), retracts(lib));
});

test('the dialog passes safeZCommand wherever it passes safeZHeightMm', () => {
  const heights = (html.match(/safeZHeightMm:\s+state\.safeZHeightMm,\n\s+safeZCommand:\s+state\.safeZCommand\n/g) || []).length;
  assert.equal(heights, (html.match(/safeZHeightMm:\s+state\.safeZHeightMm/g) || []).length);
  assert.ok(heights >= 9);
  assert.match(html, /ncSenderHasSafeZ\(BASE_URL\)\.then\(function\(ok\) \{ state\.safeZCommand = ok; \}\);/);
});
