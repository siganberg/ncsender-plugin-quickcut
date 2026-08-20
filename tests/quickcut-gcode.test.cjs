const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeQuickCutGenerator } = require('../lib/quickcut-gcode.cjs');

const GRBL_ARC_TOLERANCE_INCH = 0.00008;
const GRBL_ARC_TOLERANCE_MM = 0.002;

function baseParams(overrides) {
  return Object.assign({
    width: 50, height: 30,
    cornerRadius: 0,
    cutType: 'outer',
    origin: 'center',
    bitDiameter: 3.175,
    depth: 5, depthOfCut: 1,
    feedRate: 800, plungeFeedRate: 200,
    spindleRpm: 15000, spindleDelay: 1,
    mistM7: false, floodM8: false
  }, overrides || {});
}

function parseXY(line, prev) {
  const m = (re) => {
    const r = line.match(re);
    return r ? parseFloat(r[1]) : null;
  };
  const x = m(/(?<![A-Z])X(-?\d+\.?\d*)/i);
  const y = m(/(?<![A-Z])Y(-?\d+\.?\d*)/i);
  return { x: x !== null ? x : prev.x, y: y !== null ? y : prev.y };
}

function parseArc(line) {
  const m = (re) => {
    const r = line.match(re);
    return r ? parseFloat(r[1]) : null;
  };
  return {
    endX: m(/(?<![A-Z])X(-?\d+\.?\d*)/i),
    endY: m(/(?<![A-Z])Y(-?\d+\.?\d*)/i),
    i:    m(/(?<![A-Z])I(-?\d+\.?\d*)/i),
    j:    m(/(?<![A-Z])J(-?\d+\.?\d*)/i)
  };
}

function maxArcRadiusDelta(gcode) {
  const lines = gcode.split('\n');
  let pos = { x: 0, y: 0 };
  let worst = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('(')) continue;
    if (/^G0*[23]\b/i.test(line)) {
      const a = parseArc(line);
      if (a.endX === null || a.endY === null || a.i === null || a.j === null) continue;
      const cx = pos.x + a.i, cy = pos.y + a.j;
      const rS = Math.hypot(pos.x - cx, pos.y - cy);
      const rE = Math.hypot(a.endX - cx, a.endY - cy);
      const d = Math.abs(rS - rE);
      if (d > worst) worst = d;
      pos = { x: a.endX, y: a.endY };
    } else if (/^G0*[01]\b/i.test(line) || /^[XY]/i.test(line)) {
      pos = parseXY(line, pos);
    }
  }
  return worst;
}

// ---------- Rectangle: sharp corners ----------
//
// cornerRadius=0 → sharp part corners → sharp tool-path corners for
// either inner or outer cut mode. Outer cutting makes sharp outside
// corners by sharp-turning the tool center path around the part corner.
test('metric inner-cut rectangle with cornerRadius=0 has no arcs', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 50, height: 30, cornerRadius: 0, cutType: 'inner', bitDiameter: 3.175
  }));

  assert.match(gcode, /^G21 ; Metric units/m);
  assert.match(gcode, /^M3 S15000 ; Start spindle/m);
  assert.match(gcode, /^M30 ; Program end/m);
  assert.ok(!/\bG0*3\b/.test(gcode), 'inner sharp-corner path should have no arcs');
  const g1Count = gcode.split('\n').filter(l => /^G1\b/.test(l.trim())).length;
  assert.ok(g1Count > 5, `expected several G1 lines, got ${g1Count}`);
});

// ---------- Rectangle: rounded corners ----------
test('rounded-corner rectangle emits 4 G3 corner arcs per lap, radii consistent', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 50, height: 30, cornerRadius: 5, cutType: 'outer',
    depth: 2, depthOfCut: 1
    // Flat multi-pass: 2 depth-of-cut laps → 8 arcs (4 corners × 2 laps).
  }));

  const arcs = gcode.split('\n').filter(l => /^G3\b/.test(l.trim()));
  assert.equal(arcs.length, 8, `expected 4 arcs per lap x 2 laps = 8, got ${arcs.length}`);
  const worst = maxArcRadiusDelta(gcode);
  assert.ok(worst < GRBL_ARC_TOLERANCE_MM,
    `arc radius mismatch ${worst} exceeds grbl tolerance ${GRBL_ARC_TOLERANCE_MM}`);
});

test('outer cut with cornerRadius=0 emits sharp corners (no arcs)', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 50, height: 30, cornerRadius: 0, cutType: 'outer',
    bitDiameter: 3.175
  }));
  assert.ok(!/\bG0*3\b/.test(gcode),
    'outer cut with cornerRadius=0 must not emit arcs');
});

test('imperial rounded-corner arcs stay within grbl tolerance', () => {
  const gen = makeQuickCutGenerator(true).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 2, height: 1.5, cornerRadius: 0.25, cutType: 'outer',
    bitDiameter: 0.125, depth: 0.2, depthOfCut: 0.05,
    feedRate: 30, plungeFeedRate: 5
  }));
  const worst = maxArcRadiusDelta(gcode);
  assert.ok(worst < GRBL_ARC_TOLERANCE_INCH,
    `arc radius mismatch ${worst} in exceeds grbl tolerance ${GRBL_ARC_TOLERANCE_INCH}`);
});

// ---------- Cut type: inner vs outer offsets ----------
test('inner cut shrinks path by bitRadius; outer cut grows path by bitRadius', () => {
  const gen = makeQuickCutGenerator(false);
  const inner = gen.generateRectangleProgram(baseParams({
    width: 50, height: 30, cornerRadius: 0, cutType: 'inner',
    bitDiameter: 6
  }));
  // With bitDiameter=6: toolRadius=3.
  //   Inner path half-w = 25 - 3 = 22, half-h = 15 - 3 = 12
  //   Path corners: xR=22, yB=-12 → first G1 goes to (22, -12).
  assert.match(inner, /G1 X22\.000 Y-12\.000/);

  // Outer with cornerRadius=0: sharp part corners → sharp tool-path
  // corners. Half-w = 25 + 3 = 28, half-h = 15 + 3 = 18 → first G1 goes
  // to (28, -18). (Regression guard: earlier bug rounded the tool path
  // by toolRadius even when the user asked for sharp part corners.)
  const outer = gen.generateRectangleProgram(baseParams({
    width: 50, height: 30, cornerRadius: 0, cutType: 'outer',
    bitDiameter: 6
  }));
  assert.match(outer, /G1 X28\.000 Y-18\.000/);
  assert.ok(!/\bG0*3\b/.test(outer),
    'outer + cornerRadius=0 should emit sharp corners (no arcs)');
});

