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

  assert.match(gcode, /^\(QuickCut: Rectangle \[clearing\]\)/m);
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
  // Origin=center anchors the WHOLE pattern's aggregate bbox center at
  // (0,0), so instance coordinates are shifted by (-50, -40) — the
  // negative of the aggregate bbox center for this 100×80 spread.
  assert.match(gcode, /\(Instance 1\/15 at X-50\.000 Y-40\.000\)/);
  assert.match(gcode, /\(Instance 3\/15 at X30\.000 Y-40\.000\)/);
  assert.match(gcode, /\(Instance 4\/15 at X-30\.000 Y-20\.000\)/);
  assert.match(gcode, /\(Instance 6\/15 at X50\.000 Y-20\.000\)/);
  assert.match(gcode, /\(Instance 7\/15 at X-50\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 13\/15 at X-50\.000 Y40\.000\)/);
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
  // Aggregate bbox is 80×80 (Symmetric Ends trims to 80 wide); center
  // shift = (-40, -40).
  assert.match(gcode, /\(Instance 1\/13 at X-40\.000 Y-40\.000\)/);
  assert.match(gcode, /\(Instance 3\/13 at X40\.000 Y-40\.000\)/);
  assert.match(gcode, /\(Instance 4\/13 at X-20\.000 Y-20\.000\)/);
  assert.match(gcode, /\(Instance 5\/13 at X20\.000 Y-20\.000\)/);
  assert.match(gcode, /\(Instance 6\/13 at X-40\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 13\/13 at X40\.000 Y40\.000\)/);
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
  assert.match(gcode, /^\(Pattern: Linear 2x2 \[dX=50, dY=40\]\)/m);
  // origin=center anchors the pattern's aggregate bbox (2×2 rects with
  // dX=50 dY=40, W=H=20) center at (0,0). Center shift = (-25, -20).
  assert.match(gcode, /\(Instance 1\/4 at X-25\.000 Y-20\.000\)/);
  assert.match(gcode, /\(Instance 2\/4 at X25\.000 Y-20\.000\)/);
  assert.match(gcode, /\(Instance 3\/4 at X-25\.000 Y20\.000\)/);
  assert.match(gcode, /\(Instance 4\/4 at X25\.000 Y20\.000\)/);
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
  // Raw positions (0,0),(-30,0),(-60,0). Aggregate bbox center = (-30,0);
  // origin=center shifts by (+30, 0).
  assert.match(gcode, /\(Instance 1\/3 at X30\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 2\/3 at X0\.000 Y0\.000\)/);
  assert.match(gcode, /\(Instance 3\/3 at X-30\.000 Y0\.000\)/);
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
  assert.match(gcode, /Pattern: Circular \[Path Direction\] n=4 r=40 start=0°/);
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

// ---------- Pattern angle ----------
//
// Linear/Honeycomb accept an angle: xDist becomes the center-to-center
// step ALONG the angled row and yDist the step across it.
function instanceCenters(gcode) {
  return [...gcode.matchAll(/\(Instance \d+\/\d+ at X(-?[\d.]+) Y(-?[\d.]+)/g)]
    .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
}

test('pattern angle 0 is identical to no angle', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const pattern = { enabled: true, style: 'linear', xDist: 50, yDist: 40, xCount: 2, yCount: 2 };
  const plain = gen(baseParams({ origin: 'back-left', pattern }));
  const zero = gen(baseParams({ origin: 'back-left', pattern: Object.assign({ angle: 0, rotateShapes: true }, pattern) }));
  assert.equal(zero, plain);
});

test('linear pattern at 36° puts centers on a 36° line, xDist apart', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 10,
    pattern: { enabled: true, style: 'linear', xDist: 40, yDist: 0, xCount: 3, yCount: 1, angle: 36 }
  }));
  assert.match(gcode, /^\(Pattern: Linear 3x1 \[dX=40, dY=0\] angle=36°\)/m);
  const c = instanceCenters(gcode);
  assert.equal(c.length, 3);
  for (let i = 1; i < c.length; i++) {
    const dx = c[i].x - c[i - 1].x, dy = c[i].y - c[i - 1].y;
    assert.ok(Math.abs(Math.hypot(dx, dy) - 40) < 0.002, `step ${i} length ${Math.hypot(dx, dy)}`);
    assert.ok(Math.abs(Math.atan2(dy, dx) * 180 / Math.PI - 36) < 0.01, `step ${i} angle`);
  }
  // origin=center: middle instance lands on (0, 0).
  assert.ok(Math.abs(c[1].x) < 0.001 && Math.abs(c[1].y) < 0.001);
});

test('linear pattern at 90° matches the old Y-column layout', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const angled = gen(circleBase({
    diameter: 10, origin: 'front-left',
    pattern: { enabled: true, style: 'linear', xDist: 30, yDist: 0, xCount: 3, yCount: 1, angle: 90 }
  }));
  const column = gen(circleBase({
    diameter: 10, origin: 'front-left',
    pattern: { enabled: true, style: 'linear', xDist: 0, yDist: 30, xCount: 1, yCount: 3 }
  }));
  assert.deepEqual(
    instanceCenters(angled).map(p => [p.x, p.y]),
    instanceCenters(column).map(p => [Math.abs(p.x), p.y])
  );
});

test('honeycomb at an angle rotates the shifted rows too', () => {
  const gen = makeQuickCutGenerator(false).generateCircleProgram;
  const gcode = gen(circleBase({
    diameter: 5, bitDiameter: 3,
    pattern: { enabled: true, style: 'honeycomb', xDist: 40, yDist: 40, xCount: 2, yCount: 2, angle: 90 }
  }));
  // Local (0,0),(40,0) | shifted (20,20),(60,20) | (0,40),(40,40),
  // rotated 90° → x = -v, y = u. Shifted item 3 sits 20 left of row 0.
  const c = instanceCenters(gcode);
  assert.equal(c.length, 6);
  assert.ok(Math.abs((c[2].x - c[0].x) - (-20)) < 0.001);
  assert.ok(Math.abs((c[2].y - c[0].y) - 20) < 0.001);
});

test('rotateShapes turns each rectangle with the row; arcs stay in tolerance', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const params = {
    width: 20, height: 10, cornerRadius: 3, cutType: 'outer', bitDiameter: 3,
    depth: 1, depthOfCut: 1, origin: 'back-left'
  };
  const rotated = gen(baseParams(Object.assign({}, params, {
    pattern: { enabled: true, style: 'linear', xDist: 40, yDist: 0, xCount: 3, yCount: 1, angle: 36, rotateShapes: true }
  })));
  assert.match(rotated, /angle=36° rotated/);
  assert.match(rotated, /\(Instance 2\/3 at X\S+ Y\S+ rot=36\.000°\)/);
  assert.ok(maxArcRadiusDelta(rotated) < GRBL_ARC_TOLERANCE_MM);

  const plain = gen(baseParams(Object.assign({}, params, {
    pattern: { enabled: true, style: 'linear', xDist: 40, yDist: 0, xCount: 3, yCount: 1, angle: 36 }
  })));
  assert.ok(!/rot=/.test(plain), 'rotateShapes off must not rotate instances');
});

test('rotated instances anchor origin on their rotated extents', () => {
  // A single 20×10 rect rotated 90° is 10 wide × 20 tall, so with
  // origin=front-left its center sits at (5, 10), not (10, 5).
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const gcode = gen(baseParams({
    width: 20, height: 10, cutType: 'outer', bitDiameter: 0, depth: 1, depthOfCut: 1,
    origin: 'front-left',
    pattern: { enabled: true, style: 'linear', xDist: 40, yDist: 0, xCount: 2, yCount: 1, angle: 90, rotateShapes: true }
  }));
  assert.match(gcode, /\(Instance 1\/2 at X5\.000 Y10\.000 rot=90\.000°\)/);
  assert.match(gcode, /\(Instance 2\/2 at X5\.000 Y50\.000 rot=90\.000°\)/);
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
  assert.match(gcode, /^\(QuickCut: Circle \[clearing\]\)/m);
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
  // Circular ring positions (30,0), (-15, 25.98), (-15, -25.98) with
  // D=20 circles. Aggregate bbox center = (7.5, 0); origin=center shifts
  // by (-7.5, 0). First instance = (22.5, 0).
  assert.match(gcode, /\(Instance 1\/3 at X22\.500 Y-?0\.000\)/);
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

test('jointer front edge: conventional feeds +X, climb -X (uses length param)', () => {
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
  // back → -Y stepover. Trims at Y=0, -1, -2; conventional runs -X.
  const back = gen(jointerBase({ feedAxis: 'x', origin: 'back', trimWidth: 1, numTrims: 3 }));
  assert.match(back, /G0 X150\.000 Y-1\.000/);
  assert.match(back, /G0 X150\.000 Y-2\.000/);
});

test('jointer origin left vs right flips stepover direction (feed Y)', () => {
  const gen = makeQuickCutGenerator(false).generateJointerProgram;
  // Left: material at +X, so conventional runs -Y.
  const left = gen(jointerBase({ feedAxis: 'y', origin: 'left', trimWidth: 1, numTrims: 3 }));
  assert.match(left, /G0 X0\.000 Y150\.000/);
  assert.match(left, /G0 X1\.000 Y150\.000/);
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
  // Cut line at Y = 100 + 3 = 103. The kept piece (Y 0..100) is on the
  // bit's -Y side, so conventional feeds -X: from X=200 to X=0.
  const gcode = gen(cutterBase({
    axis: 'x', targetSize: 100, cuttingLength: 200, bitDiameter: 6,
    origin: 'front', depth: 5, depthOfCut: 5
  }));
  assert.match(gcode, /^\(QuickCut: Cutter\)/m);
  assert.match(gcode, /G0 X200\.000 Y103\.000/);
  assert.match(gcode, /G1 X0\.000 Y103\.000/);
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
  const cutLines = gcode.split('\n').filter(l => /^G1 X0\.000 Y103\.000/.test(l.trim())).length;
  assert.equal(cutLines, 3, `expected 3 identical cut lines, got ${cutLines}`);
});

test('cutter climb reverses feed direction on feed axis', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  const gcode = gen(cutterBase({
    axis: 'x', cutDirection: 'climb', origin: 'front',
    targetSize: 100, cuttingLength: 200
  }));
  // Climb at a front origin: feed +X, from X=0 to X=200.
  assert.match(gcode, /G0 X0\.000 Y103\.000/);
  assert.match(gcode, /G1 X200\.000 Y103\.000/);
});

// With the spindle clockwise from above (M3), a cut is conventional when
// the material is on the left of the bit's travel (each tooth's chip
// starts thin; G42 with M3) and climb when it's on the right (G41). For
// material in direction m, the conventional feed is (m.y, -m.x).
function feedVector(gcode) {
  const cut = gcode.split('\n').map(l => l.trim());
  const i = cut.findIndex(l => /^G1 X/.test(l));
  const to = cut[i].match(/X(-?[\d.]+) Y(-?[\d.]+)/).slice(1).map(Number);
  const from = cut.slice(0, i).reverse().find(l => /^G0 X/.test(l)).match(/X(-?[\d.]+) Y(-?[\d.]+)/).slice(1).map(Number);
  return [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])];
}
const FACING = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };
function expectedFeed(materialDir, cutDirection) {
  const s = cutDirection === 'conventional' ? 1 : -1;
  return [s * materialDir[1] || 0, -s * materialDir[0] || 0];
}

