// A drag knife, pen or laser: straight down at each start, no ramps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeQuickCutGenerator } = require('../lib/quickcut-gcode.cjs');

const common = {
  origin: 'center', bitDiameter: 3, depth: 3, depthOfCut: 1,
  feedRate: 800, plungeFeedRate: 200, spindleRpm: 0, spindleDelay: 0, mistM7: false, floodM8: false
};
const programs = (gen, o) => [
  gen.generateRectangleProgram({ ...common, width: 50, height: 30, cornerRadius: 0, cutType: 'outer', ...o }),
  gen.generateRectangleProgram({ ...common, width: 50, height: 30, cornerRadius: 0, cutType: 'outer', tabs: { count: 4, width: 6, height: 1 }, ...o }),
  gen.generateRectangleProgram({ ...common, width: 50, height: 30, cornerRadius: 0, cutType: 'clearing', ...o }),
  gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'inner', ...o }),
  gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'outer', tabs: { count: 4, width: 6, height: 1 }, ...o }),
  gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'clearing', ...o }),
  gen.generatePolygonProgram({ ...common, sides: 6, radius: 20, cutType: 'outer', ...o }),
  gen.generatePolygonProgram({ ...common, sides: 6, radius: 20, cutType: 'clearing', ...o }),
  gen.generateSlotProgram({ ...common, slotType: 'straight', length: 60, width: 10, angleDeg: 0, cutType: 'inner', ...o }),
  gen.generateSlotProgram({ ...common, slotType: 'arc', radius: 50, startAngleDeg: 45, sweepDeg: 90, width: 10, cutType: 'center', ...o })
];

// The moves in X and Y (lines or arcs) that also go down.
function downWhileMoving(gcode) {
  let z = Infinity;
  return gcode.split('\n').filter((l) => {
    const m = /^G[0-3]\b.*Z(-?[\d.]+)/.exec(l);
    if (!m) return false;
    const down = +m[1] < z - 1e-9 && /[XYIJ]-?[\d.]/.test(l.replace(/Z-?[\d.]+/, ''));
    z = +m[1];
    return down;
  });
}

[false, true].forEach((imperial) => {
  test('straightIn: every entry is straight down, in ' + (imperial ? 'inches' : 'mm'), () => {
    const gen = makeQuickCutGenerator(imperial);
    const ramped = programs(gen, {});
    const straight = programs(gen, { straightIn: 'drag knife' });
    ramped.forEach((g, i) => assert.ok(downWhileMoving(g).length > 0, 'program ' + i + ' ramps without it'));
    straight.forEach((g, i) => {
      assert.deepEqual(downWhileMoving(g), [], 'program ' + i);
      assert.match(g, /^\(Entry: straight down, no ramps, for a drag knife\)$/m);
      assert.doesNotMatch(g, /ramp along/);
      assert.doesNotMatch(g, /^\(null\)$/m);
    });
  });
});

test('a pen or drag-knife tool type goes straight down too; a laser keeps its spindle', () => {
  const gen = makeQuickCutGenerator(false);
  programs(gen, { toolType: 'drag-knife', spindleRpm: 15000 }).forEach((g, i) => {
    assert.deepEqual(downWhileMoving(g), [], 'program ' + i);
    assert.match(g, /^\(Entry: straight down, no ramps, for a drag knife\)$/m);
  });
  programs(gen, { toolType: 'pen' }).forEach((g) => assert.match(g, /for a pen\)$/m));
  const laser = gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'inner', spindleRpm: 800, straightIn: 'laser' });
  assert.match(laser, /^M3 S800 /m);
  assert.deepEqual(downWhileMoving(laser), []);
});

test('straightIn is not kept for the next program without it', () => {
  const gen = makeQuickCutGenerator(false);
  programs(gen, { straightIn: true });
  const after = gen.generateCircleProgram({ ...common, diameter: 30, cutType: 'inner' });
  assert.ok(downWhileMoving(after).length > 0);
  assert.doesNotMatch(after, /straight down/);
});

// The depths where a program cuts in X and Y (moves that end at that Z).
function cutDepths(gcode) {
  let z = Infinity;
  const depths = new Set();
  for (const l of gcode.split('\n')) {
    const m = /^G[0-3]\b/.exec(l);
    if (!m) continue;
    const zm = /Z(-?[\d.]+)/.exec(l);
    const xy = /[XYIJ]-?[\d.]/.test(l.replace(/Z-?[\d.]+/, ''));
    if (xy && /^G[1-3]\b/.test(l)) depths.add((zm ? +zm[1] : z).toFixed(3));
    if (zm) z = +zm[1];
  }
  return depths;
}