// ---------- Origin ----------
test('origin=center puts shape midpoint at (0,0)', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 20, origin: 'center', cornerRadius: 0, cutType: 'outer', bitDiameter: 0
  }));
  // First G0 goes to (0, -10) — mid-bottom of a 40x20 rect centered at 0
  assert.match(gcode, /G0 X0\.000 Y-10\.000/);
});

test('origin=back-left puts back-left of bounding box at (0,0)', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 20, origin: 'back-left', cornerRadius: 0, cutType: 'outer', bitDiameter: 0
  }));
  // Local center offset for top-left = (+w/2, -h/2) = (20, -10). Start = (cx, cy - h/2) = (20, -20).
  assert.match(gcode, /G0 X20\.000 Y-20\.000/);
});

test('origin=back-center puts back-center of bounding box at (0,0)', () => {
  // Center offset = (0, -h/2) = (0, -10). Start = (cx, cy - h/2) = (0, -20).
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 20, origin: 'back-center', cornerRadius: 0, cutType: 'outer', bitDiameter: 0
  }));
  assert.match(gcode, /G0 X0\.000 Y-20\.000/);
});

test('origin=front-center puts front-center of bounding box at (0,0)', () => {
  // Center offset = (0, +h/2) = (0, 10). Start = (cx, cy - h/2) = (0, 0).
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 20, origin: 'front-center', cornerRadius: 0, cutType: 'outer', bitDiameter: 0
  }));
  assert.match(gcode, /G0 X0\.000 Y0\.000/);
});

test('origin=left-center puts left-center of bounding box at (0,0)', () => {
  // Center offset = (+w/2, 0) = (20, 0). Start = (cx, cy - h/2) = (20, -10).
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 20, origin: 'left-center', cornerRadius: 0, cutType: 'outer', bitDiameter: 0
  }));
  assert.match(gcode, /G0 X20\.000 Y-10\.000/);
});

test('origin=right-center puts right-center of bounding box at (0,0)', () => {
  // Center offset = (-w/2, 0) = (-20, 0). Start = (cx, cy - h/2) = (-20, -10).
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 20, origin: 'right-center', cornerRadius: 0, cutType: 'outer', bitDiameter: 0
  }));
  assert.match(gcode, /G0 X-20\.000 Y-10\.000/);
});

// ---------- Depth passes ----------
test('depth passes: flat multi-pass, one plunge + one lap per DOC step', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    depth: 6, depthOfCut: 2, cornerRadius: 0, cutType: 'inner', bitDiameter: 3.175
    // 3 passes (depth 2/4/6). Each pass = 1 G1 plunge + 5 G1 lap lines
    // (4 edges + return-to-start) = 6 G1s. Total = 18 G1s. No helical
    // ramping, no cleanup lap.
  }));
  const g1s = gcode.split('\n').filter(l => /^G1\b/.test(l.trim())).length;
  assert.equal(g1s, 18, `expected 18 G1 lines, got ${g1s}`);
  // Verify each plunge is a Z-only move at plungeFeedRate.
  const plunges = gcode.split('\n').filter(l => /^G1 Z-\d/.test(l.trim()));
  assert.equal(plunges.length, 3, `expected 3 Z plunges, got ${plunges.length}`);
  for (const p of plunges) {
    assert.match(p, /F200\b/, `plunge should use plunge feedrate, got: ${p}`);
  }
  // Cutting laps use the cutting feedrate.
  assert.match(gcode, /G1 X\S+ Y\S+ F800/);
});

// ---------- Safe Z ----------
test('safeZHeightMm routes program start + end through G53', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({ safeZHeightMm: -5 }));
  assert.match(gcode, /G53 G0 Z-5\.000 ; Move to safe Z/);
  assert.match(gcode, /G53 G0 Z-5\.000 ; Return to safe Z/);
  assert.doesNotMatch(gcode, /G53 G0 Z0 /);
});

test('imperial + safeZHeightMm converts mm → inches', () => {
  const gen = makeQuickCutGenerator(true).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 2, height: 1.5, cornerRadius: 0, cutType: 'outer',
    bitDiameter: 0.125, depth: 0.2, depthOfCut: 0.05,
    feedRate: 30, plungeFeedRate: 5,
    safeZHeightMm: -5
  }));
  assert.match(gcode, /G53 G0 Z-0\.197 ; Move to safe Z/);
  assert.match(gcode, /G53 G0 Z-0\.197 ; Return to safe Z/);
});

test('safeZHeightMm=null falls back to G53 G0 Z0', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({ safeZHeightMm: null }));
  assert.match(gcode, /G53 G0 Z0 ; Move to machine Z0/);
  assert.match(gcode, /G53 G0 Z0 ; Return to machine Z0/);
});

// ---------- Rectangle: clearing (helical bore + expanding outward) ----------
//
// New clearing algorithm: helical bore at pocket center descends to depth,
// then concentric rectangles cut outward from innermost to outermost.
// Between levels the tool executes a G1 cut through material (outward
// motion always advances into fresh material). Helix radius = 0.6 ×
// toolRadius so the tool footprint sweeping around the helix path covers
// the pocket center — no leftover pillar.
test('clearing emits helical bore then expanding concentric rectangles', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 50, height: 30, cornerRadius: 0, cutType: 'clearing',
    bitDiameter: 6, depth: 2, depthOfCut: 1,
    stepoverPct: 40
    // bitDiameter=6, stepover=40% → step=2.4mm.
    // Outer path: halfW=22, halfH=12.
    // 5 concentric levels (same as before). 2 depth passes.
    // Helix radius = 0.6 × 3 = 1.8mm (center-clearing guarantee).
  }));

  assert.match(gcode, /^\(QuickCut: Rectangle \(clearing\)\)/m);
  assert.match(gcode, /^\(Entry: helical bore then expanding outward\)/m);
  assert.match(gcode, /^\(Stepover: 40%/m);

  // Rectangle laps: 5 G1 XY lines per sharp-corner lap × 5 levels × 2
  // passes = 50 G1 XY. Plus transitions (helix→innermost = 1 per pass;
  // between-level = 4 per pass) × 2 passes = 10 more G1 XY. Total = 60.
  const g1XY = gcode.split('\n').filter(l => /^G1 X\S+ Y\S+/.test(l.trim())).length;
  assert.equal(g1XY, 60, `expected 60 G1 XY lines (50 laps + 10 transitions), got ${g1XY}`);

  // Helical descent replaces plunge — no G1 Z-only lines.
  const g1Zonly = gcode.split('\n').filter(l => /^G1 Z-?\d/.test(l.trim())).length;
  assert.equal(g1Zonly, 0, `expected no G1 Z plunge (helix takes over), got ${g1Zonly}`);

  // At least one helical G3 with Z per depth pass. Pass 1 descends
  // from +2 to -1 (3mm ≤ maxPitch 1.5 → 2 turns). Pass 2 descends from
  // -1 to -2 (1mm ≤ 1.5 → 1 turn). Each turn = 2 semicircles (visualizer
  // compatibility), so 2×(2+1) = 6 helical arcs.
  const helices = gcode.split('\n').filter(l => /^G3\b.*\bZ-?\d/.test(l.trim()));
  assert.equal(helices.length, 6, `expected 6 helical G3 arcs (2 semicircles × (2 turns pass1 + 1 turn pass2)), got ${helices.length}`);
});