test('jointer cut direction matches the spindle rotation on every side', () => {
  const gen = makeQuickCutGenerator(false).generateJointerProgram;
  for (const [axis, sides] of [['x', ['front', 'back']], ['y', ['left', 'right']]]) {
    for (const origin of sides) for (const cutDirection of ['conventional', 'climb']) {
      // The trimmed edge faces `origin`; the material is the other way.
      const material = FACING[origin].map(v => -v);
      const got = feedVector(gen(jointerBase({ feedAxis: axis, origin, cutDirection })));
      assert.deepEqual(got, expectedFeed(material, cutDirection), `${axis} ${origin} ${cutDirection}`);
    }
  }
});

test('cutter cut direction matches the spindle rotation for the kept edge', () => {
  const gen = makeQuickCutGenerator(false).generateCutterProgram;
  for (const [axis, sides] of [['x', ['front', 'back']], ['y', ['left', 'right']]]) {
    for (const origin of sides) for (const cutDirection of ['conventional', 'climb']) {
      // The kept piece runs from the origin edge to the cut, so it's on
      // the origin side of the bit.
      const kept = FACING[origin];
      const got = feedVector(gen(cutterBase({ axis, origin, cutDirection })));
      assert.deepEqual(got, expectedFeed(kept, cutDirection), `${axis} ${origin} ${cutDirection}`);
    }
  }
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
  assert.match(tri, /Polygon \[3-sided\]/);
  assert.match(dodec, /Polygon \[12-sided\]/);
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

test('polygon clearing: pattern (linear 2x2) emits 4 instances', () => {
  const gen = makeQuickCutGenerator(false).generatePolygonProgram;
  const gcode = gen(polygonBase({
    sides: 6, radius: 8, cutType: 'clearing', bitDiameter: 3, stepoverPct: 50,
    depth: 5, depthOfCut: 5,
    pattern: { enabled: true, style: 'linear', xDist: 25, yDist: 25, xCount: 2, yCount: 2 }
  }));
  assert.match(gcode, /Polygon \[6-sided, clearing\] × 4/);
  assert.match(gcode, /Instance 1\/4/);
  assert.match(gcode, /Instance 4\/4/);
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
  assert.match(gcode, /Polygon \[6-sided, clearing\]/);
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

// ---------- Imperial: G0/G1 moves that start an arc keep 5 decimals ----------
// A circle 0.187" with a 1/16" bit put the rapid at X0.125 (3 decimals) while
// the arcs used radius 0.12475: 0.00025" (0.006 mm) apart -> error:33.
test('imperial circle: arc start matches the move before it (reported case)', () => {
  const gcode = makeQuickCutGenerator(true).generateCircleProgram(circleBase({
    diameter: 0.187, cutType: 'outer', bitDiameter: 0.0625,
    depth: 0.25, depthOfCut: 0.03, feedRate: 20, plungeFeedRate: 10
  }));
  assert.match(gcode, /^G0 X0\.12475 Y0\.00000$/m);
  assert.ok(maxArcRadiusDelta(gcode) < GRBL_ARC_TOLERANCE_INCH);
});

test('imperial circle clearing, circles and rounded rectangles stay within grbl arc tolerance', () => {
  const g = makeQuickCutGenerator(true);
  for (const gcode of [
    g.generateCircleClearingProgram(circleBase({ diameter: 0.937, cutType: 'inner', bitDiameter: 0.0625, depth: 0.1, depthOfCut: 0.05 })),
    g.generateCircleProgram(circleBase({ diameter: 1.313, cutType: 'inner', bitDiameter: 0.125, depth: 0.1, depthOfCut: 0.05 })),
    g.generateRectangleProgram(baseParams({ width: 2.187, height: 1.313, cornerRadius: 0.187, cutType: 'inner', bitDiameter: 0.0625, depth: 0.1, depthOfCut: 0.05, feedRate: 30, plungeFeedRate: 5 })),
  ]) {
    const worst = maxArcRadiusDelta(gcode);
    assert.ok(worst < GRBL_ARC_TOLERANCE_INCH, `arc radius mismatch ${worst} in`);
  }
});

// ---------- Comments must not nest ----------
// A G-code comment ends at the first ')'. "(Origin (start side): left)" left
// ": left)" as G-code: error:1, and the job stopped on line 5.
const nestedComment = /\([^)]*\(/;

for (const origin of ['left', 'right', 'front', 'back']) {
  test(`cutter program has no nested comments (origin ${origin})`, () => {
    const gcode = makeQuickCutGenerator(false).generateCutterProgram(
      cutterBase({ axis: origin === 'left' || origin === 'right' ? 'y' : 'x', origin }));
    for (const line of gcode.split('\n')) assert.doesNotMatch(line, nestedComment, line);
    assert.match(gcode, /^\(Origin \[start side\]: /m);
  });
}

test('header comments turn any parentheses into brackets', () => {
  const lines = makeQuickCutGenerator(false).programHeader(
    { bitDiameter: 6, feedRate: 1000, spindleRpm: 15000, cutType: 'outside (profile)' },
    { shapeLabel: 'Test (shape)', extraComments: ['a (b (c)) d'] });
  for (const line of lines) assert.doesNotMatch(line, nestedComment, line);
  assert.ok(lines.includes('(a [b [c]] d)'));
  assert.ok(lines.includes('(QuickCut: Test [shape])'));
});

// ---------- Each pass plunges only its own step ----------
// Every pass used to rapid to 2 mm above the surface and plunge slowly all
// the way down, through material earlier passes had already removed.
function approachHeights(gcode) {
  // The G0 Z right before each slow plunge (G1 Z... with the plunge feed).
  const lines = gcode.split('\n'), out = [];
  for (let i = 1; i < lines.length; i++)
    if (/^G1 Z-?[\d.]+ F250\b/.test(lines[i]) && /^G0 Z/.test(lines[i - 1]))
      out.push(Number(lines[i - 1].slice(4)));
  return out;
}

test('cutter: each pass rapids to 2 mm above the previous pass floor', () => {
  const gcode = makeQuickCutGenerator(false).generateCutterProgram(
    cutterBase({ depth: 6, depthOfCut: 2 }));
  assert.deepEqual(approachHeights(gcode), [2, 0, -2]);
  assert.match(gcode, /^G1 Z-6\.000 F250/m);
});

test('cutter imperial: the 2 mm clearance is in inches', () => {
  const gcode = makeQuickCutGenerator(true).generateCutterProgram(
    cutterBase({ depth: 0.3, depthOfCut: 0.1 }));
  const h = approachHeights(gcode);
  assert.equal(h.length, 3);
  assert.ok(Math.abs(h[0] - 0.079) < 1e-3 && Math.abs(h[1] - (0.079 - 0.1)) < 1e-3, String(h));
});

// ---------- Keyhole ----------
//
// Single plunge at the hole, forward along the slot, retrace to the
// hole, retract there. X0 Y0 is the (first) plunge hole.
function keyholeBase(overrides) {
  return Object.assign({
    bitDiameter: 9.5, slotLength: 10, startAngleDeg: 90, depth: 8,
    feedRate: 600, plungeFeedRate: 150,
    spindleRpm: 18000, spindleDelay: 1,
    mistM7: false, floodM8: false
  }, overrides || {});
}

// Motion lines after the startup block, as [cmd, x, y, z] with modal X/Y.
function keyholeMoves(gcode) {
  let pos = { x: null, y: null };
  const out = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!/^G[01]\b/.test(line) || /^G53/.test(line)) continue;
    const z = line.match(/Z(-?[\d.]+)/);
    pos = parseXY(line, pos);
    out.push({ cmd: line.slice(0, 2), x: pos.x, y: pos.y, z: z ? parseFloat(z[1]) : null, xy: /[XY]/.test(line) });
  }
  return out;
}

test('keyhole: single plunge, slot out, retrace, retract at the hole', () => {
  const gcode = makeQuickCutGenerator(false).generateKeyholeProgram(keyholeBase());
  const lines = gcode.split('\n').map(l => l.trim());
  const plunges = lines.filter(l => /^G1 Z-/.test(l));
  assert.deepEqual(plunges, ['G1 Z-8.000 F150']);
  const i = lines.indexOf('G1 Z-8.000 F150');
  assert.equal(lines[i + 1], 'G1 X0.000 Y10.000 F600');
  assert.equal(lines[i + 2], 'G1 X0.000 Y0.000 ; Retrace to plunge hole');
  assert.equal(lines[i + 3], 'G0 Z5.000');
  assert.match(gcode, /\(Origin: plunge hole center\)/);
});

test('keyhole: slot follows startAngleDeg', () => {
  const gcode = makeQuickCutGenerator(false).generateKeyholeProgram(keyholeBase({ startAngleDeg: 30, slotLength: 20 }));
  const m = gcode.match(/^G1 X(-?[\d.]+) Y(-?[\d.]+) F600$/m);
  assert.ok(Math.abs(parseFloat(m[1]) - 20 * Math.cos(Math.PI / 6)) < 0.001);
  assert.ok(Math.abs(parseFloat(m[2]) - 10) < 0.001);
});

test('keyhole pattern: first hole at X0 Y0, every retract at its own hole', () => {
  const gcode = makeQuickCutGenerator(false).generateKeyholeProgram(keyholeBase({
    origin: 'hole',
    pattern: { enabled: true, style: 'linear', xDist: 50, yDist: 0, xCount: 3, yCount: 1, angle: 36 }
  }));
  assert.match(gcode, /\(Instance 1\/3 at X0\.000 Y0\.000\)/);
  const moves = keyholeMoves(gcode);
  const plunges = moves.filter(m => m.cmd === 'G1' && m.z !== null && m.z < 0);
  assert.equal(plunges.length, 3);
  // Retract (G0 Z after a cut) always happens where that instance plunged.
  for (let k = 0; k < moves.length; k++) {
    if (moves[k].cmd === 'G1' && moves[k].z !== null && moves[k].z < 0) {
      const hole = moves[k];
      const retract = moves.slice(k).find(m => m.cmd === 'G0' && m.z !== null);
      assert.equal(retract.x, hole.x);
      assert.equal(retract.y, hole.y);
    }
  }
  // Holes 50 apart along 36°.
  const dx = plunges[1].x - plunges[0].x, dy = plunges[1].y - plunges[0].y;
  assert.ok(Math.abs(Math.hypot(dx, dy) - 50) < 0.002);
  assert.ok(Math.abs(Math.atan2(dy, dx) * 180 / Math.PI - 36) < 0.01);
});

test('keyhole pattern rotation turns each slot', () => {
  const gen = makeQuickCutGenerator(false).generateKeyholeProgram;
  const circ = gen(keyholeBase({
    startAngleDeg: 0, slotLength: 10,
    pattern: { enabled: true, style: 'circular-follow', count: 4, radius: 40, startAngle: 0 }
  }));
  // Instance 2 sits at 90°, so its slot points +Y from (0, 40).
  assert.match(circ, /\(Instance 2\/4 at X0\.000 Y40\.000 rot=90\.000°\)\nG0 X0\.000 Y40\.000\n[\s\S]*?G1 X-?0\.000 Y50\.000 F600/);

  const row = gen(keyholeBase({
    startAngleDeg: 90, slotLength: 10,
    pattern: { enabled: true, style: 'linear', xDist: 30, yDist: 0, xCount: 2, yCount: 1, angle: 36, rotateShapes: true }
  }));
  const ends = [...row.matchAll(/^G1 X(-?[\d.]+) Y(-?[\d.]+) F600$/mg)];
  // First slot: 10 at 90°+36° from the origin.
  assert.ok(Math.abs(parseFloat(ends[0][1]) - 10 * Math.cos(126 * Math.PI / 180)) < 0.001);
  assert.ok(Math.abs(parseFloat(ends[0][2]) - 10 * Math.sin(126 * Math.PI / 180)) < 0.001);
});

test('keyhole imperial scales clearance heights to inches', () => {
  const gcode = makeQuickCutGenerator(true).generateKeyholeProgram(keyholeBase({ slotLength: 0.5, depth: 0.375 }));
  assert.match(gcode, /^G20\b/m);
  assert.match(gcode, /^G0 Z0\.197$/m);
  assert.match(gcode, /^G0 Z0\.079$/m);
  assert.match(gcode, /^G1 Z-0\.375 F150$/m);
});

test('keyhole with zero slot length warns and cuts nothing', () => {
  const gcode = makeQuickCutGenerator(false).generateKeyholeProgram(keyholeBase({ slotLength: 0 }));
  assert.match(gcode, /WARNING/);
  assert.ok(!/^G1 /m.test(gcode));
});

// Regression: Circular (Path Direction) turns each copy, so the pattern's
// outer boundary must use each copy's rotated footprint. The old anchor
// used the unrotated 20×10 size for every copy, so with origin=front-left
// the 90°-turned bottom copy (20 tall) overhung Y0 by 5 mm.
test('circular-follow with a corner origin keeps every cut inside the origin corner', () => {
  const gen = makeQuickCutGenerator(false).generateRectangleProgram;
  const extents = (gcode) => {
    const pts = [...gcode.matchAll(/^G1 X(-?[\d.]+) Y(-?[\d.]+)/mg)].map(m => [+m[1], +m[2]]);
    return {
      minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])),
      minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1]))
    };
  };
  const params = (origin) => baseParams({
    width: 20, height: 10, cornerRadius: 0, cutType: 'outer', bitDiameter: 0,
    depth: 1, depthOfCut: 1, origin,
    pattern: { enabled: true, style: 'circular-follow', count: 4, radius: 40, startAngle: 0 }
  });
  const fl = extents(gen(params('front-left')));
  assert.ok(Math.abs(fl.minX) < 0.001 && Math.abs(fl.minY) < 0.001, JSON.stringify(fl));
  assert.ok(Math.abs(fl.maxY - 100) < 0.001, JSON.stringify(fl));
  const br = extents(gen(params('back-right')));
  assert.ok(Math.abs(br.maxX) < 0.001 && Math.abs(br.maxY) < 0.001, JSON.stringify(br));
});