[false, true].forEach((imperial) => {
  test('straightIn: every shape cuts at every depth, in ' + (imperial ? 'inches' : 'mm'), () => {
    const gen = makeQuickCutGenerator(imperial);
    const k = imperial ? 1 / 25.4 : 1;
    const levels = [3, 6, 7].map((d) => (-d * k).toFixed(3));
    const o = { bitDiameter: 3 * k, depth: 7 * k, depthOfCut: 3 * k, straightIn: 'drag knife' };
    const tabs = { count: 4, width: 6 * k, height: 1 * k };
    const shapes = [
      ['circle', gen.generateCircleProgram({ ...common, diameter: 30 * k, cutType: 'outer', ...o })],
      ['circle, tabs', gen.generateCircleProgram({ ...common, diameter: 30 * k, cutType: 'outer', tabs, ...o })],
      ['circle, inner', gen.generateCircleProgram({ ...common, diameter: 30 * k, cutType: 'inner', ...o })],
      ['rectangle', gen.generateRectangleProgram({ ...common, width: 50 * k, height: 30 * k, cornerRadius: 0, cutType: 'outer', ...o })],
      ['rectangle, tabs', gen.generateRectangleProgram({ ...common, width: 50 * k, height: 30 * k, cornerRadius: 0, cutType: 'outer', tabs, ...o })],
      ['polygon', gen.generatePolygonProgram({ ...common, sides: 6, radius: 20 * k, cutType: 'outer', ...o })],
      ['slot', gen.generateSlotProgram({ ...common, slotType: 'straight', length: 60 * k, width: 10 * k, angleDeg: 0, cutType: 'inner', ...o })]
    ];
    for (const [name, g] of shapes) {
      const cut = cutDepths(g);
      for (const z of levels) assert.ok(cut.has(z), name + ' cuts at Z' + z);
    }
  });
});

test('a chamfer with a pen, drag knife or laser cuts nothing and says why', () => {
  for (const imperial of [false, true]) {
    const gen = makeQuickCutGenerator(imperial);
    const k = imperial ? 1 / 25.4 : 1;
    const chamfer = { width: 1 * k, angle: 90, cutDepth: 6 * k, cutBit: 6.35 * k, depthOfCut: 0.5 * k };
    const base = { ...common, bitDiameter: 12.7 * k, depth: 6 * k, depthOfCut: 1.5 * k, toolNumber: 22, chamfer };
    const programs = (o) => [
      gen.generateCircleProgram({ ...base, diameter: 30 * k, cutType: 'inner', ...o }),
      gen.generateRectangleProgram({ ...base, width: 50 * k, height: 30 * k, cornerRadius: 0, cutType: 'outer', ...o }),
      gen.generatePolygonProgram({ ...base, sides: 6, radius: 20 * k, cutType: 'outer', ...o }),
      gen.generateSlotProgram({ ...base, slotType: 'straight', length: 60 * k, width: 20 * k, angleDeg: 0, cutType: 'inner', ...o })
    ];
    programs({}).forEach((g, i) => assert.match(g, /^G[123] .*[XY]-?[\d.]/m, 'a V-bit chamfers, program ' + i));
    for (const [o, what] of [[{ toolType: 'pen' }, 'pen'], [{ toolType: 'drag-knife' }, 'drag knife'], [{ straightIn: 'laser', spindleRpm: 800 }, 'laser']]) {
      programs(o).forEach((g, i) => {
        assert.match(g, new RegExp('^\\(WARNING: a chamfer needs a spinning V-bit, not a ' + what + '; nothing to cut\\)$', 'm'), what + ' ' + i);
        assert.doesNotMatch(g, /^G[123] /m, what + ' ' + i + ' moves');
      });
    }
  }
});

// A rapid in X or Y with the tip below the top would drag a pen or knife.
function rapidsBelowTop(gcode) {
  let z = Infinity;
  return gcode.split('\n').filter((l) => {
    const zm = /Z(-?[\d.]+)/.exec(l);
    if (zm) z = +zm[1];
    return /^G0\b/.test(l) && /[XY]-?[\d.]/.test(l) && z < -1e-9;
  });
}

test('straightIn: clearing lifts between depths and names one entry', () => {
  for (const imperial of [false, true]) {
    const gen = makeQuickCutGenerator(imperial);
    const k = imperial ? 1 / 25.4 : 1;
    const o = { ...common, bitDiameter: 3 * k, depth: 6 * k, depthOfCut: 2 * k, stepoverPct: 40, cutType: 'clearing', straightIn: 'drag knife' };
    for (const g of [gen.generateRectangleProgram({ ...o, width: 40 * k, height: 30 * k, cornerRadius: 0 }), gen.generateCircleProgram({ ...o, diameter: 40 * k })]) {
      assert.deepEqual(rapidsBelowTop(g), []);
      assert.equal((g.match(/^\(Entry: /gm) || []).length, 1);
    }
  }
});

test('Max plunge: the floor is never rounded deeper', () => {
  const gen = makeQuickCutGenerator(true);
  const g = gen.generateCircleProgram({ ...common, bitDiameter: 0.02, depth: 0.1, depthOfCut: 0.05, diameter: 1, cutType: 'outer', toolType: 'pen', toolMaxPlungeMm: 0.5 });
  const deepest = Math.min(...[...g.matchAll(/^G[0-3]\b.*Z(-?[\d.]+)/gm)].map((m) => +m[1]));
  assert.ok(deepest >= -0.5 / 25.4, 'deepest Z' + deepest);
});