test('helix radius stays under toolRadius so center gets cleared', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 50, height: 30, cornerRadius: 0, cutType: 'clearing',
    bitDiameter: 6, depth: 1, depthOfCut: 1, stepoverPct: 40
  }));
  // Helix G3 lines carry I<-helixRadius> J0. Parse I to get helixRadius
  // and verify it's below toolRadius (3) — if it weren't, a pillar of
  // uncut material would remain at the pocket center.
  const helixLine = gcode.split('\n').map(l => l.trim())
    .find(l => /^G3\b.*\bZ-?\d/.test(l));
  assert.ok(helixLine, 'expected a helical G3 line');
  const iMatch = helixLine.match(/(?<![A-Z])I(-?\d+\.?\d*)/i);
  assert.ok(iMatch, `helix line missing I offset: ${helixLine}`);
  const helixRadius = Math.abs(parseFloat(iMatch[1]));
  const toolRadius = 3;
  assert.ok(helixRadius < toolRadius,
    `helix radius ${helixRadius} must be < toolRadius ${toolRadius} to clear center`);
  assert.ok(helixRadius > toolRadius * 0.1,
    `helix radius ${helixRadius} too small — should fall back to plunge instead`);
});

test('clearing transitions between levels are G1 cuts, not G0 rapids', () => {
  // In expanding-outward, every level advances into uncut material — so
  // level-to-level moves must be G1 (cutting), never G0. A G0 would send
  // the tool into fresh material at max feed and break the bit.
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 40, cornerRadius: 0, cutType: 'clearing',
    bitDiameter: 6, depth: 1, depthOfCut: 1, stepoverPct: 50
  }));
  const lines = gcode.split('\n').map(l => l.trim());
  // Any G0 XY line at cutting depth (post-helix, pre-final-lift) must be
  // ONLY the between-pass return-to-helix-start (there's just one pass
  // here, so zero). Verify no G0 XY appears between the first G3 helix
  // and the final G0 Z lift.
  const g3Idx = lines.findIndex(l => /^G3\b.*\bZ-?\d/.test(l));
  const finalLiftIdx = lines.length - 1
    - [...lines].reverse().findIndex(l => /^G0 Z/.test(l));
  assert.ok(g3Idx >= 0 && finalLiftIdx > g3Idx, 'expected helix then final Z lift');
  const between = lines.slice(g3Idx + 1, finalLiftIdx);
  const g0XY = between.filter(l => /^G0 X\S+ Y\S+/.test(l));
  assert.equal(g0XY.length, 0,
    `single-pass clearing should have zero G0 XY between helix and final lift, got ${g0XY.length}: ${g0XY.join(' | ')}`);
});

test('clearing multi-pass rapids back to helix start between passes only', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 40, cornerRadius: 0, cutType: 'clearing',
    bitDiameter: 6, depth: 3, depthOfCut: 1, stepoverPct: 50
    // 3 depth passes. Between passes: 2 return-to-helix-start rapids.
  }));
  const lines = gcode.split('\n').map(l => l.trim());
  const g3Idx = lines.findIndex(l => /^G3\b.*\bZ-?\d/.test(l));
  const finalLiftIdx = lines.length - 1
    - [...lines].reverse().findIndex(l => /^G0 Z/.test(l));
  const between = lines.slice(g3Idx + 1, finalLiftIdx);
  const g0XY = between.filter(l => /^G0 X\S+ Y\S+/.test(l));
  assert.equal(g0XY.length, 2,
    `3-pass clearing expects 2 return-to-helix-start G0 XY rapids, got ${g0XY.length}`);
});

test('clearing on shape smaller than tool warns and skips', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 5, height: 5, cornerRadius: 0, cutType: 'clearing',
    bitDiameter: 6
  }));
  assert.match(gcode, /WARNING: shape smaller than tool diameter/);
  assert.ok(!/\bG1 X.*Y/.test(gcode), 'should emit no cutting moves');
});

test('clearing preserves cornerRadius only on outermost level', () => {
  // Interior levels are roughing — sharp corners are fine and simpler.
  // Only the final outermost pass carries the finished part's radius.
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 40, height: 40, cornerRadius: 8, cutType: 'clearing',
    bitDiameter: 6, depth: 1, depthOfCut: 1, stepoverPct: 50
    // Single depth pass. Descent = 3mm (from slowPlungeStart Z=+2 to Z=-1),
    // maxPitch = 1.5 → 2 helix turns. Plus 4 corner arcs on outermost.
    // Total G3 = 6.
  }));
  // Corner arcs on outermost: G3 without Z (constant Z during a lap).
  const cornerArcs = gcode.split('\n').filter(l => {
    const t = l.trim();
    return /^G3\b/.test(t) && !/\bZ-?\d/.test(t);
  });
  assert.equal(cornerArcs.length, 4,
    `expected 4 corner arcs on outermost lap (interior levels sharp), got ${cornerArcs.length}`);
  // Helix arcs: G3 with Z. 2 turns × 2 semicircles per turn = 4.
  const helices = gcode.split('\n').filter(l => /^G3\b.*\bZ-?\d/.test(l.trim()));
  assert.equal(helices.length, 4,
    `expected 4 helical semicircle arcs (2 turns × 2 halves), got ${helices.length}`);
  const worst = maxArcRadiusDelta(gcode);
  assert.ok(worst < GRBL_ARC_TOLERANCE_MM,
    `clearing arc radii should stay within grbl tolerance, got ${worst}`);
});

