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
function cutDepths(gcode, flatOnly) {
  let z = Infinity;
  const depths = new Set();
  for (const l of gcode.split('\n')) {
    const m = /^G[0-3]\b/.exec(l);
    if (!m) continue;
    const zm = /Z(-?[\d.]+)/.exec(l);
    const xy = /[XYIJ]-?[\d.]/.test(l.replace(/Z-?[\d.]+/, ''));
    if (xy && /^G[1-3]\b/.test(l) && !(flatOnly && zm && +zm[1] !== z)) depths.add((zm ? +zm[1] : z).toFixed(3));
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

test('straightIn: a circle chamfer cuts a lap at every pass', () => {
  const gen = makeQuickCutGenerator(false);
  const p = { ...common, diameter: 30, cutType: 'inner', depth: 6, depthOfCut: 1.5, bitDiameter: 12.7, toolNumber: 22,
    chamfer: { width: 2, angle: 90, cutDepth: 6, cutBit: 6.35, depthOfCut: 0.5 } };
  const ramped = gen.generateCircleProgram(p);
  const straight = gen.generateCircleProgram({ ...p, straightIn: 'drag knife' });
  const want = cutDepths(ramped, true);
  const got = cutDepths(straight, true);
  assert.ok(want.size > 2, 'the chamfer has several passes');
  for (const z of want) assert.ok(got.has(z), 'cuts a lap at Z' + z);
  assert.deepEqual(downWhileMoving(straight), []);
});
