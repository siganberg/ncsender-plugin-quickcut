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

test('config.html carries the same mergePrograms and mergeProblems as lib/quickcut-gcode.cjs', () => {
  const body = (src, name) => {
    const start = src.indexOf('function ' + name + '(');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1).split('\n').map(l => l.trim()).join('\n');
  };
  const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'quickcut-gcode.cjs'), 'utf8');
  ['mergePrograms', 'mergeProblems'].forEach((name) => {
    assert.ok(html.indexOf('function ' + name + '(') >= 0, name);
    assert.equal(body(html, name), body(lib, name), name);
  });
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

test('bits from the tool library: any mix merges', () => {
  assert.deepEqual(gen.mergeProblems([
    { name: 'a.nc', gcode: circle({ toolNumber: 3 }) },
    { name: 'b.nc', gcode: rect({ toolNumber: 5, bitDiameter: 6 }) },
    { name: 'c.nc', gcode: circle({ toolNumber: 3 }) }
  ]), []);
});

test('a typed-in bit merges after a program that leaves the same size in the spindle', () => {
  assert.deepEqual(gen.mergeProblems([
    { name: 'a.nc', gcode: circle() },
    { name: 'b.nc', gcode: rect() },
    { name: 'c.nc', gcode: circle({ toolNumber: 3 }) },
    { name: 'd.nc', gcode: rect() }
  ]), []);
  // A typed-in bit first, then library tools: the tool changes cover it.
  assert.deepEqual(gen.mergeProblems([
    { name: 'a.nc', gcode: circle({ bitDiameter: 6 }) },
    { name: 'b.nc', gcode: rect({ toolNumber: 3 }) }
  ]), []);
});

test('a typed-in bit of another size is refused, naming both bits', () => {
  const p = gen.mergeProblems([
    { name: 'a.nc', gcode: circle() },
    { name: 'b.nc', gcode: rect({ bitDiameter: 6 }) }
  ]);
  assert.equal(p.length, 1);
  assert.match(p[0], /^Program 2 \(b\.nc\) has no tool change.*program 1 .*\(3 mm\), not its own \(6 mm\)\. Merge only programs that use the same bit, or, with a tool changer, pick its bit from the tool library/);
  const q = gen.mergeProblems([
    { name: 'a.nc', gcode: circle({ toolNumber: 3 }) },
    { name: 'b.nc', gcode: rect({ bitDiameter: 6 }) }
  ]);
  assert.match(q[0], /\(T3, 3 mm\), not its own \(6 mm\)/);
});

test('sizes compare across units, and a program with no bit noted is refused after another', () => {
  const inch = makeQuickCutGenerator(true).generateCircleProgram({ ...common, diameter: 1, bitDiameter: 0.25, depth: 0.1, depthOfCut: 0.05, cutType: 'outer' });
  assert.deepEqual(gen.mergeProblems([{ name: 'a.nc', gcode: circle({ bitDiameter: 6.35 }) }, { name: 'b.nc', gcode: inch }]), []);
  assert.match(gen.mergeProblems([{ name: 'a.nc', gcode: circle() }, { name: 'b.nc', gcode: inch }])[0], /\(3 mm\), not its own \(0\.25 in\)/);
  assert.match(gen.mergeProblems([{ name: 'a.nc', gcode: circle() }, { name: 'b.nc', gcode: 'G21\nG0 X1\n' }])[0], /not its own \(unknown\)/);
});

test('programs in different work offsets are refused', () => {
  assert.deepEqual(gen.mergeProblems([{ name: 'a.nc', gcode: 'G55\nG0 X1\n' }, { name: 'b.nc', gcode: 'G0 X2 (G54 is not code)\nG55\n' }])
    .filter((m) => /work offset/.test(m)), []);
  const p = gen.mergeProblems([{ name: 'a.nc', gcode: circle() }, { name: 'b.nc', gcode: 'G59.1\n' + circle() }]);
  assert.deepEqual(p, ['They don’t all run in the same work offset (1: the active one, 2: G59.1), so one would cut in the wrong place.']);
});