// ---------- Pattern (grid + circular) ----------
//
// Pattern replicates the same shape at multiple positions inside a
// single program. Header/spindle/coolant run once; each instance emits
// its own approach, plunge, cut, and safe-Z lift.
test('honeycomb: xCount × yCount = primary rows; shifted rows auto-insert between', () => {
  // 3×3 primary grid with 40mm pitch:
  //   Row 0 primary (y=0):    x = 0, 40, 80          → 3 items
  //   Shifted    (y=20):      x = 20, 60, 100        → 3 items
  //   Row 1 primary (y=40):   x = 0, 40, 80          → 3 items
  //   Shifted    (y=60):      x = 20, 60, 100        → 3 items
  //   Row 2 primary (y=80):   x = 0, 40, 80          → 3 items
  //   Total = 15.
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 5, cutType: 'inner', bitDiameter: 3,
    pattern: { enabled: true, style: 'honeycomb', xDist: 40, yDist: 40, xCount: 3, yCount: 3 }
  }));
  assert.match(gcode, /^\(QuickCut: Circle × 15\)/m);
  assert.match(gcode, /^\(Pattern: Honeycomb 3x3/m);
  // Primary row 0 at Y=0.
  assert.match(gcode, /\(Instance 1\/15 at X0\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 3\/15 at X80\.000 Y0\.000\)/);
  // First shifted row at Y=20, offset X.
  assert.match(gcode, /\(Instance 4\/15 at X20\.000 Y20\.000\)/);
  assert.match(gcode, /\(Instance 6\/15 at X100\.000 Y20\.000\)/);
  // Primary row 1 at Y=40.
  assert.match(gcode, /\(Instance 7\/15 at X0\.000 Y40\.000\)/);
  // Primary row 2 at Y=80.
  assert.match(gcode, /\(Instance 13\/15 at X0\.000 Y80\.000\)/);
});

test('honeycomb + Symmetric Ends: shifted rows have one less item; ends are always primary', () => {
  // 3×3 primary grid with hexTrim:
  //   Primary row 0 (y=0):  3 items
  //   Shifted    (y=20):    2 items (trim)
  //   Primary row 1 (y=40): 3 items
  //   Shifted    (y=60):    2 items (trim)
  //   Primary row 2 (y=80): 3 items
  //   Total = 3+2+3+2+3 = 13.
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 5, cutType: 'inner', bitDiameter: 3,
    pattern: {
      enabled: true, style: 'honeycomb', hexTrim: true,
      xDist: 40, yDist: 40, xCount: 3, yCount: 3
    }
  }));
  assert.match(gcode, /^\(QuickCut: Circle × 13\)/m);
  // Primary row 0.
  assert.match(gcode, /\(Instance 1\/13 at X0\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 3\/13 at X80\.000 Y0\.000\)/);
  // Shifted row (trimmed).
  assert.match(gcode, /\(Instance 4\/13 at X20\.000 Y20\.000\)/);
  assert.match(gcode, /\(Instance 5\/13 at X60\.000 Y20\.000\)/);
  // Primary row 1.
  assert.match(gcode, /\(Instance 6\/13 at X0\.000 Y40\.000\)/);
  // Ends on a primary row (top/bottom un-shifted).
  assert.match(gcode, /\(Instance 13\/13 at X80\.000 Y80\.000\)/);
});

test('linear 2×2 pattern emits 4 instances at correct offsets', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 20, height: 20, cornerRadius: 0, cutType: 'inner',
    bitDiameter: 3, depth: 1, depthOfCut: 1,
    origin: 'center',
    pattern: { enabled: true, style: 'linear', xDist: 50, yDist: 40, xCount: 2, yCount: 2 }
  }));
  // Header mentions pattern count + description
  assert.match(gcode, /^\(QuickCut: Rectangle × 4\)/m);
  assert.match(gcode, /^\(Pattern: Linear 2x2 \(dX=50, dY=40\)\)/m);
  // 4 instance comments, at (0,0) (50,0) (0,40) (50,40).
  assert.match(gcode, /\(Instance 1\/4 at X0\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 2\/4 at X50\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 3\/4 at X0\.000 Y40\.000\)/);
  assert.match(gcode, /\(Instance 4\/4 at X50\.000 Y40\.000\)/);
  // One M3 spindle-start line, not four.
  const spindleStarts = gcode.split('\n').filter(l => /^M3\b/.test(l.trim())).length;
  assert.equal(spindleStarts, 1, 'spindle should start once for the whole program');
  const spindleStops = gcode.split('\n').filter(l => /^M5\b/.test(l.trim())).length;
  assert.equal(spindleStops, 1, 'spindle should stop once at program end');
});

test('linear pattern with negative distance reverses direction', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 10, height: 10, cornerRadius: 0, cutType: 'inner',
    bitDiameter: 3, depth: 1, depthOfCut: 1, origin: 'center',
    pattern: { enabled: true, style: 'linear', xDist: -30, yDist: 20, xCount: 3, yCount: 1 }
  }));
  // Instances at (0,0), (-30, 0), (-60, 0).
  assert.match(gcode, /\(Instance 1\/3 at X0\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 2\/3 at X-30\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 3\/3 at X-60\.000 Y0\.000\)/);
});

test('circular (follow) pattern: instances rotate to match their position angle', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 20, height: 10, cornerRadius: 0, cutType: 'outer',
    origin: 'center', bitDiameter: 0, depth: 1, depthOfCut: 1,
    pattern: { enabled: true, style: 'circular-follow', count: 4, radius: 40, startAngle: 0 }
  }));
  assert.match(gcode, /\(Instance 1\/4 at X40\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 2\/4 at X0\.000 Y40\.000 rot=90\.000°\)/);
  assert.match(gcode, /Pattern: Circular \(Path Direction\) n=4 r=40 start=0°/);
});

test('circular pattern (no follow) leaves instances un-rotated', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 20, height: 10, cornerRadius: 0, cutType: 'outer',
    origin: 'center', bitDiameter: 0, depth: 1, depthOfCut: 1,
    pattern: { enabled: true, style: 'circular', count: 4, radius: 40, startAngle: 0 }
  }));
  // Instance comment should NOT include a rot=... suffix.
  assert.ok(!/Instance 2\/4[^)]*rot=/.test(gcode),
    'plain Circular must not rotate instances');
});

