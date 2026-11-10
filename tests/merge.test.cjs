// Merge: saved programs as one program.
const { test } = require('node:test');
const assert = require('node:assert/strict');
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

test('every line fits in 79 plain ASCII characters, whatever the file names', () => {
  const long = 'QuickCut-Rectangle_W-120_H-80_R-6_D-6_Outer_P-3x2_mm (12) with a very long name too é!.nc';
  const g = gen.mergePrograms([{ name: long, gcode: circle() }, { name: 'b?~.nc', gcode: rect() }]);
  g.split('\n').forEach(l => {
    assert.ok(l.length <= 79, l);
    assert.match(l, /^[\x20-\x7e]*$/);
    if (!/^\(QC1 /.test(l)) assert.doesNotMatch(l, /[!?~]/);
  });
});