// ---------- Holding tabs ----------

// Walk the program and return every cutting move as { z, len, inTab },
// where len is the XY length (arcs measured along the arc) and inTab
// marks moves between a "; Tab" lift and the drop back down.
function cutPieces(gcode) {
  let pos = { x: 0, y: 0 }, z = null, inTab = false;
  const out = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!/^G[0123]\b/.test(line) || /^G53/.test(line)) continue;
    const zm = line.match(/Z(-?[\d.]+)/);
    if (zm) { z = parseFloat(zm[1]); inTab = /; Tab/.test(raw); }
    if (/^G[23]\b/.test(line)) {
      const a = parseArc(line);
      const cx = pos.x + a.i, cy = pos.y + a.j;
      let sweep = Math.atan2(a.endY - cy, a.endX - cx) - Math.atan2(pos.y - cy, pos.x - cx);
      if (sweep <= 1e-9) sweep += 2 * Math.PI;
      out.push({ z, len: Math.hypot(a.i, a.j) * sweep, inTab });
      pos = { x: a.endX, y: a.endY };
      continue;
    }
    const next = parseXY(line, pos);
    if (line.startsWith('G1')) out.push({ z, len: Math.hypot(next.x - pos.x, next.y - pos.y), inTab });
    pos = next;
  }
  return out;
}

const tabSpan = (gcode) => cutPieces(gcode).filter(q => q.inTab).reduce((s, q) => s + q.len, 0);

const TABS = { count: 4, width: 5, height: 2 };

for (const [name, gen, extra] of [
  ['rectangle', 'generateRectangleProgram', { width: 60, height: 40 }],
  ['rounded rectangle', 'generateRectangleProgram', { width: 60, height: 40, cornerRadius: 10 }],
  ['circle', 'generateCircleProgram', { diameter: 50 }],
  ['polygon', 'generatePolygonProgram', { diameter: 50, sides: 6 }]
]) {
  test(`tabs on a ${name}: final passes lift over each tab for tab width + bit`, () => {
    const g = makeQuickCutGenerator(false);
    const p = baseParams(Object.assign({ depth: 6, depthOfCut: 2.5, tabs: TABS }, extra));
    const gcode = g[gen](p);
    assert.match(gcode, /\(Tabs: 4 x 5mm wide, 2mm high\)/);
    assert.ok(maxArcRadiusDelta(gcode) < GRBL_ARC_TOLERANCE_MM, 'arcs stay consistent');
    // Passes reach 4 (the tab top) untabbed; the 5 and 6 passes are tabbed.
    // A tab across the start point lifts twice (start and end of the lap).
    const lifts = (gcode.match(/; Tab$/mg) || []).length;
    assert.ok(lifts === 2 * TABS.count || lifts === 2 * (TABS.count + 1), String(lifts));
    for (const q of cutPieces(gcode)) {
      if (q.inTab) assert.equal(q.z, -4);
    }
    assert.ok(cutPieces(gcode).some(q => q.z === -6 && !q.inTab));
    const expected = 2 * TABS.count * (TABS.width + p.bitDiameter);
    assert.ok(Math.abs(tabSpan(gcode) - expected) < 0.01, `${tabSpan(gcode)} vs ${expected}`);
  });
}

test('tabs off, or on a clearing cut, leave the program unchanged', () => {
  const g = makeQuickCutGenerator(false);
  for (const [gen, extra] of [
    ['generateRectangleProgram', { cornerRadius: 5 }],
    ['generateCircleProgram', { diameter: 40 }],
    ['generatePolygonProgram', { diameter: 40, sides: 5 }]
  ]) {
    const p = baseParams(extra);
    const plain = g[gen](p);
    assert.equal(g[gen](Object.assign({}, p, { tabs: null })), plain);
    assert.equal(g[gen](Object.assign({}, p, { tabs: Object.assign({}, TABS, { height: 5 }) })), plain,
      'tab height ≥ depth is ignored');
    const clearing = Object.assign({}, p, { cutType: 'clearing' });
    assert.equal(g[gen](Object.assign({}, clearing, { tabs: TABS })), g[gen](clearing));
  }
});

test('rotated rectangle tabs follow the shape', () => {
  const g = makeQuickCutGenerator(false);
  const p = baseParams({
    width: 60, height: 40, cornerRadius: 6, depth: 3, depthOfCut: 3, tabs: TABS,
    pattern: { enabled: true, style: 'linear', xCount: 2, yCount: 1, xDist: 100, angle: 33, rotateShapes: true }
  });
  const gcode = g.generateRectangleProgram(p);
  assert.ok(maxArcRadiusDelta(gcode) < GRBL_ARC_TOLERANCE_MM);
  assert.equal((gcode.match(/; Tab$/mg) || []).length, 2 * (TABS.count + 1), 'bottom tab spans the start');
  const span = tabSpan(gcode);
  assert.ok(Math.abs(span - 2 * TABS.count * (TABS.width + p.bitDiameter)) < 0.01, String(span));
});

test('circle tabs: helix stops at the tab top, deeper passes plunge at the start', () => {
  const g = makeQuickCutGenerator(false);
  const gcode = g.generateCircleProgram(baseParams({ diameter: 50, depth: 6, depthOfCut: 2.5, tabs: TABS }));
  const helixZ = [...gcode.matchAll(/^G3 .* Z(-?[\d.]+) F/mg)].map(m => +m[1]);
  assert.equal(Math.min(...helixZ), -4);
  assert.match(gcode, /^G1 Z-5\.000 F200$/m);
  assert.match(gcode, /^G1 Z-6\.000 F200$/m);
});

test('tabs too wide for the path warn and are dropped', () => {
  const g = makeQuickCutGenerator(false);
  const some = g.generateCircleProgram(baseParams({ diameter: 20, depth: 3, tabs: { count: 8, width: 6, height: 1 } }));
  assert.match(some, /WARNING: only \d of 8 tabs fit/);
  const none = g.generateCircleProgram(baseParams({ diameter: 10, depth: 3, cutType: 'inner', tabs: { count: 2, width: 20, height: 1 } }));
  assert.match(none, /WARNING: tabs too wide/);
  assert.doesNotMatch(none, /; Tab/);
});

test('imperial tabs use inch Z values', () => {
  const g = makeQuickCutGenerator(true);
  const gcode = g.generateRectangleProgram(baseParams({
    width: 3, height: 2, bitDiameter: 0.25, depth: 0.75, depthOfCut: 0.25,
    feedRate: 60, plungeFeedRate: 20, tabs: { count: 4, width: 0.25, height: 0.125 }
  }));
  assert.match(gcode, /^G1 Z-0\.625 F20 ; Tab$/m);
  assert.ok(maxArcRadiusDelta(gcode) < GRBL_ARC_TOLERANCE_INCH);
});

// ---------- Drill ----------

function drillBase(overrides) {
  return Object.assign({
    bitDiameter: 5, depth: 10, peckDepth: 0, peckMode: 'clear', dwell: 0,
    feedRate: 600, plungeFeedRate: 150,
    spindleRpm: 18000, spindleDelay: 1,
    mistM7: false, floodM8: false
  }, overrides || {});
}

test('drill without peck: one plunge per hole, then retract', () => {
  const gcode = makeQuickCutGenerator(false).generateDrillProgram(drillBase());
  const z = keyholeMoves(gcode).filter(m => m.z != null).map(m => m.cmd + m.z);
  assert.deepEqual(z, ['G05', 'G02', 'G1-10', 'G05']);
  assert.match(gcode, /\(Peck: none\)/);
});

test('drill full-retract peck clears chips and re-enters just above the bottom', () => {
  const gcode = makeQuickCutGenerator(false).generateDrillProgram(drillBase({ peckDepth: 4 }));
  const z = keyholeMoves(gcode).filter(m => m.z != null).map(m => m.cmd + m.z);
  assert.deepEqual(z, ['G05', 'G02', 'G1-4', 'G02', 'G0-3.5', 'G1-8', 'G02', 'G0-7.5', 'G1-10', 'G05']);
});

test('drill short-retract peck only backs off to break the chip', () => {
  const gcode = makeQuickCutGenerator(false).generateDrillProgram(drillBase({ peckDepth: 4, peckMode: 'break', dwell: 0.5 }));
  const z = keyholeMoves(gcode).filter(m => m.z != null).map(m => m.cmd + m.z);
  assert.deepEqual(z, ['G05', 'G02', 'G1-4', 'G0-3.5', 'G1-8', 'G0-7.5', 'G1-10', 'G05']);
  assert.match(gcode, /^G1 Z-10\.000 F150\nG4 P0\.5 ; Dwell\nG0 Z5\.000$/m);
});