test('circular pattern places instances on the polar circle', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 6, height: 6, cornerRadius: 0, cutType: 'inner',
    bitDiameter: 2, depth: 1, depthOfCut: 1, origin: 'center',
    pattern: { enabled: true, style: 'circular', count: 4, radius: 40, startAngle: 0 }
  }));
  // 4 instances at 0°, 90°, 180°, 270° with radius 40.
  assert.match(gcode, /\(Instance 1\/4 at X40\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 2\/4 at X0\.000 Y40\.000\)/);
  assert.match(gcode, /\(Instance 3\/4 at X-40\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 4\/4 at X-?0\.000 Y-40\.000\)/);
});

test('pattern disabled → single instance (no pattern header, no instance comments)', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    pattern: { enabled: false, style: 'linear', xDist: 50, yDist: 50, xCount: 3, yCount: 3 }
  }));
  assert.ok(!/Pattern:/.test(gcode), 'no Pattern: header comment when disabled');
  assert.ok(!/Instance \d/.test(gcode), 'no instance comments when disabled');
});

test('pattern applies to clearing too — one helix per instance', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 30, height: 30, cornerRadius: 0, cutType: 'clearing',
    bitDiameter: 6, depth: 1, depthOfCut: 1, stepoverPct: 40,
    pattern: { enabled: true, style: 'linear', xDist: 60, yDist: 0, xCount: 2, yCount: 1 }
  }));
  // 2 instances × (descent 3mm / maxPitch 1.5 = 2 turns) × 2 semicircles = 8 helical arcs.
  const helices = gcode.split('\n').filter(l => /^G3\b.*\bZ-?\d/.test(l.trim())).length;
  assert.equal(helices, 8, `expected 8 helical semicircles (2 instances × 2 turns × 2 halves), got ${helices}`);
  // 2 instance comments.
  const instanceLines = gcode.split('\n').filter(l => /\(Instance \d+\/\d+/.test(l.trim())).length;
  assert.equal(instanceLines, 2, `expected 2 instance comments, got ${instanceLines}`);
});

// ---------- Circle ----------
//
// Circle perimeter: helical descent (semicircles per revolution) + final
// cleanup circle at target depth. Circle clearing: helical bore at
// center + expanding concentric rings.
function circleBase(overrides) {
  return Object.assign({
    diameter: 30,
    cutType: 'inner',
    origin: 'center',
    bitDiameter: 3, depth: 2, depthOfCut: 1,
    feedRate: 800, plungeFeedRate: 200,
    spindleRpm: 15000, spindleDelay: 1,
    mistM7: false, floodM8: false
  }, overrides || {});
}

test('circle perimeter emits helical descent + final cleanup circle', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 30, cutType: 'inner', bitDiameter: 3, depth: 2, depthOfCut: 1
  }));
  assert.match(gcode, /^\(QuickCut: Circle\)/m);
  // 2 depth passes × 2 semicircles per revolution = 4 descending arcs.
  // Plus 2 final cleanup semicircles = 6 total G3 arcs.
  const arcs = gcode.split('\n').filter(l => /^G3\b/.test(l.trim())).length;
  assert.equal(arcs, 6, `expected 6 G3 arcs (2 passes × 2 halves + 2 cleanup halves), got ${arcs}`);
  // Cleanup arcs have no Z coordinate.
  const cleanup = gcode.split('\n').filter(l => {
    const t = l.trim();
    return /^G3\b/.test(t) && !/\bZ-?\d/.test(t);
  }).length;
  assert.equal(cleanup, 2, `expected 2 cleanup semicircles, got ${cleanup}`);
});

test('circle inner cut shrinks path by bitRadius; outer grows it', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  // Inner: path radius = 30/2 - 3/2 = 13.5 → starts at (13.5, 0).
  const inner = gen(circleBase({ diameter: 30, cutType: 'inner', bitDiameter: 3 }));
  assert.match(inner, /G0 X13\.500 Y0\.000/);
  // Outer: path radius = 30/2 + 3/2 = 16.5 → starts at (16.5, 0).
  const outer = gen(circleBase({ diameter: 30, cutType: 'outer', bitDiameter: 3 }));
  assert.match(outer, /G0 X16\.500 Y0\.000/);
});

test('circle too small for tool warns and skips', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({ diameter: 2, cutType: 'inner', bitDiameter: 6 }));
  assert.match(gcode, /WARNING: circle smaller than tool diameter/);
  assert.ok(!/\bG3\b/.test(gcode), 'no arcs when nothing to cut');
});

test('circle arcs stay within grbl arc tolerance', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 40, cutType: 'outer', bitDiameter: 6, depth: 3, depthOfCut: 1
  }));
  const worst = maxArcRadiusDelta(gcode);
  assert.ok(worst < GRBL_ARC_TOLERANCE_MM,
    `circle arc radii should stay within grbl tolerance, got ${worst}`);
});

test('circle clearing emits helical bore + expanding concentric rings', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 50, cutType: 'clearing',
    bitDiameter: 6, depth: 1, depthOfCut: 1, stepoverPct: 40
  }));
  assert.match(gcode, /^\(QuickCut: Circle \(clearing\)\)/m);
  assert.match(gcode, /^\(Entry: helical bore then expanding outward\)/m);
  // Single depth pass — descent 3mm ÷ 1.5mm/turn = 2 turns → 4 helix arcs.
  const helices = gcode.split('\n').filter(l => /^G3\b.*\bZ-?\d/.test(l.trim())).length;
  assert.equal(helices, 4, `expected 4 helical semicircles, got ${helices}`);
  // Constant-Z ring arcs — pathRadius=22, step=2.4 → radii=[22,19.6,17.2,
  // 14.8,12.4,10.0,7.6,5.2,2.8] (stop when r<=toolRadius=3, so 2.8 pushed
  // then break). 9 rings × 2 semis = 18 constant-Z G3 arcs.
  const ringArcs = gcode.split('\n').filter(l => {
    const t = l.trim();
    return /^G3\b/.test(t) && !/\bZ-?\d/.test(t);
  }).length;
  assert.equal(ringArcs, 18, `expected 18 constant-Z ring semicircles (9 rings × 2 halves), got ${ringArcs}`);
});