test('the same bit in mm and in inches merges, though the inch size is rounded', () => {
  const ig = makeQuickCutGenerator(true);
  const sizes = [1.5, 2, 5, 8.5, 11.5, 12, 15, 18.5, 21.5, 22, 25];
  sizes.forEach((mm) => {
    const inch = ig.generateCircleProgram({ ...common, diameter: 1, bitDiameter: +(mm / 25.4).toFixed(4), depth: 0.1, depthOfCut: 0.05, cutType: 'outer' });
    assert.deepEqual(gen.mergeProblems([{ name: 'a.nc', gcode: circle({ bitDiameter: mm }) }, { name: 'b.nc', gcode: inch }]), [], mm + ' mm');
    assert.deepEqual(gen.mergeProblems([{ name: 'a.nc', gcode: inch }, { name: 'b.nc', gcode: circle({ bitDiameter: mm }) }]), [], mm + ' mm after inch');
  });
});

test('a saved merge is checked by the programs in it, the last one leaving its bit', () => {
  const m = gen.mergePrograms([{ name: 'a.nc', gcode: circle() }, { name: 'b.nc', gcode: rect({ toolNumber: 5, bitDiameter: 6 }) }]);
  assert.match(gen.mergeProblems([{ name: 'm.nc', gcode: m }, { name: 'c.nc', gcode: circle() }])[0],
    /^Program 2 \(c\.nc\) .*program 1 leaves in the spindle \(T5, 6 mm\), not its own \(3 mm\)/);
  assert.deepEqual(gen.mergeProblems([{ name: 'm.nc', gcode: m }, { name: 'c.nc', gcode: circle({ bitDiameter: 6 }) }]), []);
  // A merge whose first program has no tool change must suit the bit before it.
  assert.match(gen.mergeProblems([{ name: 'a.nc', gcode: circle({ bitDiameter: 6 }) }, { name: 'm.nc', gcode: m }])[0],
    /^Program 2 \(m\.nc\) has no tool change, .*\(6 mm\), not its own \(3 mm\)/);
  // A part with no tool change inside it, after one that changed tools.
  const old = gen.mergePrograms([{ name: 'a.nc', gcode: circle({ toolNumber: 5, bitDiameter: 6 }) }, { name: 'b.nc', gcode: rect() }]);
  assert.match(gen.mergeProblems([{ name: 'old.nc', gcode: old }, { name: 'c.nc', gcode: circle({ toolNumber: 3 }) }])[0],
    /^Program 1 \(old\.nc\) has no tool change before its part 2, so it would cut with the bit already in the spindle \(T5, 6 mm\), not its own \(3 mm\)/);
});

test('a V-bit, pen or drag knife is not an end mill of the same width', () => {
  const vbit = gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'outer', bitDiameter: 3,
    chamfer: { width: 0.5, angle: 90, cutDepth: 6, cutBit: 6.35, depthOfCut: 0.5 } });
  assert.match(vbit, /^\(V-bit: /m);
  assert.match(gen.mergeProblems([{ name: 'a.nc', gcode: circle() }, { name: 'v.nc', gcode: vbit }])[0], /\(3 mm\), not its own \(3 mm V-bit\)/);
  assert.match(gen.mergeProblems([{ name: 'a.nc', gcode: circle() }, { name: 'p.nc', gcode: rect({ toolType: 'pen' }) }])[0], /\(3 mm\), not its own \(3 mm pen\)/);
  assert.match(gen.mergeProblems([{ name: 'p.nc', gcode: rect({ toolType: 'drag knife' }) }, { name: 'a.nc', gcode: circle() }])[0], /\(3 mm drag knife\), not its own \(3 mm\)/);
  assert.deepEqual(gen.mergeProblems([{ name: 'a.nc', gcode: rect({ toolType: 'pen' }) }, { name: 'b.nc', gcode: circle({ toolType: 'pen' }) }]), []);
  assert.deepEqual(gen.mergeProblems([{ name: 'a.nc', gcode: circle() }, { name: 'v.nc', gcode: vbit.replace(/^\(Bit Diameter: 3mm/m, '(Bit Diameter: 3mm, T4').replace(/^(G90 ; Absolute positioning)$/m, '$1\nM6 T4') }]), []);
});

test('a tool change with no bit noted still names its tool', () => {
  assert.match(gen.mergeProblems([{ name: 'x.nc', gcode: 'G21\nM6 T7\nG0 X1\n' }, { name: 'a.nc', gcode: circle() }])[0], /\(T7, unknown size\), not its own \(3 mm\)/);
});