test('drill pattern: origin anchors the box around all the holes, as on Circle', () => {
  const g = makeQuickCutGenerator(false);
  const params = (origin) => drillBase({
    origin, pattern: { enabled: true, style: 'linear', xCount: 3, yCount: 1, xDist: 32, angle: 90 }
  });
  const holes = (gcode) => [...gcode.matchAll(/^G0 X(-?[\d.]+) Y(-?[\d.]+)$/mg)].map(m => [+m[1], +m[2]]);
  // A row along +Y, 32 apart. Center (the default) is the middle hole.
  assert.deepEqual(holes(g.generateDrillProgram(params())), [[0, -32], [0, 0], [0, 32]]);
  assert.match(g.generateDrillProgram(params()), /\(Origin: center\)/);
  // Front-left is the corner of the holes' box, a hole radius (2.5) out.
  assert.deepEqual(holes(g.generateDrillProgram(params('front-left'))), [[2.5, 2.5], [2.5, 34.5], [2.5, 66.5]]);
  assert.equal((g.generateDrillProgram(params()).match(/^G1 Z-10\.000/mg) || []).length, 3);
});

test('drill origin on a picked hole: column/row for grids, copy number for circular', () => {
  const g = makeQuickCutGenerator(false);
  const holes = (gcode) => [...gcode.matchAll(/^G0 X(-?[\d.]+) Y(-?[\d.]+)$/mg)].map(m => [+m[1], +m[2]]);
  const grid = (xCount, origin) => drillBase({
    origin, pattern: { enabled: true, style: 'linear', xCount, yCount: 2, xDist: 10, yDist: 20 }
  });
  // Column 2, row 2 of a 3 x 2 grid becomes X0 Y0.
  const gcode = g.generateDrillProgram(grid(3, 'hole:2,2'));
  assert.deepEqual(holes(gcode), [[-10, -20], [0, -20], [10, -20], [-10, 0], [0, 0], [10, 0]]);
  assert.match(gcode, /\(Origin: hole at column 2, row 2\)/);
  // Adding a column keeps the same hole as the origin.
  assert.deepEqual(holes(g.generateDrillProgram(grid(4, 'hole:2,2')))[5], [0, 0]);
  // A hole the pattern no longer has falls back to center.
  const gone = g.generateDrillProgram(grid(3, 'hole:5,1'));
  assert.match(gone, /\(Origin: center \[picked hole not in pattern\]\)/);
  assert.deepEqual(holes(gone), holes(g.generateDrillProgram(grid(3, 'center'))));
  // Circular: hole 3 of 4 (at 180 degrees) is X0 Y0.
  const circ = g.generateDrillProgram(drillBase({
    origin: 'hole:3', pattern: { enabled: true, style: 'circular', count: 4, radius: 50 }
  }));
  assert.deepEqual(holes(circ)[2], [0, 0]);
  assert.deepEqual(holes(circ)[0], [100, 0]);
  assert.match(circ, /\(Origin: hole 3\)/);
});

test('extent spacing spreads copies evenly from first to last center', () => {
  const g = makeQuickCutGenerator(false);
  const xs = (p) => g.computePatternPositions(p).map(q => +q.x.toFixed(6));
  // 5 copies over 400: 100 apart, last one at 400.
  const ext = { enabled: true, style: 'linear', xCount: 5, yCount: 1, xDist: 400, yDist: 0, spacing: 'extent' };
  assert.deepEqual(xs(ext), [0, 100, 200, 300, 400]);
  // Same positions as spacing mode with 100.
  assert.deepEqual(g.computePatternPositions(ext),
    g.computePatternPositions(Object.assign({}, ext, { xDist: 100, spacing: 'spacing' })));
  // Y extent too, at an angle: the far corner is the extent along / across the row.
  const ang = { enabled: true, style: 'linear', xCount: 3, yCount: 3, xDist: 60, yDist: 40, angle: 90, spacing: 'extent' };
  const last = g.computePatternPositions(ang).pop();
  assert.ok(Math.abs(last.x - -40) < 1e-9 && Math.abs(last.y - 60) < 1e-9, JSON.stringify(last));
  // A count of 1 has no spacing.
  assert.deepEqual(xs(Object.assign({}, ext, { xCount: 1 })), [0]);
  // Honeycomb: the extent covers the primary rows.
  const honey = { enabled: true, style: 'honeycomb', xCount: 3, yCount: 3, xDist: 80, yDist: 60, spacing: 'extent' };
  const pts = g.computePatternPositions(honey);
  // Main (unshifted) rows run 0..80; the shifted rows overhang by half
  // a spacing unless Symmetric Ends trims them.
  assert.equal(Math.max(...pts.filter(q => q.y % 30 === 0).map(q => q.x)), 80);
  assert.equal(Math.max(...pts.map(q => q.y)), 60);
  assert.deepEqual(pts, g.computePatternPositions(Object.assign({}, honey, { xDist: 40, yDist: 30, spacing: 'spacing' })));
  assert.ok(pts.some(q => q.x === 20 && q.y === 15), 'shifted row at half the worked-out spacing');
});