test('circle pattern replicates the whole ring at each position', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 20, cutType: 'inner', bitDiameter: 3,
    pattern: { enabled: true, style: 'circular', count: 3, radius: 30, startAngle: 0 }
  }));
  assert.match(gcode, /^\(QuickCut: Circle × 3\)/m);
  // 3 circular instances at 0°, 120°, 240°.
  assert.match(gcode, /\(Instance 1\/3 at X30\.000 Y0\.000\)/);
  const spindleStarts = gcode.split('\n').filter(l => /^M3\b/.test(l.trim())).length;
  assert.equal(spindleStarts, 1, 'spindle starts once for the whole program');
});

// ---------- Planer ----------
function planerBase(overrides) {
  return Object.assign({
    width: 100, height: 80, overrun: 2, origin: 'front-left',
    pattern: 'zigzagY', stepoverPct: 40,
    depth: 2, depthOfCut: 1,
    bitDiameter: 6, feedRate: 1500, plungeFeedRate: 300,
    spindleRpm: 15000, spindleDelay: 1, mistM7: false, floodM8: false
  }, overrides || {});
}

test('planer zigzagY makes long strokes along Y with stepover in X', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({
    width: 100, height: 80, overrun: 0, pattern: 'zigzagY',
    bitDiameter: 6, stepoverPct: 50, depth: 1, depthOfCut: 1
  }));
  assert.match(gcode, /^\(QuickCut: Planer\)/m);
  assert.match(gcode, /^\(Pattern: zigzagY\)/m);
  // Long strokes end at Y=80 or Y=0 (start bottom-left = (0,0)). Should
  // see both endpoints from the alternating zigzag.
  assert.match(gcode, /G1 Y80\.000/);
  assert.match(gcode, /G1 Y0\.000/);
});

test('planer zigzagX makes long strokes along X with stepover in Y', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({
    width: 60, height: 40, overrun: 0, pattern: 'zigzagX',
    bitDiameter: 6, stepoverPct: 50, depth: 1, depthOfCut: 1
  }));
  assert.match(gcode, /G1 X60\.000/);
  assert.match(gcode, /G1 X0\.000/);
});

test('planer overrun extends the cut area past every edge', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({
    width: 40, height: 30, overrun: 5, origin: 'front-left',
    pattern: 'zigzagY', depth: 1, depthOfCut: 1
  }));
  // Start moved -5 in both X and Y from (0,0) → (-5, -5).
  assert.match(gcode, /G0 X-5\.000 Y-5\.000/);
  // Cut extends to -5 + (30 + 5*2) = 35 in Y — top of extended region.
  assert.match(gcode, /G1 Y35\.000/);
});

test('planer spiral pattern spirals outside-in', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({
    width: 20, height: 20, overrun: 0, pattern: 'spiral',
    bitDiameter: 6, stepoverPct: 50, depth: 1, depthOfCut: 1
  }));
  // First spiral move goes to bottom-right corner.
  assert.match(gcode, /G1 X20\.000 Y0\.000/);
});

test('planer multi-depth emits one plunge per pass', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({ depth: 3, depthOfCut: 1 }));
  const plunges = gcode.split('\n').filter(l => /^G1 Z-\d/.test(l.trim())).length;
  assert.equal(plunges, 3, `expected 3 depth plunges, got ${plunges}`);
});

test('planer thickness mode emits POSITIVE Z above wasteboard', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({
    mode: 'thickness', startingThickness: 20, depth: 3, depthOfCut: 1
  }));
  assert.match(gcode, /^\(Mode: Target Thickness\)/m);
  // 3 passes at Z=19, 18, 17 (thicknessStartZ - depth).
  assert.match(gcode, /G1 Z19\.000/);
  assert.match(gcode, /G1 Z18\.000/);
  assert.match(gcode, /G1 Z17\.000/);
  // No negative-Z cutting plunge in thickness mode.
  const negatives = gcode.split('\n').filter(l => /^G1 Z-\d/.test(l.trim())).length;
  assert.equal(negatives, 0, 'thickness mode should not emit negative-Z plunges');
});

test('planer thickness mode warns if target goes below wasteboard', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  const gcode = gen(planerBase({
    mode: 'thickness', startingThickness: 5, depth: 10, depthOfCut: 1
  }));
  assert.match(gcode, /WARNING: target thickness goes below wasteboard/);
});

