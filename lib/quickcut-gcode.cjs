/**
 * QuickCut G-code generators.
 *
 * MUST STAY IN SYNC WITH the inline generators inside config.html.
 * ncSenderPro V2's plugin server hands config.html to the dialog
 * verbatim and won't inject external JS, so the browser-side copies
 * live inline there — this file is the Node-loadable twin used by
 * tests/quickcut-gcode.test.cjs. Every fix to a generator must be
 * applied to BOTH files.
 *
 * Arc lines emit endpoints AND I/J offsets at toFixed(5) so start-vs-
 * end radius stays within grblHAL's default arc tolerance ($12 ≈
 * 0.002 mm / 0.00008 in). Anything lower can flip a corner arc into
 * error:33 "Motion command target is invalid" — same class of bug we
 * hit on ToolBench Boring.
 */
function makeQuickCutGenerator(isImperial) {
  var safeHopDelta = isImperial ? (5 * 0.0393701) : 5;

  function coreSafeZLine(safeZHeightMm) {
    if (typeof safeZHeightMm !== 'number' || !isFinite(safeZHeightMm)) return null;
    return 'G53 G0 Z' + (isImperial ? (safeZHeightMm * 0.0393701) : safeZHeightMm).toFixed(3);
  }

  // Where the shape's local (0, 0) sits relative to workpiece origin.
  // `origin` names WHICH POINT of the shape's bounding box lands on
  // workpiece (0, 0). Returned offset is added to a shape-local coord
  // to produce the workpiece coord.
  function originOffset(origin, width, height) {
    // See config.html for the naming convention (back = +Y, front = -Y).
    switch (origin) {
      case 'center':        return { x:  0,         y:  0          };
      case 'back-left':     return { x:  width / 2, y: -height / 2 };
      case 'back-center':   return { x:  0,         y: -height / 2 };
      case 'back-right':    return { x: -width / 2, y: -height / 2 };
      case 'left-center':   return { x:  width / 2, y:  0          };
      case 'right-center':  return { x: -width / 2, y:  0          };
      case 'front-left':    return { x:  width / 2, y:  height / 2 };
      case 'front-center':  return { x:  0,         y:  height / 2 };
      case 'front-right':   return { x: -width / 2, y:  height / 2 };
      default:              return { x:  0,         y:  0          };
    }
  }

  function programHeader(params, opts) {
    var unitsCode = isImperial ? 'G20' : 'G21';
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var lines = [];
    lines.push('(QuickCut: ' + opts.shapeLabel + ')');
    if (opts.extraComments) {
      for (var i = 0; i < opts.extraComments.length; i++) lines.push('(' + opts.extraComments[i] + ')');
    }
    if (params.cutType) lines.push('(Cut Type: ' + params.cutType + ')');
    lines.push('(Bit Diameter: ' + params.bitDiameter + unitsLabel + ')');
    lines.push('(Feed Rate: ' + params.feedRate + unitsLabel + '/min, Spindle: ' + params.spindleRpm + 'RPM)');
    lines.push('');
    lines.push(unitsCode + ' ; ' + (isImperial ? 'Imperial' : 'Metric') + ' units');
    lines.push('G17 ; XY plane selection');
    lines.push('G90 ; Absolute positioning');
    lines.push('G94 ; Feed rate per minute');
    lines.push('');
    var csz = coreSafeZLine(params.safeZHeightMm);
    if (csz) lines.push(csz + ' ; Move to safe Z');
    else lines.push('G53 G0 Z0 ; Move to machine Z0');
    lines.push('');
    return lines;
  }

  function programFooter(params) {
    var lines = [];
    var csz = coreSafeZLine(params.safeZHeightMm);
    if (csz) lines.push(csz + ' ; Return to safe Z');
    else lines.push('G53 G0 Z0 ; Return to machine Z0');
    if (params.mistM7 || params.floodM8) lines.push('M9 ; Coolant off');
    if (params.spindleRpm > 0) lines.push('M5 ; Stop spindle');
    lines.push('M30 ; Program end');
    return lines;
  }

  function startupBlock(params) {
    var lines = [];
    if (params.mistM7) lines.push('M7 ; Mist coolant on');
    if (params.floodM8) lines.push('M8 ; Flood coolant on');
    if (params.spindleRpm > 0) {
      lines.push('M3 S' + params.spindleRpm + ' ; Start spindle');
      if (params.spindleDelay > 0) {
        lines.push('G4 P' + params.spindleDelay + ' ; Wait ' + params.spindleDelay + ' seconds');
      }
    }
    return lines;
  }

  // Rotate a point (x, y) around a pivot (px, py) by `deg`. Used to
  // implement circular-pattern "Rotate Object" — each instance's shape
  // is emitted rotated so its local +X points outward from the pattern
  // center. deg=0 returns the point unchanged.
  function rotatePoint(px, py, x, y, deg) {
    if (!deg) return { x: x, y: y };
    var rad = deg * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var dx = x - px, dy = y - py;
    return { x: px + dx * cos - dy * sin, y: py + dx * sin + dy * cos };
  }

  // Emit one CCW rectangle lap at constant Z. Path starts at mid-bottom
  // of the given (cx, cy, halfW, halfH, cornerR) geometry. First G1 tag
  // gets the feed rate; subsequent segments inherit it.
  //
  // If geom.rotationDeg is set, every output coord is rotated around
  // (cx, cy). Rotation preserves distances and CCW-ness, so G3 stays G3
  // and I/J are recomputed as (rotated-center − rotated-start).
  //
  // Shared between the perimeter cutter and the clearing cutter — the
  // clearing pass calls this once per concentric offset level per depth.
  function emitRectanglePath(lines, geom, feedRate) {
    var cx = geom.cx, cy = geom.cy;
    var halfW = geom.halfW, halfH = geom.halfH;
    var cornerR = geom.cornerR;
    var rot = geom.rotationDeg || 0;
    var xR = cx + halfW, xL = cx - halfW;
    var yT = cy + halfH, yB = cy - halfH;
    var startX = cx, startY = yB;
    var feedSuffix = ' F' + feedRate;

    function g1(x, y, withFeed) {
      var p = rotatePoint(cx, cy, x, y, rot);
      lines.push('G1 X' + p.x.toFixed(3) + ' Y' + p.y.toFixed(3) + (withFeed ? feedSuffix : ''));
    }
    function g3(endX, endY, ctrX, ctrY, prevX, prevY) {
      var e = rotatePoint(cx, cy, endX, endY, rot);
      var c = rotatePoint(cx, cy, ctrX, ctrY, rot);
      var s = rotatePoint(cx, cy, prevX, prevY, rot);
      lines.push('G3 X' + e.x.toFixed(5) + ' Y' + e.y.toFixed(5) +
                 ' I' + (c.x - s.x).toFixed(5) + ' J' + (c.y - s.y).toFixed(5));
    }

    if (cornerR <= 0) {
      g1(xR, yB, true);
      g1(xR, yT, false);
      g1(xL, yT, false);
      g1(xL, yB, false);
      g1(startX, startY, false);
      return;
    }

    var xRt = xR - cornerR, xLt = xL + cornerR;
    var yTt = yT - cornerR, yBt = yB + cornerR;

    // Original arc centres (unrotated). Each corner arc's center sits
    // at the corner's tangent-crossing point, cornerR from both edges.
    // Bottom-right: center (xRt, yBt) — start (xRt, yB), end (xR, yBt)
    // Top-right:    center (xRt, yTt) — start (xR, yTt), end (xRt, yT)
    // Top-left:     center (xLt, yTt) — start (xLt, yT), end (xL, yTt)
    // Bottom-left:  center (xLt, yBt) — start (xL, yBt), end (xLt, yB)
    g1(xRt, yB, true);
    g3(xR, yBt, xRt, yBt, xRt, yB);
    g1(xR, yTt, false);
    g3(xRt, yT, xRt, yTt, xR, yTt);
    g1(xLt, yT, false);
    g3(xL, yTt, xLt, yTt, xLt, yT);
    g1(xL, yBt, false);
    g3(xLt, yB, xLt, yBt, xL, yBt);
    g1(startX, startY, false);
  }

  // Build the base tool-path geometry for a rectangle. Returns the
  // outermost path (perimeter cut) — clearing walks inward from here.
  // Optional (offsetX, offsetY) shifts the whole geometry — used to
  // place shape instances at pattern positions without touching the
  // origin selector.
  function computeRectangleGeom(params, offsetX, offsetY, rotationDeg) {
    var width = params.width, height = params.height;
    var cornerRadius = Math.max(0, params.cornerRadius || 0);
    var cutType = params.cutType || 'inner';
    var origin = params.origin || 'center';
    var toolRadius = params.bitDiameter / 2;

    var pathHalfW, pathHalfH, cornerR;
    if (cutType === 'inner' || cutType === 'clearing') {
      pathHalfW = width / 2 - toolRadius;
      pathHalfH = height / 2 - toolRadius;
    } else {
      pathHalfW = width / 2 + toolRadius;
      pathHalfH = height / 2 + toolRadius;
    }
    if (cornerRadius <= 0) {
      cornerR = 0;
    } else if (cutType === 'inner' || cutType === 'clearing') {
      cornerR = Math.max(0, cornerRadius - toolRadius);
    } else {
      cornerR = cornerRadius + toolRadius;
    }
    cornerR = Math.min(cornerR, Math.min(pathHalfW, pathHalfH));

    var off = originOffset(origin, width, height);
    return {
      cx: off.x + (offsetX || 0), cy: off.y + (offsetY || 0),
      halfW: pathHalfW, halfH: pathHalfH,
      cornerR: cornerR,
      toolRadius: toolRadius,
      rotationDeg: rotationDeg || 0
    };
  }

  // Expand a pattern definition into a list of {x, y} instance offsets.
  // Origin (0, 0) is always the base position. Pattern disabled or
  // missing → one instance at origin.
  function computePatternPositions(pattern) {
    if (!pattern || !pattern.enabled) return [{ x: 0, y: 0, rotDeg: 0 }];
    var positions = [];
    if (pattern.style === 'linear' || pattern.style === 'honeycomb') {
      var xCount = Math.max(1, Math.floor(pattern.xCount || 1));
      var yCount = Math.max(1, Math.floor(pattern.yCount || 1));
      var xDist = pattern.xDist || 0;
      var yDist = pattern.yDist || 0;
      // Rows outer, columns inner — cutting order is left-to-right,
      // then next row. Signed distances → negative dX/dY reverses
      // direction; the first instance is always at (0, 0).
      // Honeycomb: xCount × yCount is the count of PRIMARY (un-shifted)
      // items. Shifted rows are auto-inserted between primary rows at
      // Y = yDist/2 with X shifted by xDist/2. This matches the user
      // mental model where 10×10 means 10 primary rows visible, with
      // alternates filling in between (not "10 total rows including
      // alternates"). Primary rows span (yCount-1) × yDist in Y so
      // yDist stays the declared row pitch.
      // hexTrim (Symmetric Ends): shifted rows get one fewer item so
      // the pattern's left/right ends align on the primary rows.
      var isHoney = pattern.style === 'honeycomb';
      if (isHoney) {
        var hexTrim = !!pattern.hexTrim;
        for (var j = 0; j < yCount; j++) {
          // Primary (un-shifted) row.
          for (var i = 0; i < xCount; i++) {
            positions.push({ x: i * xDist, y: j * yDist, rotDeg: 0 });
          }
          // Shifted row between this and next primary row.
          if (j < yCount - 1) {
            var shiftedCount = hexTrim ? Math.max(0, xCount - 1) : xCount;
            for (var k = 0; k < shiftedCount; k++) {
              positions.push({
                x: k * xDist + xDist / 2,
                y: j * yDist + yDist / 2,
                rotDeg: 0
              });
            }
          }
        }
        return positions;
      }
      for (var jj = 0; jj < yCount; jj++) {
        for (var ii = 0; ii < xCount; ii++) {
          positions.push({ x: ii * xDist, y: jj * yDist, rotDeg: 0 });
        }
      }
      return positions;
    }
    if (pattern.style === 'circular' || pattern.style === 'circular-follow') {
      var count = Math.max(1, Math.floor(pattern.count || 1));
      var radius = pattern.radius || 0;
      var startAngle = pattern.startAngle || 0;
      var step = 360 / count;
      // 'circular-follow' rotates each instance to point outward from the
      // pattern center (matches CAM's classic "orient along path" flag).
      // Legacy support: { style: 'circular', rotate: true } also enables it.
      var doRotate = pattern.style === 'circular-follow' || !!pattern.rotate;
      for (var k = 0; k < count; k++) {
        var deg = startAngle + step * k;
        var rad = deg * Math.PI / 180;
        positions.push({
          x: radius * Math.cos(rad),
          y: radius * Math.sin(rad),
          rotDeg: doRotate ? deg : 0
        });
      }
      return positions;
    }
    return [{ x: 0, y: 0, rotDeg: 0 }];
  }

  function patternDescription(p) {
    if (!p || !p.enabled) return '';
    if (p.style === 'linear' || p.style === 'honeycomb') {
      var label = p.style === 'honeycomb' ? 'Honeycomb' : 'Linear';
      return label + ' ' + (p.xCount || 1) + 'x' + (p.yCount || 1) +
             ' (dX=' + (p.xDist || 0) + ', dY=' + (p.yDist || 0) + ')';
    }
    var follow = p.style === 'circular-follow' || !!p.rotate;
    return 'Circular' + (follow ? ' (Path Direction)' : ' (Identical)') + ' n=' + (p.count || 1) +
           ' r=' + (p.radius || 0) + ' start=' + (p.startAngle || 0) + '°';
  }

  // === RECTANGLE ==========================================================
  //
  // Cuts the rectangle perimeter as a CCW loop, one full lap per depth
  // pass. Corner radius > 0 turns each corner into a G3 quarter-arc
  // between tangent points; radius 0 uses hard right-angle G1 corners.
  //
  // For "inner" cut the tool path is inset by bitDiameter/2 so the
  // finished pocket is exactly `width` × `height`. For "outer" the tool
  // path is offset outward so the finished part is `width` × `height`.
  // "clearing" is a separate generator below — this handles just the
  // single-perimeter passes.
  //
  // Start point is the midpoint of the bottom edge (safely away from
  // any corner), first plunge happens there, then the lap goes CCW.
  function generateRectangleProgram(params) {
    if ((params.cutType || 'inner') === 'clearing') {
      return generateRectangleClearingProgram(params);
    }
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var baseGeom = computeRectangleGeom(params);

    var extras = [
      'Size: ' + params.width + unitsLabel + ' x ' + params.height + unitsLabel,
      'Corner Radius: ' + (params.cornerRadius || 0) + unitsLabel,
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Origin: ' + (params.origin || 'center')
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Rectangle' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.halfW <= 0 || baseGeom.halfH <= 0) {
      lines.push('(WARNING: shape smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + pos.x.toFixed(3) + ' Y' + pos.y.toFixed(3) + rotStr + ')');
      }
      emitOneRectangle(lines, params, pos.x, pos.y, pos.rotDeg);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  // Cut one rectangle at the given XY offset + optional rotation. Emits
  // the safe-Z hop, slow plunge start position, all depth passes, and a
  // final lift back to safe Z. Assumes header / startupBlock have
  // already run.
  function emitOneRectangle(lines, params, offsetX, offsetY, rotationDeg) {
    var geom = computeRectangleGeom(params, offsetX, offsetY, rotationDeg);
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;

    // Start point (mid-bottom) — rotated with the shape.
    var s0 = rotatePoint(geom.cx, geom.cy, geom.cx, geom.cy - geom.halfH, geom.rotationDeg);
    var startX = s0.x, startY = s0.y;
    lines.push('G0 X' + startX.toFixed(3) + ' Y' + startY.toFixed(3));
    var safeHeight = safeHopDelta.toFixed(3);
    lines.push('G0 Z' + safeHeight);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    lines.push('G0 Z' + slowPlungeStart);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      lines.push('G1 Z' + (-nextDepth).toFixed(3) + ' F' + plungeFeedRate);
      emitRectanglePath(lines, geom, feedRate);
      currentDepth = nextDepth;
    }

    lines.push('G0 Z' + safeHeight);
  }

  // === RECTANGLE (CLEARING) ==============================================
  //
  // Pocket clearing: helical bore at pocket center, then expanding
  // concentric rectangles outward from center to boundary. Engagement
  // is bounded by the stepover distance (bitDiameter × stepoverPct/100)
  // on the straight sections; corners still see a temporary spike (a
  // trade-off vs true adaptive clearing that we accept for the plugin's
  // simple use case).
  //
  // Motion per depth pass:
  //   1. Helical descent (G3 CCW = climb-cut with a right-hand tool)
  //      at (cx + helixRadius, cy) from previous Z to next Z. Helix
  //      radius = 0.6 × toolRadius so the tool's own footprint sweeps
  //      the pocket center — no leftover pillar.
  //   2. G1 cutting transition from helix end to innermost rectangle's
  //      start point (short cut through uncleared material, done at
  //      plunge feed for safety).
  //   3. Cut concentric rectangles innermost → outermost. Between
  //      levels, a G1 cut at plunge feed steps outward by `step` in Y.
  //
  // Only the OUTERMOST level preserves the finished part's corner
  // radius; interior levels use sharp corners because they're roughing.
  //
  // For very tight pockets (helix wouldn't fit), the helix collapses
  // into a straight G1 plunge at the center.
  function generateRectangleClearingProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var baseGeom = computeRectangleGeom(params);
    var stepoverPct = params.stepoverPct || 40;
    var step = params.bitDiameter * (stepoverPct / 100);

    var extras = [
      'Size: ' + params.width + unitsLabel + ' x ' + params.height + unitsLabel,
      'Corner Radius: ' + (params.cornerRadius || 0) + unitsLabel,
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Stepover: ' + stepoverPct + '% (' + step.toFixed(3) + unitsLabel + ')',
      'Entry: helical bore then expanding outward',
      'Origin: ' + (params.origin || 'center')
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Rectangle (clearing)' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.halfW <= 0 || baseGeom.halfH <= 0) {
      lines.push('(WARNING: shape smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }
    if (step <= 0) {
      lines.push('(WARNING: stepover produced non-positive distance; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + pos.x.toFixed(3) + ' Y' + pos.y.toFixed(3) + rotStr + ')');
      }
      emitOneRectangleClearing(lines, params, pos.x, pos.y, step, pos.rotDeg);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  // Emit one pocket-clearing instance at the given XY offset + optional
  // rotation. Header and startupBlock have already run.
  function emitOneRectangleClearing(lines, params, offsetX, offsetY, step, rotationDeg) {
    var base = computeRectangleGeom(params, offsetX, offsetY, rotationDeg);
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;

    // Build concentric levels outer→inner, then reverse so we cut
    // inner→outer. Only the outermost level keeps the finished corner
    // radius; interior levels go sharp.
    var levels = [];
    var offset = 0;
    while (true) {
      var hW = base.halfW - offset;
      var hH = base.halfH - offset;
      if (hW <= 0 || hH <= 0) break;
      var cR = Math.max(0, base.cornerR - offset);
      cR = Math.min(cR, Math.min(hW, hH));
      levels.push({
        cx: base.cx, cy: base.cy, halfW: hW, halfH: hH, cornerR: cR,
        rotationDeg: base.rotationDeg
      });
      if (hW <= base.toolRadius && hH <= base.toolRadius) break;
      offset += step;
    }
    levels.reverse();
    for (var li = 0; li < levels.length - 1; li++) {
      levels[li].cornerR = 0;
    }

    // Helix radius = 60% of toolRadius so the tool footprint sweeping
    // around the helix path covers the pocket center. Cap so it fits
    // inside the pocket. If cap forces it below 10% of toolRadius,
    // fall back to a plunge.
    var helixRadius = base.toolRadius * 0.6;
    helixRadius = Math.min(helixRadius, base.halfW - 0.001, base.halfH - 0.001);
    var useHelix = helixRadius > base.toolRadius * 0.1;
    if (!useHelix) helixRadius = 0;
    var helixStartX = base.cx + helixRadius;
    var helixStartY = base.cy;

    lines.push('G0 X' + helixStartX.toFixed(3) + ' Y' + helixStartY.toFixed(3));
    var safeHeight = safeHopDelta.toFixed(3);
    lines.push('G0 Z' + safeHeight);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    lines.push('G0 Z' + slowPlungeStart);

    var prevZ = parseFloat(slowPlungeStart);
    var currentDepth = 0;
    var maxPitchPerTurn = base.toolRadius * 0.5;

    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var targetZ = -nextDepth;
      var descent = prevZ - targetZ;

      if (useHelix) {
        // Two semicircles per revolution — full-circle G2/G3 don't
        // always render as a helix in the visualizer.
        var numTurns = Math.max(1, Math.ceil(descent / maxPitchPerTurn));
        var pitchPerTurn = descent / numTurns;
        var helixLeftX = base.cx - helixRadius;
        var helixRightX = base.cx + helixRadius;
        for (var t = 0; t < numTurns; t++) {
          var midZ = prevZ - pitchPerTurn * t - pitchPerTurn / 2;
          var endZ = prevZ - pitchPerTurn * (t + 1);
          lines.push('G3 X' + helixLeftX.toFixed(5) + ' Y' + base.cy.toFixed(5) +
                     ' I' + (-helixRadius).toFixed(5) + ' J0' +
                     ' Z' + midZ.toFixed(3) + ' F' + plungeFeedRate);
          lines.push('G3 X' + helixRightX.toFixed(5) + ' Y' + base.cy.toFixed(5) +
                     ' I' + helixRadius.toFixed(5) + ' J0' +
                     ' Z' + endZ.toFixed(3) + ' F' + plungeFeedRate);
        }
      } else {
        lines.push('G1 Z' + targetZ.toFixed(3) + ' F' + plungeFeedRate);
      }

      if (levels.length > 0) {
        // G1 cut from helix end to innermost rect start. Level start
        // points rotate with the shape when Rotate Object is on.
        var inner = levels[0];
        var innerStart = rotatePoint(inner.cx, inner.cy,
                                     inner.cx, inner.cy - inner.halfH,
                                     inner.rotationDeg || 0);
        lines.push('G1 X' + innerStart.x.toFixed(3) + ' Y' + innerStart.y.toFixed(3) +
                   ' F' + plungeFeedRate);

        for (var i = 0; i < levels.length; i++) {
          var lvl = levels[i];
          emitRectanglePath(lines, lvl, feedRate);
          if (i < levels.length - 1) {
            var next = levels[i + 1];
            var nextStart = rotatePoint(next.cx, next.cy,
                                        next.cx, next.cy - next.halfH,
                                        next.rotationDeg || 0);
            lines.push('G1 X' + nextStart.x.toFixed(3) + ' Y' + nextStart.y.toFixed(3) +
                       ' F' + plungeFeedRate);
          }
        }
      }

      prevZ = targetZ;
      currentDepth = nextDepth;

      if (currentDepth < depth - 1e-6) {
        lines.push('G0 X' + helixStartX.toFixed(3) + ' Y' + helixStartY.toFixed(3));
      }
    }

    lines.push('G0 Z' + safeHeight);
  }

  // === CIRCLE =============================================================
  //
  // Full-circle perimeter cut: helical descent (two semicircles per
  // revolution, DOC per revolution) from safe Z down to target depth,
  // then one clean full circle at target depth to eliminate any
  // spiralling on the finished wall.
  //
  // Origin selectors match Rectangle (center of the bounding box).
  // For "inner" the tool path is inset by bitDiameter/2 so the finished
  // pocket has exactly `diameter`. For "outer" the path is offset out
  // so the finished part is `diameter`.
  function computeCircleGeom(params, offsetX, offsetY) {
    var diameter = params.diameter;
    var cutType = params.cutType || 'inner';
    var origin = params.origin || 'center';
    var toolRadius = params.bitDiameter / 2;

    var pathRadius;
    if (cutType === 'inner' || cutType === 'clearing') {
      pathRadius = diameter / 2 - toolRadius;
    } else {
      pathRadius = diameter / 2 + toolRadius;
    }

    // Bounding box for origin math is the finished-part square.
    var off = originOffset(origin, diameter, diameter);
    return {
      cx: off.x + (offsetX || 0), cy: off.y + (offsetY || 0),
      pathRadius: pathRadius,
      toolRadius: toolRadius
    };
  }

  function generateCircleProgram(params) {
    if ((params.cutType || 'inner') === 'clearing') {
      return generateCircleClearingProgram(params);
    }
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var baseGeom = computeCircleGeom(params);

    var extras = [
      'Diameter: ' + params.diameter + unitsLabel,
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Origin: ' + (params.origin || 'center')
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Circle' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.pathRadius <= 0) {
      lines.push('(WARNING: circle smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (positions.length > 1) {
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + pos.x.toFixed(3) + ' Y' + pos.y.toFixed(3) + ')');
      }
      emitOneCircle(lines, params, pos.x, pos.y);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOneCircle(lines, params, offsetX, offsetY) {
    var geom = computeCircleGeom(params, offsetX, offsetY);
    var cx = geom.cx, cy = geom.cy, pathRadius = geom.pathRadius;
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;

    // Position at rightmost point of tool path.
    lines.push('G0 X' + (cx + pathRadius).toFixed(3) + ' Y' + cy.toFixed(3));
    var safeHeight = safeHopDelta.toFixed(3);
    lines.push('G0 Z' + safeHeight);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    lines.push('G0 Z' + slowPlungeStart);

    // Helical descent: each revolution = two semicircles descending by
    // DOC/2 each. This is a CUTTING motion (spiraling around the
    // perimeter while descending) so it uses the cutting feed rate, not
    // plunge rate — plunge rate is reserved for straight-Z entries.
    var prevZ = parseFloat(slowPlungeStart);
    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var targetZ = -nextDepth;
      var midZ = (prevZ + targetZ) / 2;
      // Top-half semicircle: (right, cy) → (left, cy), CCW.
      lines.push('G3 X' + (cx - pathRadius).toFixed(5) + ' Y' + cy.toFixed(5) +
                 ' I' + (-pathRadius).toFixed(5) + ' J0' +
                 ' Z' + midZ.toFixed(3) + ' F' + feedRate);
      // Bottom-half semicircle: (left, cy) → (right, cy), CCW.
      lines.push('G3 X' + (cx + pathRadius).toFixed(5) + ' Y' + cy.toFixed(5) +
                 ' I' + pathRadius.toFixed(5) + ' J0' +
                 ' Z' + targetZ.toFixed(3) + ' F' + feedRate);
      prevZ = targetZ;
      currentDepth = nextDepth;
    }

    // Final cleanup full-circle at target Z — removes spiral marks from
    // the descending pass.
    lines.push('G3 X' + (cx - pathRadius).toFixed(5) + ' Y' + cy.toFixed(5) +
               ' I' + (-pathRadius).toFixed(5) + ' J0 F' + feedRate);
    lines.push('G3 X' + (cx + pathRadius).toFixed(5) + ' Y' + cy.toFixed(5) +
               ' I' + pathRadius.toFixed(5) + ' J0');

    lines.push('G0 Z' + safeHeight);
  }

  // Circle pocket clearing: same idea as rectangle clearing — helical
  // bore at pocket center, then expand outward through concentric
  // circles with G1 cutting transitions between them.
  function generateCircleClearingProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var baseGeom = computeCircleGeom(params);
    var stepoverPct = params.stepoverPct || 40;
    var step = params.bitDiameter * (stepoverPct / 100);

    var extras = [
      'Diameter: ' + params.diameter + unitsLabel,
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Stepover: ' + stepoverPct + '% (' + step.toFixed(3) + unitsLabel + ')',
      'Entry: helical bore then expanding outward',
      'Origin: ' + (params.origin || 'center')
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Circle (clearing)' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.pathRadius <= 0) {
      lines.push('(WARNING: circle smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }
    if (step <= 0) {
      lines.push('(WARNING: stepover produced non-positive distance; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (positions.length > 1) {
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + pos.x.toFixed(3) + ' Y' + pos.y.toFixed(3) + ')');
      }
      emitOneCircleClearing(lines, params, pos.x, pos.y, step);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOneCircleClearing(lines, params, offsetX, offsetY, step) {
    var geom = computeCircleGeom(params, offsetX, offsetY);
    var cx = geom.cx, cy = geom.cy;
    var pathRadius = geom.pathRadius;
    var toolRadius = geom.toolRadius;
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;

    // Build concentric radii outer→inner, then reverse.
    var radii = [];
    var offset = 0;
    while (true) {
      var r = pathRadius - offset;
      if (r <= 0) break;
      radii.push(r);
      if (r <= toolRadius) break;
      offset += step;
    }
    radii.reverse();

    var helixRadius = toolRadius * 0.6;
    helixRadius = Math.min(helixRadius, pathRadius - 0.001);
    var useHelix = helixRadius > toolRadius * 0.1;
    if (!useHelix) helixRadius = 0;
    var helixStartX = cx + helixRadius;

    lines.push('G0 X' + helixStartX.toFixed(3) + ' Y' + cy.toFixed(3));
    var safeHeight = safeHopDelta.toFixed(3);
    lines.push('G0 Z' + safeHeight);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    lines.push('G0 Z' + slowPlungeStart);

    var prevZ = parseFloat(slowPlungeStart);
    var currentDepth = 0;
    var maxPitchPerTurn = toolRadius * 0.5;

    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var targetZ = -nextDepth;
      var descent = prevZ - targetZ;

      if (useHelix) {
        var numTurns = Math.max(1, Math.ceil(descent / maxPitchPerTurn));
        var pitchPerTurn = descent / numTurns;
        var helixLeftX = cx - helixRadius;
        var helixRightX = cx + helixRadius;
        for (var t = 0; t < numTurns; t++) {
          var midZ = prevZ - pitchPerTurn * t - pitchPerTurn / 2;
          var endZ = prevZ - pitchPerTurn * (t + 1);
          lines.push('G3 X' + helixLeftX.toFixed(5) + ' Y' + cy.toFixed(5) +
                     ' I' + (-helixRadius).toFixed(5) + ' J0' +
                     ' Z' + midZ.toFixed(3) + ' F' + plungeFeedRate);
          lines.push('G3 X' + helixRightX.toFixed(5) + ' Y' + cy.toFixed(5) +
                     ' I' + helixRadius.toFixed(5) + ' J0' +
                     ' Z' + endZ.toFixed(3) + ' F' + plungeFeedRate);
        }
      } else {
        lines.push('G1 Z' + targetZ.toFixed(3) + ' F' + plungeFeedRate);
      }

      if (radii.length > 0) {
        // G1 from helix end (rightmost) outward to innermost circle
        // start (rightmost of that ring), then walk outward. Each
        // between-ring G1 is a short radial cut through fresh material.
        lines.push('G1 X' + (cx + radii[0]).toFixed(3) + ' Y' + cy.toFixed(3) +
                   ' F' + plungeFeedRate);
        for (var i = 0; i < radii.length; i++) {
          var rr = radii[i];
          // Full circle at Z = targetZ, as two semicircles.
          lines.push('G3 X' + (cx - rr).toFixed(5) + ' Y' + cy.toFixed(5) +
                     ' I' + (-rr).toFixed(5) + ' J0 F' + feedRate);
          lines.push('G3 X' + (cx + rr).toFixed(5) + ' Y' + cy.toFixed(5) +
                     ' I' + rr.toFixed(5) + ' J0');
          if (i < radii.length - 1) {
            lines.push('G1 X' + (cx + radii[i + 1]).toFixed(3) + ' Y' + cy.toFixed(3) +
                       ' F' + plungeFeedRate);
          }
        }
      }

      prevZ = targetZ;
      currentDepth = nextDepth;

      if (currentDepth < depth - 1e-6) {
        lines.push('G0 X' + helixStartX.toFixed(3) + ' Y' + cy.toFixed(3));
      }
    }

    lines.push('G0 Z' + safeHeight);
  }

  // === PLANER =============================================================
  //
  // Surface a flat rectangular region with a raster pattern. Ported (with
  // simplifications) from ToolBench Planer — same core zigzag / spiral
  // math, minus thickness-mode and wasteboard-mode which stay TODOs.
  //
  // Overrun extends the cut area past every edge so the tool overshoots
  // slightly and doesn't leave scallops at the boundaries.
  //
  // Origin controls which corner of the pre-overrun region lands at
  // work coord (0, 0) — same semantics as Rectangle's origin, so users
  // don't have to relearn the convention.
  //
  // Patterns:
  //   zigzagY — long strokes along Y, stepover advances along X
  //   zigzagX — long strokes along X, stepover advances along Y
  //   spiral  — outside-in rectangular spiral
  function generatePlanerProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var mode = params.mode || 'depth';
    var isThickness = (mode === 'thickness');
    var isWasteboard = (mode === 'wasteboard');
    var startingThickness = params.startingThickness || 0;
    var width = params.width, height = params.height;
    // Wasteboard mode = full machine travel; overrun disabled since
    // the tool can't go past the machine bounds.
    var overrun = isWasteboard ? 0 : (params.overrun || 0);
    var depth = params.depth, depthOfCut = params.depthOfCut;
    var bitDiameter = params.bitDiameter;
    var stepoverPct = params.stepoverPct || 40;
    var feedRate = params.feedRate, plungeFeedRate = params.plungeFeedRate;
    var pattern = params.pattern || 'zigzagY';

    var bl = regionBottomLeft(params.origin || 'front-left', width, height);
    var startX = bl.x - overrun;
    var startY = bl.y - overrun;
    var cutW = width + overrun * 2;
    var cutH = height + overrun * 2;
    // Wasteboard: pull the whole cut area IN by bit radius so the tool's
    // OUTER EDGE stops at the machine travel bounds. Without this inset
    // the tool center travels all the way to $130/$131 and the cutter
    // over-travels by bit radius, crashing into the machine frame.
    if (isWasteboard) {
      var inset = bitDiameter / 2;
      startX += inset;
      startY += inset;
      cutW  -= inset * 2;
      cutH  -= inset * 2;
    }
    var stepoverDist = bitDiameter * (stepoverPct / 100);

    var modeLabels = { depth: 'Target Depth', thickness: 'Target Thickness', wasteboard: 'Wasteboard Surfacing' };
    var extras = [
      'Mode: ' + (modeLabels[mode] || mode),
      'Region: ' + width + ' x ' + height + ' ' + unitsLabel
    ];
    if (isWasteboard) {
      extras.push('Machine coordinates — set G54 origin to machine zero (0,0,0) before running');
    }
    if (!isWasteboard) extras.push('Overrun: ' + overrun + unitsLabel + ' (cut area ' + cutW + ' x ' + cutH + ')');
    if (isThickness) {
      extras.push('Starting Thickness: ' + startingThickness + unitsLabel +
                  ', Target Thickness: ' + (startingThickness - depth) + unitsLabel);
      extras.push('Amount to Remove: ' + depth + unitsLabel + ', Step: ' + depthOfCut + unitsLabel);
    } else {
      extras.push('Depth: ' + depth + unitsLabel + ', Step: ' + depthOfCut + unitsLabel);
    }
    extras.push('Stepover: ' + stepoverPct + '% (' + stepoverDist.toFixed(3) + unitsLabel + ')');
    extras.push('Pattern: ' + pattern);
    extras.push('Origin: ' + (params.origin || 'front-left'));

    var lines = programHeader(params, {
      shapeLabel: 'Planer' + (isThickness ? ' (thickness)' : isWasteboard ? ' (wasteboard)' : ''),
      extraComments: extras
    });

    if (bitDiameter <= 0 || stepoverDist <= 0 || cutW <= 0 || cutH <= 0) {
      lines.push('(WARNING: invalid parameters; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }
    if (isThickness && startingThickness - depth < 0) {
      lines.push('(WARNING: target thickness goes below wasteboard — clamp check your Amount to Remove)');
    }

    lines.push.apply(lines, startupBlock(params));

    // Safe hop above the tallest surface the tool could hit:
    //   - thickness mode: above the current top of stock (thicknessStartZ)
    //   - depth/wasteboard: above workpiece Z0 (workpiece top)
    var safeHopWork = (isThickness ? (startingThickness + safeHopDelta) : safeHopDelta).toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      // Thickness mode: positive Z above wasteboard, decreasing per pass.
      // Depth/wasteboard: negative Z below workpiece Z0.
      var z = isThickness ? (startingThickness - nextDepth) : -nextDepth;
      lines.push('(Pass Z' + z.toFixed(3) + ')');
      lines.push('G0 X' + startX.toFixed(3) + ' Y' + startY.toFixed(3));
      lines.push('G0 Z' + safeHopWork);
      // In thickness mode approach plunge from just above the previous
      // surface (or slowPlungeStart above workpiece top, whichever is
      // lower). Simpler: just G0 to a safe-approach Z above the target.
      var approachZ = isThickness
        ? (startingThickness - currentDepth + 0.5).toFixed(3)
        : slowPlungeStart;
      lines.push('G0 Z' + approachZ);
      lines.push('G1 Z' + z.toFixed(3) + ' F' + plungeFeedRate);
      emitPlanerLap(lines, pattern, startX, startY, cutW, cutH, stepoverDist, feedRate);
      lines.push('G0 Z' + safeHopWork);
      currentDepth = nextDepth;
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitPlanerLap(lines, pattern, startX, startY, cutW, cutH, step, feedRate) {
    if (pattern === 'spiral') {
      emitSpiral(lines, startX, startY, cutW, cutH, step, feedRate);
      return;
    }
    var invert = (pattern === 'zigzagX');
    var stepDim = invert ? cutH : cutW;
    var numPasses = Math.ceil(stepDim / step) + 1;
    var direction = 1;
    // First move to starting corner (matches ToolBench's semantics —
    // stepover before each pass except the first).
    for (var p = 0; p < numPasses; p++) {
      if (invert) {
        var y = Math.min(startY + p * step, startY + cutH);
        if (p > 0) lines.push('G1 Y' + y.toFixed(3) + ' F' + feedRate);
        var xEnd = direction === 1 ? (startX + cutW) : startX;
        lines.push('G1 X' + xEnd.toFixed(3) + ' F' + feedRate);
      } else {
        var x = Math.min(startX + p * step, startX + cutW);
        if (p > 0) lines.push('G1 X' + x.toFixed(3) + ' F' + feedRate);
        var yEnd = direction === 1 ? (startY + cutH) : startY;
        lines.push('G1 Y' + yEnd.toFixed(3) + ' F' + feedRate);
      }
      direction *= -1;
    }
  }

  function emitSpiral(lines, startX, startY, cutW, cutH, step, feedRate) {
    var effStep = Math.max(Math.min(step, Math.min(cutW, cutH) / 2), 0.1);
    var left = startX, right = startX + cutW;
    var bottom = startY, top = startY + cutH;
    var curX = left, curY = bottom;
    while (right - left > 0 && top - bottom > 0) {
      lines.push('G1 X' + right.toFixed(3) + ' Y' + bottom.toFixed(3) + ' F' + feedRate);
      curX = right; curY = bottom;
      bottom += effStep; if (bottom >= top) break;
      lines.push('G1 X' + curX.toFixed(3) + ' Y' + top.toFixed(3) + ' F' + feedRate);
      curY = top;
      right -= effStep; if (left >= right) break;
      lines.push('G1 X' + left.toFixed(3) + ' Y' + curY.toFixed(3) + ' F' + feedRate);
      curX = left;
      top -= effStep; if (bottom >= top) break;
      lines.push('G1 X' + curX.toFixed(3) + ' Y' + bottom.toFixed(3) + ' F' + feedRate);
      curY = bottom;
      left += effStep; if (left >= right) break;
      lines.push('G1 X' + left.toFixed(3) + ' Y' + curY.toFixed(3) + ' F' + feedRate);
      curX = left;
    }
  }

  // Returns the bottom-left corner (world coords) of a `width × height`
  // region given which of its bounding-box corners lands at (0, 0).
  function regionBottomLeft(origin, width, height) {
    switch (origin) {
      case 'front-left':  return { x: 0, y: 0 };
      case 'front-right': return { x: -width, y: 0 };
      case 'back-left':     return { x: 0, y: -height };
      case 'back-right':    return { x: -width, y: -height };
      case 'center':       return { x: -width / 2, y: -height / 2 };
      default:             return { x: 0, y: 0 };
    }
  }

  // === JOINTER ============================================================
  //
  // Straight edge-jointing cut. Removes `trimWidth` of material per pass
  // (perpendicular to feed axis) across `numTrims` passes — total edge
  // removed = trimWidth × numTrims. Each pass:
  //   - rapids to the pass start position
  //   - plunges to depth
  //   - feeds along the whole selected axis (length = machine max travel,
  //     from grblHAL $130 / $131) in the chosen cut direction
  //   - retracts and returns to start, stepping over by trimWidth
  // Single-direction cuts (no zigzag) so climb/conventional stays
  // consistent on every pass.
  //
  // Cut direction:
  //   conventional — feed +axis (tool teeth engage against feed direction)
  //   climb        — feed -axis (tool teeth engage with feed direction)
  function generateJointerProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var length = params.length || 0;
    var trimWidth = params.trimWidth || 0;
    var numTrims = Math.max(1, Math.floor(params.numTrims || 1));
    var totalTrim = trimWidth * numTrims;
    var feedAxis = params.feedAxis || 'x';
    var cutDirection = params.cutDirection || 'conventional';
    // Origin = the side of the material the operator zeros on. Material
    // extends AWAY from that side, so stepover goes into +perpendicular
    // (front/left) or -perpendicular (back/right).
    var origin = params.origin || (feedAxis === 'x' ? 'front' : 'left');
    var stepDir = (origin === 'front' || origin === 'left') ? 1 : -1;
    var overrun = params.overrun || 0;
    var depth = params.depth, depthOfCut = params.depthOfCut;
    var bitDiameter = params.bitDiameter;
    var feedRate = params.feedRate, plungeFeedRate = params.plungeFeedRate;

    // Feed start/end along feed axis (with overrun both ends). Cut
    // direction flips them.
    var feedStart = -overrun;
    var feedEnd = length + overrun;
    if (cutDirection === 'climb') {
      var tmp = feedStart; feedStart = feedEnd; feedEnd = tmp;
    }

    var lines = programHeader(params, {
      shapeLabel: 'Jointer',
      extraComments: [
        'Length: ' + length + unitsLabel + ' along ' + feedAxis.toUpperCase() + '-axis',
        'Trim: ' + trimWidth + unitsLabel + ' × ' + numTrims +
          ' pass' + (numTrims === 1 ? '' : 'es') + ' = ' + totalTrim + unitsLabel + ' total',
        'Cut Direction: ' + cutDirection,
        'Side to Cut: ' + origin,
        'Overrun: ' + overrun + unitsLabel,
        'Depth: ' + depth + unitsLabel + ', Step: ' + depthOfCut + unitsLabel
      ]
    });

    if (bitDiameter <= 0 || trimWidth <= 0 || numTrims < 1 || length <= 0) {
      lines.push('(WARNING: invalid parameters; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);

    // Single-direction cuts per pass (no zigzag) so climb/conventional
    // stays consistent every pass. Between passes: retract, return to
    // start, step over into material by trimWidth.
    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var z = -nextDepth;
      lines.push('(Pass Z' + z.toFixed(3) + ')');
      for (var i = 0; i < numTrims; i++) {
        var stepOffset = i * trimWidth * stepDir;
        var fromX, fromY, toX, toY;
        if (feedAxis === 'x') {
          fromX = feedStart; fromY = stepOffset;
          toX = feedEnd;     toY = stepOffset;
        } else {
          fromX = stepOffset; fromY = feedStart;
          toX = stepOffset;   toY = feedEnd;
        }
        lines.push('(Trim ' + (i + 1) + '/' + numTrims + ')');
        lines.push('G0 X' + fromX.toFixed(3) + ' Y' + fromY.toFixed(3));
        lines.push('G0 Z' + safeHeight);
        lines.push('G0 Z' + slowPlungeStart);
        lines.push('G1 Z' + z.toFixed(3) + ' F' + plungeFeedRate);
        lines.push('G1 X' + toX.toFixed(3) + ' Y' + toY.toFixed(3) + ' F' + feedRate);
        lines.push('G0 Z' + safeHeight);
      }
      currentDepth = nextDepth;
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  // === CUTTER =============================================================
  // Cold-saw-style parting cut. Tool feeds along the FEED axis (X or Y)
  // for `cuttingLength`. The cut line sits on the PERPENDICULAR axis at
  // `targetSize + bitRadius` so the kept material has exactly `targetSize`
  // on that perpendicular axis. Origin (front/back or left/right) picks
  // which side of workpiece zero the cut sits on.
  function generateCutterProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var feedAxis = params.axis || 'x';           // tool travel direction
    var target = params.targetSize || 0;          // perpendicular-axis final dim
    var cuttingLength = params.cuttingLength || 0;
    var cutDirection = params.cutDirection || 'conventional';
    var origin = params.origin || (feedAxis === 'x' ? 'front' : 'left');
    var depth = params.depth, depthOfCut = params.depthOfCut;
    var bitDiameter = params.bitDiameter;
    var bitRadius = bitDiameter / 2;
    var feedRate = params.feedRate, plungeFeedRate = params.plungeFeedRate;

    var perpAxis = feedAxis === 'x' ? 'y' : 'x';
    // Origin front/left → material on +perp side, cut line at +target+r.
    // Origin back/right → material on -perp side, cut line at -(target+r).
    var perpDir = (origin === 'front' || origin === 'left') ? 1 : -1;
    var cutPos = perpDir * (target + bitRadius);
    // Feed positions along feed axis: 0 → cuttingLength (climb reverses).
    var feedFrom = 0;
    var feedTo = cuttingLength;
    if (cutDirection === 'climb') {
      var tmp = feedFrom; feedFrom = feedTo; feedTo = tmp;
    }

    var lines = programHeader(params, {
      shapeLabel: 'Cutter',
      extraComments: [
        'Cut Axis: ' + feedAxis.toUpperCase() +
          ' (tool travels ' + cuttingLength + unitsLabel + ')',
        'Cut Line: ' + perpAxis.toUpperCase() + '=' + cutPos.toFixed(3) + unitsLabel +
          ' (target ' + target + unitsLabel + ' + bit radius, sign from origin)',
        'Cut Direction: ' + cutDirection,
        'Origin (start side): ' + origin,
        'Depth: ' + depth + unitsLabel + ', Step: ' + depthOfCut + unitsLabel
      ]
    });

    if (bitDiameter <= 0 || target <= 0 || cuttingLength <= 0) {
      lines.push('(WARNING: invalid parameters; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var z = -nextDepth;
      var fromX, fromY, toX, toY;
      if (feedAxis === 'x') {
        // Feed along X, cut line at Y = cutPos.
        fromX = feedFrom; toX = feedTo; fromY = cutPos; toY = cutPos;
      } else {
        // Feed along Y, cut line at X = cutPos.
        fromY = feedFrom; toY = feedTo; fromX = cutPos; toX = cutPos;
      }
      lines.push('(Pass Z' + z.toFixed(3) + ')');
      lines.push('G0 X' + fromX.toFixed(3) + ' Y' + fromY.toFixed(3));
      lines.push('G0 Z' + safeHeight);
      lines.push('G0 Z' + slowPlungeStart);
      lines.push('G1 Z' + z.toFixed(3) + ' F' + plungeFeedRate);
      lines.push('G1 X' + toX.toFixed(3) + ' Y' + toY.toFixed(3) + ' F' + feedRate);
      lines.push('G0 Z' + safeHeight);
      currentDepth = nextDepth;
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  // ---------- POLYGON ----------
  // Regular N-sided polygon (3–12 sides) sized by circumscribed
  // radius (center-to-vertex). Straight-line perimeter cut with
  // multi-pass depth. Cut-type offset is computed against the
  // apothem so bit-radius compensation is consistent regardless of
  // side count: apothem = R × cos(π/n).
  function computePolygonGeom(params, offsetX, offsetY, extraRotDeg) {
    var radius = params.radius != null ? params.radius : (params.diameter || 0) / 2;
    var sides = Math.max(3, Math.min(12, Math.floor(params.sides || 6)));
    var cutType = params.cutType || 'inner';
    var origin = params.origin || 'center';
    var toolRadius = params.bitDiameter / 2;
    var apothem = radius * Math.cos(Math.PI / sides);

    var shrinkInward = (cutType === 'inner' || cutType === 'clearing');
    var newApothem = shrinkInward ? apothem - toolRadius : apothem + toolRadius;
    var pathRadius = newApothem / Math.cos(Math.PI / sides);

    var startDeg = (params.startAngleDeg || 0) + (extraRotDeg || 0);
    var startAngle = Math.PI / sides - Math.PI / 2 + startDeg * Math.PI / 180;

    // Origin placement uses the polygon's ACTUAL bounding box, not
    // a 2R × 2R circumscribed square — for anything but a square,
    // some vertices sit inside the square, so the polygon's real box
    // is smaller in at least one axis. Compute the finished polygon's
    // vertex bbox (using `radius`, not the tool-path radius) so
    // "front-left" pins the finished part's front-left corner to
    // workpiece (0,0), regardless of side count or rotation.
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < sides; i++) {
      var theta = startAngle + i * 2 * Math.PI / sides;
      var vx = radius * Math.cos(theta);
      var vy = radius * Math.sin(theta);
      if (vx < minX) minX = vx;
      if (vx > maxX) maxX = vx;
      if (vy < minY) minY = vy;
      if (vy > maxY) maxY = vy;
    }
    var bboxCx = (minX + maxX) / 2;
    var bboxCy = (minY + maxY) / 2;
    // In machine convention: back = +Y (maxY), front = -Y (minY).
    var anchorLocalX, anchorLocalY;
    switch (origin) {
      case 'back-left':    anchorLocalX = minX;    anchorLocalY = maxY;    break;
      case 'back-center':  anchorLocalX = bboxCx;  anchorLocalY = maxY;    break;
      case 'back-right':   anchorLocalX = maxX;    anchorLocalY = maxY;    break;
      case 'left-center':  anchorLocalX = minX;    anchorLocalY = bboxCy;  break;
      case 'right-center': anchorLocalX = maxX;    anchorLocalY = bboxCy;  break;
      case 'front-left':   anchorLocalX = minX;    anchorLocalY = minY;    break;
      case 'front-center': anchorLocalX = bboxCx;  anchorLocalY = minY;    break;
      case 'front-right':  anchorLocalX = maxX;    anchorLocalY = minY;    break;
      default:             anchorLocalX = bboxCx;  anchorLocalY = bboxCy;  break;
    }

    return {
      cx: -anchorLocalX + (offsetX || 0),
      cy: -anchorLocalY + (offsetY || 0),
      pathRadius: pathRadius,
      sides: sides,
      toolRadius: toolRadius,
      startAngle: startAngle
    };
  }

  function polygonVertices(cx, cy, radius, sides, startAngle) {
    var pts = [];
    for (var i = 0; i < sides; i++) {
      var theta = startAngle + i * 2 * Math.PI / sides;
      pts.push({ x: cx + radius * Math.cos(theta), y: cy + radius * Math.sin(theta) });
    }
    return pts;
  }

  function generatePolygonProgram(params) {
    if ((params.cutType || 'inner') === 'clearing') {
      return generatePolygonClearingProgram(params);
    }
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var baseGeom = computePolygonGeom(params);

    var polyDiameter = params.diameter != null ? params.diameter : params.radius * 2;
    var extras = [
      'Sides: ' + baseGeom.sides,
      'Diameter: ' + polyDiameter + unitsLabel + ' (circumscribed)',
      'Start Angle: ' + (params.startAngleDeg || 0) + '°',
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Origin: ' + (params.origin || 'center')
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Polygon (' + baseGeom.sides + '-sided)' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.pathRadius <= 0) {
      lines.push('(WARNING: polygon smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + pos.x.toFixed(3) + ' Y' + pos.y.toFixed(3) + rotStr + ')');
      }
      var geom = computePolygonGeom(params, pos.x, pos.y, pos.rotDeg);
      emitOnePolygon(lines, params, geom);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOnePolygon(lines, params, geom) {
    var verts = polygonVertices(geom.cx, geom.cy, geom.pathRadius, geom.sides, geom.startAngle);
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;
    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);

    lines.push('G0 X' + verts[0].x.toFixed(3) + ' Y' + verts[0].y.toFixed(3));
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + slowPlungeStart);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      lines.push('G1 Z' + (-nextDepth).toFixed(3) + ' F' + plungeFeedRate);
      for (var i = 1; i <= verts.length; i++) {
        var v = verts[i % verts.length];
        lines.push('G1 X' + v.x.toFixed(3) + ' Y' + v.y.toFixed(3) + ' F' + feedRate);
      }
      currentDepth = nextDepth;
    }

    lines.push('G0 Z' + safeHeight);
  }

  // ---------- POLYGON (CLEARING) ----------
  function generatePolygonClearingProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var baseGeom = computePolygonGeom(params);
    var stepoverPct = params.stepoverPct || 40;
    var step = params.bitDiameter * (stepoverPct / 100);
    var polyDiameter = params.diameter != null ? params.diameter : params.radius * 2;

    var extras = [
      'Sides: ' + baseGeom.sides,
      'Diameter: ' + polyDiameter + unitsLabel + ' (circumscribed)',
      'Start Angle: ' + (params.startAngleDeg || 0) + '°',
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Stepover: ' + stepoverPct + '% (' + step.toFixed(3) + unitsLabel + ')',
      'Entry: straight plunge at innermost polygon start',
      'Origin: ' + (params.origin || 'center')
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Polygon (' + baseGeom.sides + '-sided, clearing)' +
                  (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.pathRadius <= 0) {
      lines.push('(WARNING: polygon smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }
    if (step <= 0) {
      lines.push('(WARNING: stepover produced non-positive distance; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + pos.x.toFixed(3) + ' Y' + pos.y.toFixed(3) + rotStr + ')');
      }
      var geom = computePolygonGeom(params, pos.x, pos.y, pos.rotDeg);
      emitOnePolygonClearing(lines, params, geom, step);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOnePolygonClearing(lines, params, geom, step) {
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;

    var cosHalfAngle = Math.cos(Math.PI / geom.sides);
    var apoOuter = geom.pathRadius * cosHalfAngle;
    var apoMin = geom.toolRadius;
    var radii = [];
    var apo = apoOuter;
    while (apo > 0) {
      radii.push(apo / cosHalfAngle);
      if (apo <= apoMin) break;
      apo -= step;
    }
    radii.reverse();

    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    var innerVerts = polygonVertices(geom.cx, geom.cy, radii[0], geom.sides, geom.startAngle);

    lines.push('G0 X' + innerVerts[0].x.toFixed(3) + ' Y' + innerVerts[0].y.toFixed(3));
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + slowPlungeStart);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      lines.push('G1 Z' + (-nextDepth).toFixed(3) + ' F' + plungeFeedRate);

      for (var r = 0; r < radii.length; r++) {
        var verts = polygonVertices(geom.cx, geom.cy, radii[r], geom.sides, geom.startAngle);
        if (r > 0) {
          lines.push('G1 X' + verts[0].x.toFixed(3) + ' Y' + verts[0].y.toFixed(3) +
                     ' F' + plungeFeedRate);
        }
        for (var i = 1; i <= verts.length; i++) {
          var v = verts[i % verts.length];
          lines.push('G1 X' + v.x.toFixed(3) + ' Y' + v.y.toFixed(3) + ' F' + feedRate);
        }
      }

      currentDepth = nextDepth;
      if (currentDepth < depth - 1e-6) {
        lines.push('G0 Z' + safeHeight);
        lines.push('G0 X' + innerVerts[0].x.toFixed(3) + ' Y' + innerVerts[0].y.toFixed(3));
        lines.push('G0 Z' + slowPlungeStart);
      }
    }

    lines.push('G0 Z' + safeHeight);
  }

  return {
    generateRectangleProgram: generateRectangleProgram,
    generateRectangleClearingProgram: generateRectangleClearingProgram,
    generateCircleProgram: generateCircleProgram,
    generateCircleClearingProgram: generateCircleClearingProgram,
    generatePlanerProgram: generatePlanerProgram,
    generateJointerProgram: generateJointerProgram,
    generateCutterProgram: generateCutterProgram,
    generatePolygonProgram: generatePolygonProgram,
    generatePolygonClearingProgram: generatePolygonClearingProgram,
    originOffset: originOffset,
    coreSafeZLine: coreSafeZLine,
    programHeader: programHeader,
    programFooter: programFooter,
    startupBlock: startupBlock
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeQuickCutGenerator: makeQuickCutGenerator };
}