test('extent pattern header gives the extent and the spacing it works out to', () => {
  const gcode = makeQuickCutGenerator(false).generateDrillProgram(drillBase({
    pattern: { enabled: true, style: 'linear', xCount: 4, yCount: 2, xDist: 100, yDist: 25, spacing: 'extent' }
  }));
  assert.match(gcode, /\(Pattern: Linear 4x2 \[extent X=100, Y=25; dX=33\.3333, dY=25\]\)/);
  assert.equal((gcode.match(/^\(Hole \d+\/8 /mg) || []).length, 8);
});

test('circular Total Angle: full circle unchanged, partial arc ends on both ends, negative is clockwise', () => {
  const g = makeQuickCutGenerator(false);
  const degs = (p) => g.computePatternPositions(p).map(q => +(Math.atan2(q.y, q.x) * 180 / Math.PI).toFixed(6));
  const base = { enabled: true, style: 'circular', count: 5, radius: 50, startAngle: 0 };
  // Missing, 360 and the old behaviour all match.
  assert.deepEqual(g.computePatternPositions(Object.assign({}, base, { totalAngle: 360 })), g.computePatternPositions(base));
  assert.deepEqual(degs(base), [0, 72, 144, -144, -72]);
  // 5 copies over 90: 22.5 apart, the last on 90.
  assert.deepEqual(degs(Object.assign({}, base, { totalAngle: 90 })), [0, 22.5, 45, 67.5, 90]);
  // Negative: clockwise from the start.
  assert.deepEqual(degs(Object.assign({}, base, { startAngle: 90, totalAngle: -90 })), [90, 67.5, 45, 22.5, 0]);
  // -360: full circle, clockwise.
  assert.deepEqual(degs(Object.assign({}, base, { totalAngle: -360 })), [0, -72, -144, 144, 72]);
  // Path Direction turns each copy to its own angle on the arc.
  const follow = g.computePatternPositions(Object.assign({}, base, { style: 'circular-follow', totalAngle: 180, count: 3 }));
  assert.deepEqual(follow.map(q => q.rotDeg), [0, 90, 180]);
});

test('Path Direction: the first copy is unturned whatever the Start Angle', () => {
  const g = makeQuickCutGenerator(false);
  const rots = (startAngle) => g.computePatternPositions({ enabled: true, style: 'circular-follow', count: 4, radius: 30, startAngle })
    .map(q => +q.rotDeg.toFixed(6));
  assert.deepEqual(rots(0), [0, 90, 180, 270]);
  assert.deepEqual(rots(90), [0, 90, 180, 270]);
  // The positions still start at the Start Angle.
  const first = g.computePatternPositions({ enabled: true, style: 'circular-follow', count: 4, radius: 30, startAngle: 90 })[0];
  assert.ok(Math.abs(first.x) < 1e-9 && Math.abs(first.y - 30) < 1e-9);
});

test('circular Total Angle shows in the header only when it is not 360', () => {
  const g = makeQuickCutGenerator(false);
  const pat = (t) => drillBase({ pattern: { enabled: true, style: 'circular', count: 4, radius: 30, startAngle: 10, totalAngle: t } });
  assert.match(g.generateDrillProgram(pat(120)), /\(Pattern: Circular \[Identical\] n=4 r=30 start=10° total=120°\)/);
  assert.match(g.generateDrillProgram(pat(360)), /\(Pattern: Circular \[Identical\] n=4 r=30 start=10°\)/);
});

test('rectangle Start Angle turns the cut about its center; 0 is unchanged', () => {
  const g = makeQuickCutGenerator(false);
  const xy = (gcode) => [...gcode.matchAll(/^G[0123] X(-?[\d.]+) Y(-?[\d.]+)/mg)].map(m => [+m[1], +m[2]]);
  const ext = (pts) => [Math.max(...pts.map(q => Math.abs(q[0]))), Math.max(...pts.map(q => Math.abs(q[1])))];
  for (const cutType of ['outer', 'inner', 'clearing']) {
    const base = baseParams({ width: 50, height: 30, cornerRadius: 0, cutType, bitDiameter: 6 });
    assert.equal(g.generateRectangleProgram(Object.assign({}, base, { startAngleDeg: 0 })), g.generateRectangleProgram(base), cutType);
    // At 90 the 50-wide side runs along Y: the extents swap.
    const [ex, ey] = ext(xy(g.generateRectangleProgram(base)));
    const [rx, ry] = ext(xy(g.generateRectangleProgram(Object.assign({}, base, { startAngleDeg: 90 }))));
    assert.ok(Math.abs(rx - ey) < 1e-3 && Math.abs(ry - ex) < 1e-3, cutType + ' ' + [ex, ey, rx, ry]);
  }
  const turned = g.generateRectangleProgram(baseParams({ width: 50, height: 30, cutType: 'outer', bitDiameter: 6, startAngleDeg: 30 }));
  assert.match(turned, /\(Corner Radius: 0mm, Start Angle: 30°\)/);
  // Front-left origin anchors the turned part's box (the part's own
  // corners), so the Outer tool path's square corner, 3 out on each
  // side, pokes past it by the difference of the two turned boxes.
  const fl = xy(g.generateRectangleProgram(baseParams({ width: 50, height: 30, cutType: 'outer', bitDiameter: 6, startAngleDeg: 30, origin: 'front-left' })));
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  const poke = (28 * c30 + 18 * s30) - (25 * c30 + 15 * s30);
  assert.ok(Math.abs(Math.min(...fl.map(q => q[0])) + poke) < 2e-3, String(Math.min(...fl.map(q => q[0]))));
});

test('polygon Corner Radius: arcs about the core polygon, offset by the bit; 0 is unchanged', () => {
  const g = makeQuickCutGenerator(false);
  const base = (o) => baseParams(Object.assign({ sides: 6, diameter: 60, startAngleDeg: 0, cutType: 'outer', bitDiameter: 6, depth: 4, depthOfCut: 2 }, o));
  const xy = (gcode) => [...gcode.matchAll(/^G[0123] X(-?[\d.]+) Y(-?[\d.]+)/mg)].map(m => [+m[1], +m[2]]);
  const arcR = (gcode) => [...gcode.matchAll(/^G3 X-?[\d.]+ Y-?[\d.]+ I(-?[\d.]+) J(-?[\d.]+)/mg)].map(m => +Math.hypot(+m[1], +m[2]).toFixed(3));
  for (const cutType of ['outer', 'inner', 'clearing']) {
    assert.equal(g.generatePolygonProgram(base({ cutType, cornerRadius: 0 })), g.generatePolygonProgram(base({ cutType })), cutType);
  }
  // Outer, radius 5, bit 3 radius: every corner arc is 8; one per corner per pass.
  const outer = g.generatePolygonProgram(base({ cornerRadius: 5 }));
  assert.match(outer, /\(Start Angle: 0°, Corner Radius: 5mm\)/);
  const radii = arcR(outer);
  assert.equal(radii.length, 6 * 2);
  assert.ok(radii.every(r => Math.abs(r - 8) < 2e-3), radii.join(','));
  // The tool stays a bit radius outside the part's box: front-left origin puts it at -3.
  // (Arcs are sampled: a corner's extreme point is partway round it.)
  const traced = (gcode) => {
    const pts = []; let x = 0, y = 0;
    for (const m of gcode.matchAll(/^(G[0123]) X(-?[\d.]+) Y(-?[\d.]+)(?: I(-?[\d.]+) J(-?[\d.]+))?/mg)) {
      const ex = +m[2], ey = +m[3];
      if (m[1] === 'G3') {
        const cx = x + +m[4], cy = y + +m[5], r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ey - cy, ex - cx);
        if (a1 <= a0) a1 += 2 * Math.PI;
        for (let k = 0; k <= 32; k++) { const a = a0 + (a1 - a0) * k / 32; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      } else pts.push([ex, ey]);
      x = ex; y = ey;
    }
    return pts;
  };
  const fl = traced(g.generatePolygonProgram(base({ cornerRadius: 5, origin: 'front-left' })));
  assert.ok(Math.abs(Math.min(...fl.map(q => q[0])) + 3) < 2e-3, String(Math.min(...fl.map(q => q[0]))));
  assert.ok(Math.abs(Math.min(...fl.map(q => q[1])) + 3) < 2e-3, String(Math.min(...fl.map(q => q[1]))));
  // Inner with a corner no bigger than the bit's radius: the sharp path.
  const sharp = g.generatePolygonProgram(base({ cutType: 'inner', cornerRadius: 2 }));
  assert.equal(arcR(sharp).length, 0);
  assert.deepEqual(xy(sharp), xy(g.generatePolygonProgram(base({ cutType: 'inner' }))));
  // Inner with a bigger corner: arcs of corner - bit radius.
  assert.ok(arcR(g.generatePolygonProgram(base({ cutType: 'inner', cornerRadius: 7 }))).every(r => Math.abs(r - 4) < 2e-3));
  // Clearing: the outer ring is rounded (radius 7 - 3), the inner rings sharp; ends lifted.
  const clr = g.generatePolygonProgram(base({ cutType: 'clearing', cornerRadius: 7, stepoverPct: 40 }));
  assert.ok(arcR(clr).length > 0 && arcR(clr).every(r => r <= 4 + 2e-3), arcR(clr).join(','));
  assert.ok(!/NaN/.test(clr));
  assert.match(clr.trim(), /M30/);
  // Tabs follow the rounded path.
  const tabbed = g.generatePolygonProgram(base({ cornerRadius: 5, tabs: { count: 3, width: 4, height: 2 } }));
  assert.equal((tabbed.match(/; Tab$/mg) || []).length, 3);
  assert.ok(!/NaN/.test(tabbed));
});

test('inner corners tighter than the bit say what the bit leaves, outer ones do not', () => {
  const g = makeQuickCutGenerator(false);
  const rect = (o) => g.generateRectangleProgram(baseParams(Object.assign({ width: 50, height: 30, bitDiameter: 6.35 }, o)));
  assert.match(rect({ cutType: 'inner', cornerRadius: 2 }), /\(Corner Radius: 2mm \[the bit leaves 3\.175mm\]\)/);
  assert.match(rect({ cutType: 'clearing', cornerRadius: 0 }), /\(Corner Radius: 0mm \[the bit leaves 3\.175mm\]\)/);
  assert.match(rect({ cutType: 'inner', cornerRadius: 5 }), /\(Corner Radius: 5mm\)/);
  assert.match(rect({ cutType: 'outer', cornerRadius: 0 }), /\(Corner Radius: 0mm\)/);
  const poly = (o) => g.generatePolygonProgram(baseParams(Object.assign({ sides: 6, diameter: 60, bitDiameter: 6.35 }, o)));
  assert.match(poly({ cutType: 'inner' }), /\(Start Angle: 0°, Corner Radius: 0mm \[the bit leaves 3\.175mm\]\)/);
  assert.match(poly({ cutType: 'outer' }), /\(Start Angle: 0°\)/);
  // The cut itself doesn't change.
  const strip = (t) => t.split('\n').filter(l => !/^\(/.test(l)).join('\n');
  assert.equal(strip(rect({ cutType: 'inner', cornerRadius: 2 })), strip(rect({ cutType: 'inner', cornerRadius: 0 })));
});

test('origin on a picked corner or the polygon center', () => {
  const g = makeQuickCutGenerator(false);
  const xy = (gcode) => [...gcode.matchAll(/^G[0123] X(-?[\d.]+) Y(-?[\d.]+)/mg)].map(m => [+m[1], +m[2]]);
  // Rectangle 50 x 30, Outer, bit 6: corner 1 (front-left) at X0 Y0 puts
  // the tool path's corner 3 out on both axes, like the front-left dot.
  const rect = (o) => g.generateRectangleProgram(baseParams(Object.assign({ width: 50, height: 30, cutType: 'outer', bitDiameter: 6 }, o)));
  assert.deepEqual(xy(rect({ origin: 'corner:1' })), xy(rect({ origin: 'front-left' })));
  assert.match(rect({ origin: 'corner:3' }), /\(Origin: corner 3\)/);
  assert.deepEqual(xy(rect({ origin: 'corner:3' })), xy(rect({ origin: 'back-right' })));
  // Turned 90: corner 1 (was front-left) is now at the front-right of the box.
  const turned = xy(rect({ origin: 'corner:1', startAngleDeg: 90 }));
  assert.ok(Math.abs(Math.max(...turned.map(q => q[0])) - 3) < 1e-3 && Math.abs(Math.min(...turned.map(q => q[1])) + 3) < 1e-3, JSON.stringify(turned.slice(0, 3)));
  // Polygon: a triangle's own center is not its box center.
  const tri = (o) => g.generatePolygonProgram(baseParams(Object.assign({ sides: 3, diameter: 40, cutType: 'outer', bitDiameter: 2 }, o)));
  assert.match(tri({ origin: 'shape-center' }), /\(Origin: shape center\)/);
  assert.notDeepEqual(xy(tri({ origin: 'shape-center' })), xy(tri({ origin: 'center' })));
  // Shape center: the vertices sit on a circle about X0 Y0 (path radius).
  const pts = xy(tri({ origin: 'shape-center' })).slice(0, 4);
  const r = pts.map(q => Math.hypot(q[0], q[1]));
  assert.ok(r.every(v => Math.abs(v - r[0]) < 1e-3), r.join(','));
  // Corner 2 of the triangle (the top one, at 90 degrees) is at X0 Y0: the
  // sharp outer path's matching vertex is straight above it.
  const c2 = xy(tri({ origin: 'corner:2' }));
  assert.ok(c2.some(q => Math.abs(q[0]) < 1e-3 && q[1] > 0), JSON.stringify(c2.slice(0, 4)));
  // A corner the shape doesn't have falls back to center.
  assert.match(tri({ origin: 'corner:5' }), /\(Origin: center \[picked corner not on shape\]\)/);
  assert.deepEqual(xy(tri({ origin: 'corner:5' })), xy(tri({ origin: 'center' })));
});

test('origin inset: the cut moves inward from a corner or edge origin, never for center or a picked point', () => {
  const g = makeQuickCutGenerator(false);
  const xy = (gcode) => [...gcode.matchAll(/^G[0123] X(-?[\d.]+) Y(-?[\d.]+)/mg)].map(m => [+m[1], +m[2]]);
  const ext = (pts) => ({ minX: Math.min(...pts.map(q => q[0])), maxX: Math.max(...pts.map(q => q[0])), minY: Math.min(...pts.map(q => q[1])), maxY: Math.max(...pts.map(q => q[1])) });
  const rect = (o) => g.generateRectangleProgram(baseParams(Object.assign({ width: 50, height: 30, cutType: 'outer', bitDiameter: 6 }, o)));
  // Inset 0 is today's output.
  for (const origin of ['front-left', 'center', 'back-center']) {
    assert.equal(rect({ origin, inset: 0 }), rect({ origin }), origin);
  }
  // Front-left, inset 10: the part's box starts at X10 Y10, so the outer
  // tool path (3 out) starts at 7.
  let e = ext(xy(rect({ origin: 'front-left', inset: 10 })));
  assert.ok(Math.abs(e.minX - 7) < 1e-3 && Math.abs(e.minY - 7) < 1e-3, JSON.stringify(e));
  assert.match(rect({ origin: 'front-left', inset: 10 }), /\(Origin: front-left, inset 10mm\)/);
  // Back-right: inward is -X and -Y.
  e = ext(xy(rect({ origin: 'back-right', inset: 10 })));
  assert.ok(Math.abs(e.maxX + 7) < 1e-3 && Math.abs(e.maxY + 7) < 1e-3, JSON.stringify(e));
  // Front-center: only Y moves; X stays centred.
  e = ext(xy(rect({ origin: 'front-center', inset: 10 })));
  assert.ok(Math.abs(e.minX + 28) < 1e-3 && Math.abs(e.maxX - 28) < 1e-3 && Math.abs(e.minY - 7) < 1e-3, JSON.stringify(e));
  // Left-center: only X.
  e = ext(xy(rect({ origin: 'left-center', inset: 10 })));
  assert.ok(Math.abs(e.minX - 7) < 1e-3 && Math.abs(e.minY + 18) < 1e-3, JSON.stringify(e));
  // Center and a picked corner ignore it (and say nothing about it).
  assert.equal(rect({ origin: 'center', inset: 10 }), rect({ origin: 'center' }));
  assert.equal(rect({ origin: 'corner:1', inset: 10 }), rect({ origin: 'corner:1' }));
  // Juice groove: 300 x 200 board, groove 10 in from the edges = a 280 x 180
  // Inner (perimeter) groove centreline box... with a 6 mm bit, Inner keeps
  // the tool 3 inside: path from X13 Y13.
  e = ext(xy(rect({ width: 280, height: 180, cutType: 'inner', origin: 'front-left', inset: 10 })));
  assert.ok(Math.abs(e.minX - 13) < 1e-3 && Math.abs(e.maxX - 287) < 1e-3, JSON.stringify(e));
});

test('origin inset on Circle, Polygon, Drill and Keyhole', () => {
  const g = makeQuickCutGenerator(false);
  const xy = (gcode) => [...gcode.matchAll(/^G[0123] X(-?[\d.]+) Y(-?[\d.]+)/mg)].map(m => [+m[1], +m[2]]);
  // Circle D25 outer, bit 6 (path radius 15.5), back-right inset 5: centre
  // at (-17.5, -17.5); the start point (rightmost) at X -2.
  const circ = g.generateCircleProgram(baseParams({ diameter: 25, cutType: 'outer', bitDiameter: 6, origin: 'back-right', inset: 5 }));
  assert.ok(xy(circ).some(q => Math.abs(q[0] + 2) < 1e-3 && Math.abs(q[1] + 17.5) < 1e-3), JSON.stringify(xy(circ).slice(0, 4)));
  assert.match(circ, /\(Origin: back-right, inset 5mm\)/);
  // Polygon box shifts the same way as with no inset, plus the inset.
  const poly = (o) => xy(g.generatePolygonProgram(baseParams(Object.assign({ sides: 6, diameter: 40, cutType: 'outer', bitDiameter: 2, origin: 'front-left' }, o))));
  const a = poly({}), b = poly({ inset: 4 });
  assert.ok(a.every((q, i) => Math.abs(b[i][0] - q[0] - 4) < 1e-3 && Math.abs(b[i][1] - q[1] - 4) < 1e-3));
  // Drill: first hole a bit radius plus the inset in from X0 Y0.
  const drill = g.generateDrillProgram(drillBase({ origin: 'front-left', inset: 4, pattern: { enabled: true, style: 'linear', xCount: 2, yCount: 2, xDist: 20, yDist: 20 } }));
  assert.match(drill, /^G0 X6\.500 Y6\.500$/m);
  assert.match(drill, /\(Origin: front-left, inset 4mm\)/);
  // A picked hole ignores it.
  const picked = drillBase({ origin: 'hole:1,1', pattern: { enabled: true, style: 'linear', xCount: 2, yCount: 2, xDist: 20, yDist: 20 } });
  assert.equal(g.generateDrillProgram(Object.assign({}, picked, { inset: 4 })), g.generateDrillProgram(picked));
  // Keyhole: box origins take it, the plunge hole doesn't.
  const key = (o) => g.generateKeyholeProgram(Object.assign({ bitDiameter: 10, slotLength: 20, startAngleDeg: 90, depth: 8, feedRate: 300, plungeFeedRate: 100, spindleRpm: 1, spindleDelay: 0 }, o));
  assert.equal(key({ origin: 'hole', inset: 5 }), key({ origin: 'hole' }));
  assert.match(key({ origin: 'front-left', inset: 5 }), /^G0 X10\.000 Y10\.000$/m);
});

test('pattern position keys follow cutting order, honeycomb shifted rows are even rows', () => {
  const g = makeQuickCutGenerator(false);
  const honey = { enabled: true, style: 'honeycomb', xCount: 3, yCount: 2, xDist: 10, yDist: 10, hexTrim: true };
  assert.deepEqual(g.patternPositionKeys(honey), ['1,1', '2,1', '3,1', '1,2', '2,2', '1,3', '2,3', '3,3']);
  assert.equal(g.patternPositionKeys(honey).length, g.computePatternPositions(honey).length);
  assert.deepEqual(g.patternPositionKeys({ enabled: false }), ['1,1']);
});

test('a single drill hole at the center origin is at X0 Y0', () => {
  const gcode = makeQuickCutGenerator(false).generateDrillProgram(drillBase());
  assert.match(gcode, /^G0 X0\.000 Y0\.000$/m);
});

test('drill imperial scales clearance and back-off to inches', () => {
  const gcode = makeQuickCutGenerator(true).generateDrillProgram(drillBase({ depth: 0.5, peckDepth: 0.2, plungeFeedRate: 10 }));
  assert.match(gcode, /^G20\b/m);
  assert.match(gcode, /^G0 Z0\.079 ; Clear chips$/m);
  assert.match(gcode, /^G0 Z-0\.180$/m);
  assert.match(gcode, /^G1 Z-0\.500 F10$/m);
});

test('drill with zero depth warns and cuts nothing', () => {
  const gcode = makeQuickCutGenerator(false).generateDrillProgram(drillBase({ depth: 0 }));
  assert.match(gcode, /WARNING/);
  assert.ok(!/^G1 /m.test(gcode));
});

// The middle of each tab's lifted span on the final pass, which starts
// at the first plunge to full depth (always 3 in these tests).
function tabEnds(gcode) {
  const lines = gcode.split('\n');
  const finalPass = Math.max(lines.indexOf('G1 Z-3.000 F200'), lines.indexOf('G1 Z-1.000 F200 ; Tab') + 1);
  let pos = { x: 0, y: 0 };
  for (let i = 0; i < finalPass; i++) if (/^G[0123] /.test(lines[i])) pos = parseXY(lines[i], pos);
  const tabs = [];
  for (let i = finalPass + 1; i < lines.length && !/^G0 Z/.test(lines[i]); i++) {
    if (/; Tab$/.test(lines[i])) tabs.push({ from: pos });
    else if (/^G1 Z/.test(lines[i]) && tabs.length && !tabs[tabs.length - 1].to) tabs[tabs.length - 1].to = pos;
    if (/^G[0123] .*[XY]/.test(lines[i])) pos = parseXY(lines[i], pos);
  }
  return tabs.filter(t => t.to).map(t => ({ x: (t.from.x + t.to.x) / 2, y: (t.from.y + t.to.y) / 2 }));
}

test('4 tabs on a rectangle sit in the middle of each side, not on corners', () => {
  const g = makeQuickCutGenerator(false);
  const gcode = g.generateRectangleProgram(baseParams({ width: 50, height: 30, bitDiameter: 6, depth: 3, depthOfCut: 3, tabs: TABS }));
  const mids = tabEnds(gcode).map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
  // Outer path is 56 × 36 around the center: right, top and left tabs
  // are whole spans mid-side.
  assert.deepEqual(mids, [[28, 0], [0, 18], [-28, 0]]);
  // The bottom tab is centered on the start point, so the tabbed pass
  // starts and ends lifted over it: the plunge only reaches the tab top.
  const lines = gcode.split('\n');
  const pass = lines.indexOf('G1 Z-1.000 F200 ; Tab');
  assert.ok(pass > 0);
  assert.match(lines[pass + 1], /^G1 X5\.500 Y-18\.000 F800$/);
  assert.ok(!lines.includes('G1 Z-3.000 F200 ; Tab'));
  const lastZ = lines.slice(pass).filter(l => /^G[01] Z/.test(l));
  assert.deepEqual(lastZ.slice(-2), ['G1 Z-1.000 F200 ; Tab', 'G0 Z5.000']);
});

test('polygon tabs sit mid-edge, away from the vertices', () => {
  const g = makeQuickCutGenerator(false);
  const p = baseParams({ diameter: 60, sides: 6, bitDiameter: 6, depth: 3, depthOfCut: 3, tabs: Object.assign({}, TABS, { count: 3 }) });
  const geomR = (30 * Math.cos(Math.PI / 6) + 3) / Math.cos(Math.PI / 6);
  for (const m of tabEnds(g.generatePolygonProgram(p))) {
    // A mid-edge point is the apothem from the center.
    assert.ok(Math.abs(Math.hypot(m.x, m.y) - geomR * Math.cos(Math.PI / 6)) < 0.01, JSON.stringify(m));
  }
});

test('rounded rectangle tabs move off the corner arcs onto the sides', () => {
  const g = makeQuickCutGenerator(false);
  const gcode = g.generateRectangleProgram(baseParams({ width: 60, height: 40, cornerRadius: 10, bitDiameter: 6, depth: 3, depthOfCut: 3, tabs: Object.assign({}, TABS, { count: 8 }) }));
  for (const m of tabEnds(gcode)) {
    // On a side: x or y sits on the 66 × 46 path's straight edges.
    assert.ok(Math.abs(Math.abs(m.x) - 33) < 0.01 || Math.abs(Math.abs(m.y) - 23) < 0.01, JSON.stringify(m));
  }
});

test('keyhole origin defaults to the plunge hole', () => {
  const g = makeQuickCutGenerator(false);
  const params = keyholeBase({ pattern: { enabled: true, style: 'linear', xDist: 50, yDist: 0, xCount: 2, yCount: 1 } });
  assert.equal(g.generateKeyholeProgram(params), g.generateKeyholeProgram(Object.assign({}, params, { origin: 'hole' })));
  assert.match(g.generateKeyholeProgram(params), /\(Origin: plunge hole center\)/);
});

test('keyhole origin anchors the bounding box of the cut footprint', () => {
  const g = makeQuickCutGenerator(false);
  // Head 9.5 (R 4.75), slot 10 toward +Y: one keyhole spans 9.5 × 19.5.
  const extents = (origin, extra) => {
    const moves = keyholeMoves(g.generateKeyholeProgram(keyholeBase(Object.assign({ origin }, extra))))
      .filter(m => m.cmd === 'G1' && m.xy);
    const xs = moves.map(m => m.x), ys = moves.map(m => m.y);
    // Tool-center extents grown by the head radius = the cut footprint.
    return { minX: Math.min(...xs) - 4.75, maxX: Math.max(...xs) + 4.75,
             minY: Math.min(...ys) - 4.75, maxY: Math.max(...ys) + 4.75 };
  };
  const near = (a, b) => Math.abs(a - b) < 0.002;
  const fl = extents('front-left');
  assert.ok(near(fl.minX, 0) && near(fl.minY, 0) && near(fl.maxX, 9.5) && near(fl.maxY, 19.5), JSON.stringify(fl));
  const c = extents('center');
  assert.ok(near(c.minX, -4.75) && near(c.maxY, 9.75), JSON.stringify(c));
  // Circular (Path Direction) turns each slot with its copy (90° + the
  // copy's angle, so tangent to the circle here). The whole pattern's
  // footprint is anchored, with no overhang past the corner: holes and
  // slot ends all lie within ±30, so it spans 60 + 9.5.
  const br = extents('back-right', { pattern: { enabled: true, style: 'circular-follow', count: 4, radius: 30, startAngle: 0 } });
  assert.ok(near(br.maxX, 0) && near(br.maxY, 0), JSON.stringify(br));
  assert.ok(near(br.minX, -69.5) && near(br.minY, -69.5), JSON.stringify(br));
});

// ---------- Slot ----------

function slotBase(overrides) {
  return Object.assign({
    slotType: 'straight', length: 60, width: 10, angleDeg: 0,
    cutType: 'inner', origin: 'center',
    bitDiameter: 6, depth: 6, depthOfCut: 3,
    feedRate: 800, plungeFeedRate: 200,
    spindleRpm: 15000, spindleDelay: 1,
    mistM7: false, floodM8: false
  }, overrides || {});
}

// Points every ~0.5 along the cutting moves (G1/G2/G3 in XY) at depth z,
// with G2 turning clockwise and G3 counter-clockwise.
function slotSamples(gcode, z) {
  let pos = { x: 0, y: 0 }, cz = null;
  const pts = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!/^G[0123]\b/.test(line) || /^G53/.test(line)) continue;
    const zm = line.match(/Z(-?[\d.]+)/);
    if (zm) cz = parseFloat(zm[1]);
    const cutting = !/^G0\b/.test(line) && cz !== null && Math.abs(cz - z) < 1e-6;
    if (/^G[23]\b/.test(line)) {
      const a = parseArc(line), cw = /^G2\b/.test(line);
      const cx = pos.x + a.i, cy = pos.y + a.j, r = Math.hypot(a.i, a.j);
      const s0 = Math.atan2(pos.y - cy, pos.x - cx);
      let sweep = Math.atan2(a.endY - cy, a.endX - cx) - s0;
      if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; } else if (sweep <= 1e-9) sweep += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) * r / 0.5));
      if (cutting) for (let k = 0; k <= n; k++) pts.push({ x: cx + r * Math.cos(s0 + sweep * k / n), y: cy + r * Math.sin(s0 + sweep * k / n) });
      pos = { x: a.endX, y: a.endY };
      continue;
    }
    const next = parseXY(line, pos);
    if (cutting) {
      const n = Math.max(1, Math.ceil(Math.hypot(next.x - pos.x, next.y - pos.y) / 0.5));
      for (let k = 0; k <= n; k++) pts.push({ x: pos.x + (next.x - pos.x) * k / n, y: pos.y + (next.y - pos.y) * k / n });
    }
    pos = next;
  }
  return pts;
}