test('planer wasteboard mode disables overrun and insets by bit radius', () => {
  const gen = makeQuickCutGenerator(false).generatePlanerProgram;
  // bit=6 → bitRadius=3. Machine=100×80 → tool center travels 3..97 in
  // X and 3..77 in Y so the cutter's outer edge stops at the machine
  // travel bounds (0..100 × 0..80).
  const gcode = gen(planerBase({
    mode: 'wasteboard', overrun: 10, width: 100, height: 80,
    origin: 'front-left', pattern: 'zigzagY', bitDiameter: 6
  }));
  assert.match(gcode, /^\(Mode: Wasteboard Surfacing\)/m);
  // First XY approach at (3, 3) — inset by bit radius, no overrun.
  assert.match(gcode, /G0 X3\.000 Y3\.000/);
  // Long-Y zigzag reaches Y=77 (80 - bit radius), not Y=80.
  assert.match(gcode, /G1 Y77\.000/);
  // Should NOT see Overrun in the header comments.
  assert.ok(!/^\(Overrun:/m.test(gcode), 'wasteboard mode should not emit an Overrun header line');
});

// ---------- Jointer ----------
function jointerBase(overrides) {
  return Object.assign({
    length: 150, trimWidth: 1, numTrims: 3,
    feedAxis: 'x', cutDirection: 'conventional', overrun: 0,
    origin: 'front',
    depth: 5, depthOfCut: 5,
    bitDiameter: 6, feedRate: 1000, plungeFeedRate: 250,
    spindleRpm: 15000, spindleDelay: 1, mistM7: false, floodM8: false
  }, overrides || {});
}

test('jointer conventional feeds +axis; climb feeds -axis (uses length param)', () => {
  const gen = makeQuickCutGenerator(false).generateJointerProgram;
  const conv = gen(jointerBase({
    length: 150, feedAxis: 'x', cutDirection: 'conventional',
    trimWidth: 1, numTrims: 3, origin: 'front'
  }));
  // Conventional: feed +X from 0 to length.
  assert.match(conv, /G0 X0\.000 Y0\.000/);
  assert.match(conv, /G1 X150\.000/);

  const climb = gen(jointerBase({
    length: 150, feedAxis: 'x', cutDirection: 'climb',
    trimWidth: 1, numTrims: 3, origin: 'front'
  }));
  // Climb: feed -X from length back to 0.
  assert.match(climb, /G0 X150\.000 Y0\.000/);
  assert.match(climb, /G1 X0\.000/);
});

test('jointer origin front vs back flips stepover direction (feed X)', () => {
  const gen = makeQuickCutGenerator(false).generateJointerProgram;
  // front → +Y stepover. Trims at Y=0, 1, 2.
  const front = gen(jointerBase({ feedAxis: 'x', origin: 'front', trimWidth: 1, numTrims: 3 }));
  assert.match(front, /G0 X0\.000 Y0\.000/);
  assert.match(front, /G0 X0\.000 Y1\.000/);
  assert.match(front, /G0 X0\.000 Y2\.000/);
  // back → -Y stepover. Trims at Y=0, -1, -2.
  const back = gen(jointerBase({ feedAxis: 'x', origin: 'back', trimWidth: 1, numTrims: 3 }));
  assert.match(back, /G0 X0\.000 Y-1\.000/);
  assert.match(back, /G0 X0\.000 Y-2\.000/);
});

test('jointer origin left vs right flips stepover direction (feed Y)', () => {
  const gen = makeQuickCutGenerator(false).generateJointerProgram;
  const left = gen(jointerBase({ feedAxis: 'y', origin: 'left', trimWidth: 1, numTrims: 3 }));
  assert.match(left, /G0 X0\.000 Y0\.000/);
  assert.match(left, /G0 X1\.000 Y0\.000/);
  const right = gen(jointerBase({ feedAxis: 'y', origin: 'right', trimWidth: 1, numTrims: 3 }));
  assert.match(right, /G0 X-1\.000 Y0\.000/);
});

test('jointer multi-depth × multi-trim: depth × numTrims plunges total', () => {
  const gen = makeQuickCutGenerator(false).generateJointerProgram;
  const gcode = gen(jointerBase({
    depth: 4, depthOfCut: 2, trimWidth: 1, numTrims: 3
  }));
  const plunges = gcode.split('\n').filter(l => /^G1 Z-\d/.test(l.trim())).length;
  assert.equal(plunges, 6, `expected 6 plunges (2 depths × 3 trims), got ${plunges}`);
});

// ---------- Cutter ----------
function cutterBase(overrides) {
  return Object.assign({
    axis: 'x', targetSize: 100, cuttingLength: 200,
    cutDirection: 'conventional', origin: 'front',
    depth: 5, depthOfCut: 5,
    bitDiameter: 6, feedRate: 1000, plungeFeedRate: 250,
    spindleRpm: 15000, spindleDelay: 1, mistM7: false, floodM8: false
  }, overrides || {});
}

test('cutter feed X: tool travels X, cut line on Y at target + bitRadius', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  // axis=X → feed along X. target=100, cuttingLength=200, bitRadius=3
  // Feed from X=0 to X=200. Cut line at Y = 100 + 3 = 103.
  const gcode = gen(cutterBase({
    axis: 'x', targetSize: 100, cuttingLength: 200, bitDiameter: 6,
    origin: 'front', depth: 5, depthOfCut: 5
  }));
  assert.match(gcode, /^\(QuickCut: Cutter\)/m);
  assert.match(gcode, /G0 X0\.000 Y103\.000/);
  assert.match(gcode, /G1 X200\.000 Y103\.000/);
});

test('cutter feed Y: tool travels Y, cut line on X at target + bitRadius', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  // axis=Y → feed along Y. target=80, cuttingLength=150.
  const gcode = gen(cutterBase({
    axis: 'y', origin: 'left', targetSize: 80, cuttingLength: 150, bitDiameter: 6
  }));
  assert.match(gcode, /G0 X83\.000 Y0\.000/);
  assert.match(gcode, /G1 X83\.000 Y150\.000/);
});

test('cutter origin back flips cut line to negative perpendicular', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  // axis=X, origin=back → cut line at Y = -(target + bitRadius).
  const gcode = gen(cutterBase({
    axis: 'x', origin: 'back', targetSize: 50, cuttingLength: 100, bitDiameter: 6
  }));
  assert.match(gcode, /G0 X0\.000 Y-53\.000/);
  assert.match(gcode, /G1 X100\.000 Y-53\.000/);
});

test('cutter multi-pass depth repeats the same cut line deeper', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  const gcode = gen(cutterBase({
    depth: 6, depthOfCut: 2, axis: 'x', targetSize: 100, cuttingLength: 200
  }));
  const plunges = gcode.split('\n').filter(l => /^G1 Z-\d/.test(l.trim())).length;
  assert.equal(plunges, 3, `expected 3 plunges, got ${plunges}`);
  const cutLines = gcode.split('\n').filter(l => /^G1 X200\.000 Y103\.000/.test(l.trim())).length;
  assert.equal(cutLines, 3, `expected 3 identical cut lines, got ${cutLines}`);
});

test('cutter climb reverses feed direction on feed axis', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  const gcode = gen(cutterBase({
    axis: 'x', cutDirection: 'climb', origin: 'front',
    targetSize: 100, cuttingLength: 200
  }));
  // Climb: feed from X=200 back to X=0.
  assert.match(gcode, /G0 X200\.000 Y103\.000/);
  assert.match(gcode, /G1 X0\.000 Y103\.000/);
});

// ---------- Degenerate case ----------
test('shape smaller than tool diameter warns and produces no cut', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 4, height: 4, cornerRadius: 0, cutType: 'inner',
    bitDiameter: 10 // way bigger than the shape
  }));
  assert.match(gcode, /WARNING: shape smaller than tool diameter/);
  assert.ok(!/\bG1 X.*Y/.test(gcode), 'should emit no cutting moves');
});

// ============================================================
// POLYGON
// ============================================================

function polygonBase(overrides) {
  return Object.assign({
    sides: 6, radius: 20, cutType: 'outer', origin: 'center',
    bitDiameter: 0, depth: 5, depthOfCut: 5,
    feedRate: 800, plungeFeedRate: 200,
    spindleRpm: 15000, spindleDelay: 1,
    mistM7: false, floodM8: false
  }, overrides || {});
}

function countG1XY(gcode) {
  return gcode.split('\n').filter(l => /^G1\s+X.*Y/.test(l.trim())).length;
}

test('polygon: emits N G1 vertex moves per depth pass (hexagon → 6 per pass)', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, depth: 5, depthOfCut: 5 })); // 1 pass
  assert.equal(countG1XY(gcode), 6, 'hexagon = 6 vertex G1s in one pass');
});

