// Merge: saved programs as one program.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeQuickCutGenerator } = require('../lib/quickcut-gcode.cjs');

const gen = makeQuickCutGenerator(false);
const common = {
  origin: 'center', bitDiameter: 3, depth: 2, depthOfCut: 1,
  feedRate: 800, plungeFeedRate: 200, spindleRpm: 15000, spindleDelay: 0, mistM7: false, floodM8: false
};
const settings = '\n\n(QuickCut settings - used by Load)\n(QC1 eyJ2IjoxfQ==)\n';
const circle = (o) => gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'outer', ...o }) + settings;
const rect = (o) => gen.generateRectangleProgram({ ...common, width: 40, height: 20, cutType: 'outer', ...o }) + settings;

test('one program end, at the end; each part keeps its own header', () => {
  const g = gen.mergePrograms([{ name: 'a.nc', gcode: circle() }, { name: 'b.nc', gcode: rect() }]);
  assert.equal((g.match(/M30/g) || []).length, 1);
  assert.match(g, /M30 ; Program end\n$/);
  assert.equal((g.match(/^M3 S15000/gm) || []).length, 2);
  assert.equal((g.match(/^G21 ; Metric units$/gm) || []).length, 2);
  assert.match(g, /^\(QuickCut merge: 2 programs, cut in this order\)\n\(1\. a\.nc\)\n\(2\. b\.nc\)$/m);
  assert.ok(g.indexOf('(Program 1 of 2: a.nc)') < g.indexOf('(QuickCut: Circle)'));
  assert.ok(g.indexOf('(QuickCut: Circle)') < g.indexOf('(Program 2 of 2: b.nc)'));
  assert.ok(g.indexOf('(Program 2 of 2: b.nc)') < g.indexOf('(QuickCut: Rectangle)'));
});

test('the settings blocks Load reads are left out', () => {
  const g = gen.mergePrograms([{ name: 'a.nc', gcode: circle() }, { name: 'b.nc', gcode: rect() }]);
  assert.doesNotMatch(g, /QC1 |used by Load/);
});

test('a tool change to the tool already in the spindle is left out', () => {
  const g = gen.mergePrograms([
    { name: 'a.nc', gcode: circle({ toolNumber: 3 }) },
    { name: 'b.nc', gcode: rect({ toolNumber: 3 }) },
    { name: 'c.nc', gcode: circle({ toolNumber: 5 }) },
    { name: 'd.nc', gcode: rect({ toolNumber: 3 }) }
  ]);
  assert.deepEqual(g.match(/^M6 T\d+/gm), ['M6 T3', 'M6 T5', 'M6 T3']);
});

test('M2 and % go too; a line with more than the end keeps the rest', () => {
  const g = gen.mergePrograms([
    { name: 'a.nc', gcode: '%\nG21\nG0 X1\nM5 M2\n%\n' },
    { name: 'b.nc', gcode: 'G20\nG0 X2\nM02\n' }
  ]);
  assert.doesNotMatch(g, /^%|M0*2(?!\d)/m);
  assert.match(g, /^M5$/m);
  assert.match(g, /M30 ; Program end\n$/);
});

test('M 30 with a space ends nothing early, and nothing is left as a bare word', () => {
  const g = gen.mergePrograms([
    { name: 'a.nc', gcode: 'G21\nG0 X1\nM 30\n' },
    { name: 'b.nc', gcode: 'G21\nG0 X2\nM30 X\nM5 M30\n' }
  ]);
  assert.equal((g.match(/M\s*30/g) || []).length, 1);
  assert.doesNotMatch(g, /^X$/m);
  assert.match(g, /^M5$/m);
});

test('T and M6 on separate lines: the next tool change is kept', () => {
  const g = gen.mergePrograms([
    { name: 'a.nc', gcode: 'M6 T3\nG0 X1\n' },
    { name: 'b.nc', gcode: 'T5\nM6\nG0 X2\n' },
    { name: 'c.nc', gcode: 'M6 T3\nG0 X3\n' }
  ]);
  assert.deepEqual(g.match(/^(M6 T3|T5|M6)$/gm), ['M6 T3', 'T5', 'M6', 'M6 T3']);
});

test('a program with no tool change, after one that changed tools, starts with M0', () => {
  const g = gen.mergePrograms([
    { name: 'a.nc', gcode: circle() },
    { name: 'b.nc', gcode: rect({ toolNumber: 3 }) },
    { name: 'c.nc', gcode: circle() }
  ]);
  const at = (s) => g.indexOf(s);
  assert.equal((g.match(/^M0 ;/gm) || []).length, 1);
  assert.ok(at('(Program 3 of 3: c.nc)') < at('M0 ;'));
  assert.ok(at('(Program 2 of 3: b.nc)') < at('M6 T3') && at('M6 T3') < at('(Program 3 of 3: c.nc)'));
});

test('Windows line endings and a file without a final newline', () => {
  const g = gen.mergePrograms([{ name: 'a.nc', gcode: 'G21\r\nG0 X1\r\nM30\r\n' }, { name: 'b.nc', gcode: 'G20\nG0 X2' }]);
  assert.doesNotMatch(g, /\r/);
  assert.match(g, /G0 X1\n/);
  assert.match(g, /G0 X2\n\nM30 ; Program end\n$/);
});

test('config.html carries the same mergePrograms as lib/quickcut-gcode.cjs', () => {
  const body = (src) => {
    const start = src.indexOf('function mergePrograms(');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1).split('\n').map(l => l.trim()).join('\n');
  };
  const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'quickcut-gcode.cjs'), 'utf8');
  assert.ok(html.indexOf('function mergePrograms(') >= 0);
  assert.equal(body(html), body(lib));
});

test('every line fits in 79 plain ASCII characters, whatever the file names', () => {
  const long = 'QuickCut-Rectangle_W-120_H-80_R-6_D-6_Outer_P-3x2_mm (12) with a very long name too é!.nc';
  const g = gen.mergePrograms([{ name: long, gcode: circle() }, { name: 'b?~.nc', gcode: rect() }]);
  g.split('\n').forEach(l => {
    assert.ok(l.length <= 79, l);
    assert.match(l, /^[\x20-\x7e]*$/);
    if (!/^\(QC1 /.test(l)) assert.doesNotMatch(l, /[!?~]/);
    if (/^\((QuickCut merge|\d+\. |Program \d)/.test(l)) assert.ok(l.length <= 70, l);
  });
});