// Distance from p to a segment, and to an arc of radius r about the origin
// from a0 to a1 (radians, a1 > a0).
function distToSegment(p, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L)) : 0;
  return Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy);
}
function distToArc(p, r, a0, a1) {
  let a = Math.atan2(p.y, p.x);
  while (a < a0) a += 2 * Math.PI;
  while (a > a0 + 2 * Math.PI) a -= 2 * Math.PI;
  if (a <= a1) return Math.abs(Math.hypot(p.x, p.y) - r);
  return Math.min(Math.hypot(p.x - r * Math.cos(a0), p.y - r * Math.sin(a0)),
                  Math.hypot(p.x - r * Math.cos(a1), p.y - r * Math.sin(a1)));
}

test('straight slot: inner and outer paths sit a bit radius inside / outside the slot edge', () => {
  const g = makeQuickCutGenerator(false);
  // 60 long, 10 wide at 30°: centre line ±25 along the angle.
  const t = Math.PI / 6, ex = 25 * Math.cos(t), ey = 25 * Math.sin(t);
  for (const [cutType, d] of [['inner', 2], ['outer', 8]]) {
    const pts = slotSamples(g.generateSlotProgram(slotBase({ angleDeg: 30, cutType })), -6);
    assert.ok(pts.length > 100, cutType);
    for (const p of pts) {
      const dist = distToSegment(p, -ex, -ey, ex, ey);
      assert.ok(Math.abs(dist - d) < 0.002, `${cutType}: ${dist} at ${p.x},${p.y}`);
    }
  }
  assert.ok(maxArcRadiusDelta(g.generateSlotProgram(slotBase({ angleDeg: 30 }))) < GRBL_ARC_TOLERANCE_MM);
});