test('polygon: sides count reflects in output for triangle and dodecagon', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const tri = gen(polygonBase({ sides: 3, depth: 5, depthOfCut: 5 }));
  const dodec = gen(polygonBase({ sides: 12, depth: 5, depthOfCut: 5 }));
  assert.equal(countG1XY(tri), 3);
  assert.equal(countG1XY(dodec), 12);
  assert.match(tri, /Polygon \(3-sided\)/);
  assert.match(dodec, /Polygon \(12-sided\)/);
});

test('polygon: multi-pass depth repeats vertex loop', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  // 3 passes × 6 vertices = 18 vertex moves
  const gcode = gen(polygonBase({ sides: 6, depth: 6, depthOfCut: 2 }));
  assert.equal(countG1XY(gcode), 18);
});

test('polygon: hexagon with bitDiameter=0 has vertices on the circumscribed circle', () => {
  // No bit compensation → path radius = input radius. First vertex sits
  // at angle (π/n - π/2) = 0 for n=6 → (R, 0) offset around center. But
  // origin=center puts polygon centered on 0,0, and startAngle for n=6
  // is -60° so first vertex is at (R·cos(-60°), R·sin(-60°)) = (10, -17.32).
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, radius: 20, cutType: 'outer', bitDiameter: 0 }));
  assert.match(gcode, /G0 X10\.000 Y-17\.32[01]/);
});

test('polygon: inner cut shrinks the path by bitRadius/cos(π/n)', () => {
  // Hexagon R=20, bit dia=3.175 → tool r=1.5875. cos(π/6)=0.866.
  // apothem shrinks by tool r: 17.3205 - 1.5875 = 15.733.
  // path R = 15.733 / 0.866 = 18.167.
  // First vertex angle -60°: (18.167·0.5, 18.167·-0.866) = (9.083, -15.733).
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, radius: 20, cutType: 'inner', bitDiameter: 3.175 }));
  assert.match(gcode, /G0 X9\.083 Y-15\.7[23]/);
});

test('polygon: outer cut grows the path by bitRadius/cos(π/n)', () => {
  // Same math but +: apothem 17.3205 + 1.5875 = 18.908, path R = 21.833.
  // First vertex: (21.833·0.5, 21.833·-0.866) = (10.917, -18.908).
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, radius: 20, cutType: 'outer', bitDiameter: 3.175 }));
  assert.match(gcode, /G0 X10\.917 Y-18\.90[78]/);
});

test('polygon: origin=front-left pins finished polygon front-left corner to (0,0)', () => {
  // Hexagon R=20 flat-top: actual bbox is 40 × 34.64 (not 40 × 40 — sin
  // extremes only reach ±0.866R). front-left of that bbox = (-20, -17.32)
  // in polygon-local coords, so polygon center in machine = (20, 17.32).
  // First vertex (angle -60°): center + (10, -17.32) = (30, 0).
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, radius: 20, origin: 'front-left', bitDiameter: 0 }));
  assert.match(gcode, /G0 X30\.000 Y0\.000/);
});

test('polygon: shape smaller than tool warns and emits no cut', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, radius: 2, cutType: 'inner', bitDiameter: 10 }));
  assert.match(gcode, /WARNING: polygon smaller than tool diameter/);
  assert.equal(countG1XY(gcode), 0);
});

test('polygon: startAngleDeg=90 rotates the polygon by +90°', () => {
  // Hexagon with 0° start angle: first vertex at (10, -17.321).
  // With +90° rotation, first vertex rotates 90° CCW: (17.321, 10).
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 6, radius: 20, startAngleDeg: 90, cutType: 'outer', bitDiameter: 0 }));
  assert.match(gcode, /G0 X17\.32[01] Y10\.000/);
});

test('polygon: pattern (linear 2x2) emits 4 instances', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({
    sides: 6, radius: 10, depth: 5, depthOfCut: 5, bitDiameter: 0,
    pattern: { enabled: true, style: 'linear', xDist: 30, yDist: 30, xCount: 2, yCount: 2 }
  }));
  // 4 instances × 6 vertices each = 24 G1 vertex moves
  assert.equal(countG1XY(gcode), 24);
  assert.match(gcode, /Instance 1\/4/);
  assert.match(gcode, /Instance 4\/4/);
});

test('polygon: clearing emits concentric shrinking polygons', () => {
  // Hexagon R=10 (dia 20), bit dia=3, stepover 50% → step = 1.5.
  // apothem = 10 * cos(π/6) = 8.66; outer path apothem = 8.66 - 1.5 = 7.16.
  // Rings step inward by 1.5 apothem each until ≤ toolRadius (1.5).
  // So apo passes: 7.16, 5.66, 4.16, 2.66, 1.16 → 5 rings.
  // Each ring closes 6 vertices → 30 G1 vertex moves.
  // Plus 4 "between-ring" G1 hops (5 rings, first has no hop) — 4 extra G1s.
  // Total G1 with X and Y = 30 + 4 = 34.
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({
    sides: 6, radius: 10, cutType: 'clearing', bitDiameter: 3,
    stepoverPct: 50, depth: 5, depthOfCut: 5
  }));
  assert.match(gcode, /Polygon \(6-sided, clearing\)/);
  assert.match(gcode, /Stepover: 50%/);
  const g1Count = countG1XY(gcode);
  assert.ok(g1Count >= 30 && g1Count <= 40, `expected ~34 G1 XY moves, got ${g1Count}`);
});

test('polygon: closes back to first vertex (last G1 equals first G0)', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({ sides: 5, radius: 15, cutType: 'outer', bitDiameter: 0 }));
  const lines = gcode.split('\n').map(l => l.trim());
  const firstG0 = lines.find(l => /^G0 X-?\d/.test(l));
  const g1xy = lines.filter(l => /^G1 X-?\d.*Y-?\d/.test(l));
  const lastG1 = g1xy[g1xy.length - 1];
  const xy = s => {
    const x = parseFloat(s.match(/X(-?\d+\.?\d*)/)[1]);
    const y = parseFloat(s.match(/Y(-?\d+\.?\d*)/)[1]);
    return [x, y];
  };
  const [fx, fy] = xy(firstG0);
  const [lx, ly] = xy(lastG1);
  assert.ok(Math.abs(fx - lx) < 1e-3 && Math.abs(fy - ly) < 1e-3,
    `perimeter should close: first (${fx},${fy}) vs last (${lx},${ly})`);
});