test('arc slot: radius/sweep and chord/rise describe the same slot', () => {
  const g = makeQuickCutGenerator(false);
  // Chord 80, rise 20: R = (1600 + 400) / 40 = 50, sweep = 4·atan(0.5).
  const sweep = 4 * Math.atan(0.5) * 180 / Math.PI;
  const viaChord = g.generateSlotProgram(slotBase({ slotType: 'arc', arcMode: 'chord', chord: 80, rise: 20, bulgeAngleDeg: 90 }));
  const viaRadius = g.generateSlotProgram(slotBase({ slotType: 'arc', radius: 50, startAngleDeg: 90 - sweep / 2, sweepDeg: sweep }));
  const body = (s) => s.split('\n').filter(l => /^G[0123] [XY]/.test(l)).join('\n');
  assert.equal(body(viaChord), body(viaRadius));
  assert.match(viaChord, /\(Arc: radius 50mm, from /);
});

test('arc slot: every path is a bit radius from the slot edge, inner arc cut with G2', () => {
  const g = makeQuickCutGenerator(false);
  const a0 = 30 * Math.PI / 180, a1 = 150 * Math.PI / 180;
  for (const [cutType, d] of [['inner', 2], ['outer', 8]]) {
    // origin 'shape-center' keeps the arc's centre at X0 Y0.
    const gcode = g.generateSlotProgram(slotBase({ slotType: 'arc', radius: 40, startAngleDeg: 30, sweepDeg: 120, cutType, origin: 'shape-center' }));
    assert.match(gcode, /^G2 /m);
    assert.ok(maxArcRadiusDelta(gcode) < GRBL_ARC_TOLERANCE_MM);
    const pts = slotSamples(gcode, -6);
    for (const p of pts) {
      const dist = distToArc(p, 40, a0, a1);
      assert.ok(Math.abs(dist - d) < 0.002, `${cutType}: ${dist} at ${p.x},${p.y}`);
    }
  }
  // A negative sweep is the same slot, clockwise from Start.
  const neg = g.generateSlotProgram(slotBase({ slotType: 'arc', radius: 40, startAngleDeg: 150, sweepDeg: -120, origin: 'shape-center' }));
  const pos = g.generateSlotProgram(slotBase({ slotType: 'arc', radius: 40, startAngleDeg: 30, sweepDeg: 120, origin: 'shape-center' }));
  const body = (s) => s.split('\n').filter(l => /^G[0123] [XY]/.test(l)).join('\n');
  assert.equal(body(neg), body(pos));
});

test('slot clearing stays inside the slot and reaches its edge', () => {
  const g = makeQuickCutGenerator(false);
  for (const extra of [{ angleDeg: 0 }, { slotType: 'arc', radius: 40, startAngleDeg: 30, sweepDeg: 120 }]) {
    const gcode = g.generateSlotProgram(slotBase(Object.assign({ cutType: 'clearing', width: 20, stepoverPct: 40, origin: 'shape-center' }, extra)));
    const pts = slotSamples(gcode, -6);
    const dist = extra.slotType ? (p) => distToArc(p, 40, Math.PI / 6, 5 * Math.PI / 6) : (p) => distToSegment(p, -20, 0, 20, 0);
    const ds = pts.map(dist);
    // The bit (radius 3) never crosses the slot edge (half width 10)...
    assert.ok(Math.max(...ds) < 7 + 0.002, JSON.stringify(extra));
    // ...the outer ring touches it, and the centre line is cut.
    assert.ok(Math.max(...ds) > 7 - 0.002 && Math.min(...ds) < 0.002, JSON.stringify(extra));
    // No ring is more than a stepover (2.4) from the next.
    const sorted = [...new Set(ds.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
    for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k] - sorted[k - 1] <= 2.4 + 0.002, `gap ${sorted[k - 1]} → ${sorted[k]}`);
  }
});

test('slot centre line: alternate direction each depth pass, slot is the bit width', () => {
  const g = makeQuickCutGenerator(false);
  // Overall length 60 with a 6 mm bit: the centre line runs ±27.
  const gcode = g.generateSlotProgram(slotBase({ cutType: 'center', depth: 9 }));
  const cuts = gcode.split('\n').filter(l => /^G1 X/.test(l));
  assert.deepEqual(cuts.map(l => l.split(' ')[1]), ['X27.00000', 'X-27.00000', 'X27.00000']);
  assert.match(gcode, /Width: 6mm \[the bit\]/);
  const arc = g.generateSlotProgram(slotBase({ cutType: 'center', slotType: 'arc', radius: 40, startAngleDeg: 0, sweepDeg: 90 }));
  assert.deepEqual(arc.split('\n').filter(l => /^G[23] /.test(l)).map(l => l.slice(0, 2)), ['G3', 'G2']);
});

test('slot origins: end centres, the arc centre and box corners', () => {
  const g = makeQuickCutGenerator(false);
  const first = (gcode) => { const m = gcode.match(/^G0 X(-?[\d.]+) Y(-?[\d.]+)/m); return [parseFloat(m[1]), parseFloat(m[2])]; };
  const near = (a, b) => Math.abs(a[0] - b[0]) < 0.002 && Math.abs(a[1] - b[1]) < 0.002;
  // Straight, origin at the first end centre: centre line runs 0..54 on X.
  const s = slotBase({ cutType: 'center', origin: 'corner:1' });
  assert.ok(near(first(g.generateSlotProgram(s)), [0, 0]), String(first(g.generateSlotProgram(s))));
  assert.ok(near(first(g.generateSlotProgram(Object.assign({}, s, { origin: 'corner:2' }))), [-54, 0]));
  // Front-left: a centre-line cut is the bit's width (6), so the slot box is
  // 56 × 6 and the centre line starts at 3, 3.
  assert.ok(near(first(g.generateSlotProgram(Object.assign({}, s, { origin: 'front-left' }))), [3, 3]));
  // With an inset, the box corner sits that far in from X0 Y0.
  assert.ok(near(first(g.generateSlotProgram(Object.assign({}, s, { origin: 'front-left', inset: 7 }))), [10, 10]));
  // Arc slot, origin at the arc's centre: the path starts at radius 40 from 0,0.
  const a = g.generateSlotProgram(slotBase({ cutType: 'center', slotType: 'arc', radius: 40, startAngleDeg: 0, sweepDeg: 90, origin: 'shape-center' }));
  assert.ok(near(first(a), [40, 0]));
});

test('slot holding tabs, patterns and warnings', () => {
  const g = makeQuickCutGenerator(false);
  const tabbed = g.generateSlotProgram(slotBase({ cutType: 'outer', depth: 9, tabs: { count: 2, width: 4, height: 2 } }));
  assert.match(tabbed, /; Tab/);
  const lifts = tabbed.split('\n').filter(l => /^G1 Z-7\.000.*; Tab/.test(l));
  assert.ok(lifts.length >= 2, tabbed);
  const pat = g.generateSlotProgram(slotBase({ pattern: { enabled: true, style: 'linear', xCount: 3, yCount: 1, xDist: 80, yDist: 0 } }));
  assert.equal((pat.match(/\(Instance /g) || []).length, 3);
  for (const [extra, re] of [
    [{ width: 6, cutType: 'inner' }, /no wider than the bit/],
    [{ slotType: 'arc', radius: 4, startAngleDeg: 0, sweepDeg: 90 }, /as wide as its radius/],
    [{ slotType: 'arc', radius: 20, startAngleDeg: 0, sweepDeg: 340 }, /ends would overlap/],
    [{ slotType: 'arc', radius: 20, sweepDeg: 0 }, /missing or zero/]
  ]) {
    const out = g.generateSlotProgram(slotBase(extra));
    assert.match(out, re);
    assert.doesNotMatch(out, /^G1 /m);
  }
  // Imperial units in the header.
  assert.match(makeQuickCutGenerator(true).generateSlotProgram(slotBase({ length: 2, width: 0.5, bitDiameter: 0.25, depth: 0.25, depthOfCut: 0.125 })), /length 2inch/);
});

test('arc slots: a Path Direction pattern of radius 0 makes a ring about the arc centre', () => {
  const g = makeQuickCutGenerator(false);
  const gcode = g.generateSlotProgram(slotBase({ cutType: 'center', slotType: 'arc', radius: 40, startAngleDeg: 0, sweepDeg: 90, origin: 'shape-center',
    pattern: { enabled: true, style: 'circular-follow', count: 4, radius: 0, startAngle: 0, totalAngle: 360 } }));
  const pts = slotSamples(gcode, -6);
  assert.ok(pts.length > 100);
  for (const p of pts) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 40) < 0.002, `${p.x},${p.y}`);
  // Every quarter of the ring is cut.
  const quads = new Set(pts.map(p => Math.floor(((Math.atan2(p.y, p.x) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2 + 1e-9))));
  assert.equal(quads.size, 4);
});

test('negative inset moves the cut outward past a corner or edge origin', () => {
  const g = makeQuickCutGenerator(false);
  const firstXY = (gcode) => { const m = gcode.match(/^G0 X(-?[\d.]+) Y(-?[\d.]+)/m); return [parseFloat(m[1]), parseFloat(m[2])]; };
  const base = baseParams({ origin: 'front-left' });
  const a = firstXY(g.generateRectangleProgram(base));
  const b = firstXY(g.generateRectangleProgram(Object.assign({}, base, { inset: -5 })));
  assert.ok(Math.abs(b[0] - (a[0] - 5)) < 1e-6 && Math.abs(b[1] - (a[1] - 5)) < 1e-6, `${a} vs ${b}`);
  assert.match(g.generateRectangleProgram(Object.assign({}, base, { inset: -5 })), /Origin: front-left, inset -5mm/);
  // Still ignored at the center.
  assert.equal(g.generateRectangleProgram(Object.assign({}, base, { origin: 'center', inset: -5 })),
               g.generateRectangleProgram(Object.assign({}, base, { origin: 'center' })));
});

test('slot recipe: rounding a stock corner with a centre line and a negative inset', () => {
  const g = makeQuickCutGenerator(false);
  // 10 mm round, 6 mm bit: Radius 13, Sweep 90, inset -6, zeroed on the corner.
  const R = 10, tr = 3;
  for (const [origin, start, sx, sy] of [['front-left', 180, 1, 1], ['front-right', 270, -1, 1], ['back-right', 0, -1, -1], ['back-left', 90, 1, -1]]) {
    const gcode = g.generateSlotProgram(slotBase({ slotType: 'arc', radius: R + tr, startAngleDeg: start, sweepDeg: 90,
      cutType: 'center', origin, inset: -2 * tr, depth: 3, depthOfCut: 3 }));
    const pts = slotSamples(gcode, -3);
    assert.ok(pts.length > 20, origin);
    const cx = sx * R, cy = sy * R;   // the rounded edge's centre, R in from both stock edges
    for (const p of pts) assert.ok(Math.abs(Math.hypot(p.x - cx, p.y - cy) - (R + tr)) < 0.002, `${origin}: ${p.x},${p.y}`);
    // The ends sit a bit radius outside the two stock edges (x = 0 and y = 0), level with the tangent points.
    const ends = [pts[0], pts[pts.length - 1]];
    const onX = ends.find(p => Math.abs(p.x + sx * tr) < 0.002), onY = ends.find(p => Math.abs(p.y + sy * tr) < 0.002);
    assert.ok(onX && Math.abs(onX.y - cy) < 0.002 && onY && Math.abs(onY.x - cx) < 0.002, `${origin}: ${JSON.stringify(ends)}`);
  }
});

// --- Grid (straight Slot lines) ------------------------------------------

const gridSlot = (overrides) => Object.assign({
  slotType: 'straight', length: 10, width: 6, angleDeg: 33, cutType: 'center', origin: 'center', bitDiameter: 6,
  depth: 2, depthOfCut: 2, feedRate: 800, plungeFeedRate: 200, spindleRpm: 15000, spindleDelay: 1,
  pattern: { enabled: true, style: 'grid', xCount: 4, yCount: 3, xDist: 20, yDist: 30 }
}, overrides || {});
const gridLines = (gcode) => {
  const out = [];
  let pos = { x: 0, y: 0 };
  for (const line of gcode.split('\n')) {
    if (/^G0 X/.test(line)) pos = parseXY(line, pos);
    else if (/^G1 X/.test(line)) { const end = parseXY(line, pos); out.push([pos.x, pos.y, end.x, end.y]); pos = end; }
  }
  return out;
};

test('grid: rows span the columns and columns span the rows', () => {
  const g = makeQuickCutGenerator(false);
  const pts = g.computePatternPositions({ enabled: true, style: 'grid', xCount: 4, yCount: 3, xDist: 20, yDist: 30 });
  assert.equal(pts.length, 7);
  assert.deepEqual(pts.slice(0, 3).map(p => [p.x, p.y, p.rotDeg, p.span]), [[30, 0, 0, 60], [30, 30, 0, 60], [30, 60, 0, 60]]);
  assert.deepEqual(pts.slice(3).map(p => [p.x, p.y, p.rotDeg, p.span]), [[0, 30, 90, 60], [20, 30, 90, 60], [40, 30, 90, 60], [60, 30, 90, 60]]);
});

test('grid centre lines meet at the outer lines, ignoring the slot length and angle', () => {
  const g = makeQuickCutGenerator(false);
  const lines = gridLines(g.generateSlotProgram(gridSlot({ origin: 'front-left' })));
  const tr = 3;
  const rows = lines.filter(l => Math.abs(l[1] - l[3]) < 1e-6), cols = lines.filter(l => Math.abs(l[0] - l[2]) < 1e-6);
  assert.equal(rows.length, 3); assert.equal(cols.length, 4);
  rows.forEach(l => assert.deepEqual([Math.min(l[0], l[2]), Math.max(l[0], l[2])], [tr, tr + 60]));
  cols.forEach(l => assert.deepEqual([Math.min(l[1], l[3]), Math.max(l[1], l[3])], [tr, tr + 60]));
  assert.deepEqual(rows.map(l => l[1]), [tr, tr + 30, tr + 60]);
  assert.deepEqual(cols.map(l => l[0]), [tr, tr + 20, tr + 40, tr + 60]);
});

test('grid extent, a single column, and the header', () => {
  const g = makeQuickCutGenerator(false);
  assert.deepEqual(g.computePatternPositions({ enabled: true, style: 'grid', xCount: 4, yCount: 3, xDist: 60, yDist: 60, spacing: 'extent' }),
    g.computePatternPositions({ enabled: true, style: 'grid', xCount: 4, yCount: 3, xDist: 20, yDist: 30 }));
  const one = g.computePatternPositions({ enabled: true, style: 'grid', xCount: 1, yCount: 3, xDist: 20, yDist: 30 });
  assert.deepEqual(one.map(p => [p.x, p.y, p.rotDeg, p.span]), [[0, 30, 90, 60]]);
  const gcode = g.generateSlotProgram(gridSlot());
  assert.match(gcode, /Grid 4x3 lines/);
  assert.match(gcode, /straight grid lines/);
});

test('grid angle turns every line with the grid', () => {
  const g = makeQuickCutGenerator(false);
  const pts = g.computePatternPositions({ enabled: true, style: 'grid', xCount: 2, yCount: 2, xDist: 10, yDist: 10, angle: 30 });
  assert.deepEqual(pts.map(p => p.rotDeg), [30, 30, 120, 120]);
  const lines = gridLines(g.generateSlotProgram(gridSlot({ pattern: { enabled: true, style: 'grid', xCount: 2, yCount: 2, xDist: 10, yDist: 10, angle: 30 } })));
  lines.forEach(l => {
    const a = ((Math.atan2(l[3] - l[1], l[2] - l[0]) * 180 / Math.PI) % 180 + 180) % 180;
    assert.ok([30, 120].some(t => Math.abs(a - t) < 1e-3), `line at ${a}°`);
    assert.ok(Math.abs(Math.hypot(l[2] - l[0], l[3] - l[1]) - 10) < 1e-3);
  });
});

test('slot header notes its holding tabs like the other shapes', () => {
  const g = makeQuickCutGenerator(false);
  const base = { bitDiameter: 6, feedRate: 800, plungeFeedRate: 200, spindleRpm: 15000, spindleDelay: 1, depth: 6, depthOfCut: 2,
    origin: 'center', slotType: 'straight', length: 60, width: 12, tabs: { count: 4, width: 8, height: 2 } };
  const header = (p) => g.generateSlotProgram(Object.assign({}, base, p)).split('\n').filter(l => /^\((Tabs|WARNING)/.test(l));
  assert.deepEqual(header({ cutType: 'outer' }), ['(Tabs: 4 x 8mm wide, 2mm high)']);
  assert.deepEqual(header({ cutType: 'inner', slotType: 'arc', radius: 40, startAngleDeg: 0, sweepDeg: 90 }), ['(Tabs: 4 x 8mm wide, 2mm high)']);
  assert.deepEqual(header({ cutType: 'center' }), []);
  assert.deepEqual(header({ cutType: 'clearing' }), []);
  assert.deepEqual(header({ cutType: 'outer', tabs: null }), []);
  assert.deepEqual(header({ cutType: 'outer', length: 30, tabs: { count: 20, width: 8, height: 2 } }),
    ['(Tabs: 20 x 8mm wide, 2mm high)', '(WARNING: only 6 of 20 tabs fit; using 6)']);
});

test('grid center lines go back and forth: each starts where the last one finished', () => {
  const g = makeQuickCutGenerator(false);
  for (const passes of [1, 2, 3]) {
    const gcode = g.generateSlotProgram(gridSlot({ origin: 'front-left', depth: 2 * passes, depthOfCut: 2,
      pattern: { enabled: true, style: 'grid', xCount: 4, yCount: 3, xDist: 20, yDist: 30 } }));
    let pos = null, prevEnd = null, lineStart = null, hop = [];
    for (const line of gcode.split('\n')) {
      if (/^\(Instance/.test(line)) { if (pos) prevEnd = pos; lineStart = null; continue; }
      const m = line.match(/^(G[01]) X(-?[\d.]+) Y(-?[\d.]+)/);
      if (!m) continue;
      pos = { x: +m[2], y: +m[3] };
      if (m[1] === 'G0' && !lineStart) { lineStart = pos; if (prevEnd) hop.push(Math.hypot(pos.x - prevEnd.x, pos.y - prevEnd.y)); }
    }
    // Within rows (30 apart) and within columns (20 apart) the hop is one
    // spacing; only the row-to-column change can be longer.
    assert.equal(hop.length, 6);
    assert.ok(hop.filter(h => h > 30 + 1e-6).length <= 1, `passes=${passes} hops=${hop.map(h => h.toFixed(1))}`);
  }
});

test('polygon header notes the size as entered across flats or as an edge length', () => {
  const g = makeQuickCutGenerator(false);
  const base = { sides: 6, cutType: 'outer', origin: 'center', bitDiameter: 6, depth: 3, depthOfCut: 3, feedRate: 800, plungeFeedRate: 200, spindleRpm: 15000, spindleDelay: 1 };
  const dia = (gc) => gc.split('\n').find(l => /^\(Diameter:/.test(l));
  assert.equal(dia(g.generatePolygonProgram(Object.assign({}, base, { diameter: 40 }))), '(Diameter: 40mm [circumscribed])');
  assert.equal(dia(g.generatePolygonProgram(Object.assign({}, base, { diameter: 40 / Math.cos(Math.PI / 6), sizeMode: 'flats', sizeValue: 40 }))),
    '(Diameter: 46.188mm [circumscribed; 40mm across flats])');
  assert.equal(dia(g.generatePolygonProgram(Object.assign({}, base, { diameter: 20 / Math.sin(Math.PI / 6), sizeMode: 'edge', sizeValue: 20 }))),
    '(Diameter: 40mm [circumscribed; 20mm edge length])');
  assert.equal(g.generatePolygonProgram(Object.assign({}, base, { diameter: 40, sizeMode: 'corners', sizeValue: 40 })),
    g.generatePolygonProgram(Object.assign({}, base, { diameter: 40 })));
});
