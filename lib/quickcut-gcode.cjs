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
 * Arc lines emit endpoints AND I/J offsets at toFixed(5) -- and so do the
 * G0/G1 moves that place the tool at an arc's start -- so start-vs-
 * end radius stays within grblHAL's default arc tolerance ($12 ≈
 * 0.002 mm / 0.00008 in). Anything lower can flip a corner arc into
 * error:33 "Motion command target is invalid" — same class of bug we
 * hit on ToolBench Boring.
 */
function makeQuickCutGenerator(isImperial) {
  var safeHopDelta = isImperial ? (5 * 0.0393701) : 5;
  // X/Y decimals for G0/G1 moves. An arc starting where a move left the tool
  // needs its start within grblHAL's arc tolerance (~0.002 mm). 3 decimals is
  // 0.0005 mm in metric but 0.0127 mm in inches (error:33), so inches get 5,
  // like the arc words themselves.
  var xyDp = isImperial ? 5 : 3;

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

  // A G-code comment ends at the first ')', and comments can't nest:
  // "(Origin (start side): left)" left ": left)" as G-code and the
  // controller rejected it (error:1), stopping the job on line 5.
  function comment(text) {
    return '(' + String(text).replace(/\(/g, '[').replace(/\)/g, ']') + ')';
  }

  function programHeader(params, opts) {
    var unitsCode = isImperial ? 'G20' : 'G21';
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var lines = [];
    lines.push(comment('QuickCut: ' + opts.shapeLabel));
    if (opts.extraComments) {
      for (var i = 0; i < opts.extraComments.length; i++) lines.push(comment(opts.extraComments[i]));
    }
    if (params.cutType) lines.push(comment('Cut Type: ' + params.cutType));
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

  function machineSafeZLine(params) {
    return coreSafeZLine(params.safeZHeightMm) || 'G53 G0 Z0';
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
      lines.push('G1 X' + p.x.toFixed(xyDp) + ' Y' + p.y.toFixed(xyDp) + (withFeed ? feedSuffix : ''));
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

    // Origin is handled by the pattern loop via computePatternAnchorShift;
    // this fn just centers the shape at the passed offset.
    return {
      cx: (offsetX || 0), cy: (offsetY || 0),
      halfW: pathHalfW, halfH: pathHalfH,
      cornerR: cornerR,
      toolRadius: toolRadius,
      rotationDeg: rotationDeg || 0
    };
  }

  // Linear/Honeycomb grids are laid out along local axes (xDist = step
  // along the row, yDist = step between rows), then the whole grid is
  // rotated by pattern.angle (degrees, CCW from +X) about the first
  // instance. So at 36° xDist is the center-to-center distance along the
  // 36° line, not an X distance. rotateShapes also turns each instance
  // by the same angle so it sits square to the row.
  function applyGridAngle(positions, pattern) {
    var angle = Number(pattern.angle) || 0;
    if (!angle) return positions;
    var rotDeg = pattern.rotateShapes ? angle : 0;
    return positions.map(function(p) {
      var r = rotatePoint(0, 0, p.x, p.y, angle);
      return Object.assign({}, p, { x: r.x, y: r.y, rotDeg: (p.rotDeg || 0) + rotDeg });
    });
  }

  // Extent on an axis: xDist / yDist are first-to-last center, and the
  // copies spread evenly over it. Per axis (xExtent / yExtent), or both
  // axes with spacing: 'extent'.
  function patternAxisExtent(pattern, axis) {
    return pattern.spacing === 'extent' || !!pattern[axis + 'Extent'];
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
      // Extent mode (CAD's "Extent" linear pattern): the distances are
      // first-to-last center, and the copies are spread evenly over it.
      if (patternAxisExtent(pattern, 'x')) xDist = patternStep(xDist, xCount);
      if (patternAxisExtent(pattern, 'y')) yDist = patternStep(yDist, yCount);
      // Rows outer, columns inner — cutting order is left-to-right,
      // then next row. Signed distances → negative dX/dY reverses
      // direction; the first instance is always at (0, 0).
      // Honeycomb: yCount is every row, the shifted ones included: rows
      // alternate primary and shifted (X moved by xDist/2), starting
      // with a primary row, so an even count ends on a shifted row.
      // yDist is row to row (with Extent, first row to last).
      // hexTrim (Symmetric Ends): shifted rows get one fewer item so
      // the pattern's left/right ends align on the primary rows.
      var isHoney = pattern.style === 'honeycomb';
      if (isHoney) {
        var hexTrim = !!pattern.hexTrim;
        for (var j = 0; j < yCount; j++) {
          var shifted = j % 2 === 1;
          var rowCount = shifted && hexTrim ? Math.max(0, xCount - 1) : xCount;
          for (var i = 0; i < rowCount; i++) {
            positions.push({ x: i * xDist + (shifted ? xDist / 2 : 0), y: j * yDist, rotDeg: 0 });
          }
        }
        return applyGridAngle(positions, pattern);
      }
      for (var jj = 0; jj < yCount; jj++) {
        for (var ii = 0; ii < xCount; ii++) {
          positions.push({ x: ii * xDist, y: jj * yDist, rotDeg: 0 });
        }
      }
      return applyGridAngle(positions, pattern);
    }
    // Grid (straight Slot): one copy per line, each carrying the length it
    // spans, so the lines run from the first to the last line across them.
    // Rows (along X) first, then columns turned 90°. With one row or
    // column there's nothing for the other direction to span.
    if (pattern.style === 'grid') {
      var gxCount = Math.max(1, Math.floor(pattern.xCount || 1));
      var gyCount = Math.max(1, Math.floor(pattern.yCount || 1));
      var gxDist = pattern.xDist || 0;
      var gyDist = pattern.yDist || 0;
      if (patternAxisExtent(pattern, 'x')) gxDist = patternStep(gxDist, gxCount);
      if (patternAxisExtent(pattern, 'y')) gyDist = patternStep(gyDist, gyCount);
      var spanX = (gxCount - 1) * gxDist, spanY = (gyCount - 1) * gyDist;
      if (gxCount > 1) {
        for (var gr = 0; gr < gyCount; gr++) positions.push({ x: spanX / 2, y: gr * gyDist, rotDeg: 0, span: Math.abs(spanX) });
      }
      if (gyCount > 1) {
        for (var gc = 0; gc < gxCount; gc++) positions.push({ x: gc * gxDist, y: spanY / 2, rotDeg: 90, span: Math.abs(spanY) });
      }
      if (!positions.length) positions.push({ x: 0, y: 0, rotDeg: 0, span: 0 });
      // The lines always run along the turned grid.
      return applyGridAngle(positions, Object.assign({}, pattern, { rotateShapes: true }));
    }
    if (pattern.style === 'circular' || pattern.style === 'circular-follow') {
      var count = Math.max(1, Math.floor(pattern.count || 1));
      var radius = pattern.radius || 0;
      var startAngle = pattern.startAngle || 0;
      // Total Angle (default 360): a full circle spaces the copies evenly
      // all the way round; a smaller arc puts the first and last copy at
      // its two ends. Negative runs clockwise.
      var step = circularStep(pattern.totalAngle, count);
      // 'circular-follow' rotates each instance to keep the same facing
      // relative to the pattern center as the first copy has (CAM's classic
      // "orient along path" flag).
      // Legacy support: { style: 'circular', rotate: true } also enables it.
      var doRotate = pattern.style === 'circular-follow' || !!pattern.rotate;
      for (var k = 0; k < count; k++) {
        var deg = startAngle + step * k;
        var rad = deg * Math.PI / 180;
        positions.push({
          x: radius * Math.cos(rad),
          y: radius * Math.sin(rad),
          // Turned by how far round the circle the copy is from the
          // first one, so the first copy matches the shape preview.
          rotDeg: doRotate ? deg - startAngle : 0
        });
      }
      return positions;
    }
    return [{ x: 0, y: 0, rotDeg: 0 }];
  }

  // A stable name for each pattern position, in the same order as
  // computePatternPositions: "column,row" (1-based) for Linear and
  // Honeycomb, where Honeycomb's shifted rows are the even rows, and
  // the copy number for Circular. Unlike a plain index, a column/row
  // name keeps naming the same hole when a count changes.
  function patternPositionKeys(pattern) {
    if (!pattern || !pattern.enabled) return ['1,1'];
    var keys = [];
    if (pattern.style === 'linear' || pattern.style === 'honeycomb') {
      var xCount = Math.max(1, Math.floor(pattern.xCount || 1));
      var yCount = Math.max(1, Math.floor(pattern.yCount || 1));
      var isHoney = pattern.style === 'honeycomb';
      var shiftedCount = isHoney && pattern.hexTrim ? Math.max(0, xCount - 1) : xCount;
      for (var j = 0; j < yCount; j++) {
        var rowCount = isHoney && j % 2 === 1 ? shiftedCount : xCount;
        for (var i = 0; i < rowCount; i++) keys.push((i + 1) + ',' + (j + 1));
      }
      return keys;
    }
    if (pattern.style === 'circular' || pattern.style === 'circular-follow') {
      var count = Math.max(1, Math.floor(pattern.count || 1));
      for (var c = 0; c < count; c++) keys.push(String(c + 1));
      return keys;
    }
    return ['1,1'];
  }

  // Drill origin: one of the nine bbox points, or "hole:<key>" to put
  // X0 Y0 on that hole's center (picked by clicking the preview). A
  // hole the pattern no longer has falls back to center.
  function resolveDrillOrigin(origin, pattern, positions, bitDiameter, inset) {
    origin = origin || 'center';
    var note = '';
    var m = /^hole:(.+)$/.exec(origin);
    if (m) {
      var idx = patternPositionKeys(pattern).indexOf(m[1]);
      if (idx >= 0 && idx < positions.length) {
        var parts = m[1].split(',');
        return {
          shift: { x: -positions[idx].x, y: -positions[idx].y },
          index: idx,
          label: parts.length === 2
            ? 'hole at column ' + parts[0] + ', row ' + parts[1]
            : 'hole ' + parts[0]
        };
      }
      origin = 'center';
      note = ' (picked hole not in pattern)';
    }
    return {
      shift: computePatternAnchorShift(origin, positions, circleShapeBbox({ diameter: bitDiameter || 0 }), inset),
      index: -1,
      label: origin + note + insetNote(origin, inset)
    };
  }

  // Axis-aligned extents of a shape bbox after rotating it by `deg`
  // about the instance center. deg=0 returns the bbox unchanged.
  function rotatedBbox(bbox, deg) {
    if (!deg) return bbox;
    var corners = [[bbox.minX, bbox.minY], [bbox.maxX, bbox.minY],
                   [bbox.maxX, bbox.maxY], [bbox.minX, bbox.maxY]];
    var out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (var i = 0; i < corners.length; i++) {
      var r = rotatePoint(0, 0, corners[i][0], corners[i][1], deg);
      if (r.x < out.minX) out.minX = r.x;
      if (r.x > out.maxX) out.maxX = r.x;
      if (r.y < out.minY) out.minY = r.y;
      if (r.y > out.maxY) out.maxY = r.y;
    }
    return out;
  }

  // Given the raw pattern positions and a shape's local bbox (in
  // shape-centered coords, i.e. relative to each instance's own
  // center), return the (dx, dy) shift to apply to every pattern
  // position so the requested `origin` point of the WHOLE PATTERN's
  // aggregate bounding box lands at machine (0, 0).
  //
  // With a single-instance pattern this collapses to the classic
  // "origin relative to one shape" behavior — for a 1-element list,
  // aggregate bbox == shape bbox — so the same helper works both
  // with and without a Pattern enabled.
  //
  // `inset` (optional) keeps that box clear of the origin point: the
  // anchor moves outward by it on each side the origin is on, so the cut
  // moves inward (front-left: +X and +Y; back-center: -Y only; center:
  // nothing). E.g. a juice groove 10 mm in from a board's corner. A
  // negative inset moves the cut outward past the origin instead, e.g. a
  // Slot centre line rounding a stock corner (inset = -bit diameter).
  // An inset { x, y, to: 'center' } is to the copies' centers instead: the
  // box is round the centers, e.g. the first of a row of holes 10 mm in
  // from a corner whatever the bit.
  function computePatternAnchorShift(origin, positions, shapeBbox, inset) {
    var minX = Infinity, maxX = -Infinity;
    var minY = Infinity, maxY = -Infinity;
    // To the centers only on the axis the inset is on (left / right: X;
    // front / back: Y); the other axis, and a center origin, keep the box
    // round the cut, so a shape that isn't symmetric about its center
    // doesn't move there.
    var toCenter = !!(inset && inset.to === 'center');
    var centerX = toCenter && /left|right/.test(origin || ''), centerY = toCenter && /^(front|back)/.test(origin || '');
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      // shapeBbox can be a function of the position, for a shape whose
      // footprint isn't symmetric about its own origin (Keyhole).
      var b = typeof shapeBbox === 'function' ? shapeBbox(p) : rotatedBbox(shapeBbox, p.rotDeg);
      if (centerX || centerY) b = { minX: centerX ? 0 : b.minX, maxX: centerX ? 0 : b.maxX, minY: centerY ? 0 : b.minY, maxY: centerY ? 0 : b.maxY };
      if (p.x + b.minX < minX) minX = p.x + b.minX;
      if (p.x + b.maxX > maxX) maxX = p.x + b.maxX;
      if (p.y + b.minY < minY) minY = p.y + b.minY;
      if (p.y + b.maxY > maxY) maxY = p.y + b.maxY;
    }
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var anchorX, anchorY;
    // Machine convention: back = +Y (maxY), front = -Y (minY).
    switch (origin) {
      case 'back-left':    anchorX = minX; anchorY = maxY; break;
      case 'back-center':  anchorX = cx;   anchorY = maxY; break;
      case 'back-right':   anchorX = maxX; anchorY = maxY; break;
      case 'left-center':  anchorX = minX; anchorY = cy;   break;
      case 'right-center': anchorX = maxX; anchorY = cy;   break;
      case 'front-left':   anchorX = minX; anchorY = minY; break;
      case 'front-center': anchorX = cx;   anchorY = minY; break;
      case 'front-right':  anchorX = maxX; anchorY = minY; break;
      default:             anchorX = cx;   anchorY = cy;   break;
    }
    var ins = insetApplies(origin, inset) ? insetXY(inset) : { x: 0, y: 0 };
    if (/left/.test(origin)) anchorX -= ins.x;
    if (/right/.test(origin)) anchorX += ins.x;
    if (/^front/.test(origin)) anchorY -= ins.y;
    if (/^back/.test(origin)) anchorY += ins.y;
    return { x: -anchorX, y: -anchorY };
  }

  // Inset only means something for a corner or edge of the origin box, on
  // the axis that edge is on. It's one number for both axes, or { x, y }
  // apart: X for a left / right origin, Y for front / back.
  function insetXY(inset) {
    return inset && typeof inset === 'object' ? { x: +inset.x || 0, y: +inset.y || 0 } : { x: inset || 0, y: inset || 0 };
  }
  function insetApplies(origin, inset) {
    if (!/^(front|back|left|right)-/.test(origin || '')) return false;
    var i = insetXY(inset);
    return !!((/left|right/.test(origin) && i.x) || (/^(front|back)/.test(origin) && i.y));
  }

  // ", inset 10mm" (or ", inset X 10mm, Y 5mm") for the header's Origin
  // line, when it applies.
  function insetNote(origin, inset) {
    var toCenter = !!(inset && inset.to === 'center') && /^(front|back|left|right)-/.test(origin || '');
    if (!insetApplies(origin, inset)) return toCenter ? ', to the copies\' centers' : '';
    var u = isImperial ? 'inch' : 'mm', end = toCenter ? ' to centers' : '';
    if (!inset || typeof inset !== 'object' || inset.both) return ', inset ' + insetXY(inset).x + u + end;
    var i = insetXY(inset), parts = [];
    if (/left|right/.test(origin)) parts.push('X ' + i.x + u);
    if (/^(front|back)/.test(origin)) parts.push('Y ' + i.y + u);
    return ', inset ' + parts.join(', ') + end;
  }

  function rectangleShapeBbox(params) {
    var W = params.width, H = params.height;
    return { minX: -W / 2, maxX: W / 2, minY: -H / 2, maxY: H / 2 };
  }

  function circleShapeBbox(params) {
    var R = params.diameter / 2;
    return { minX: -R, maxX: R, minY: -R, maxY: R };
  }

  function polygonShapeBbox(params) {
    var radius = params.radius != null ? params.radius : (params.diameter || 0) / 2;
    var sides = Math.max(3, Math.min(12, Math.floor(params.sides || 6)));
    // Rounded corners: the box of the core polygon (see
    // computePolygonGeom) grown by the corner radius.
    var apothem = radius * Math.cos(Math.PI / sides);
    var cornerR = Math.max(0, Math.min(params.cornerRadius || 0, apothem));
    if (cornerR > 0) {
      var core = polygonShapeBbox(Object.assign({}, params, { radius: (apothem - cornerR) / Math.cos(Math.PI / sides), cornerRadius: 0 }));
      return { minX: core.minX - cornerR, maxX: core.maxX + cornerR, minY: core.minY - cornerR, maxY: core.maxY + cornerR };
    }
    var startAngle = Math.PI / sides - Math.PI / 2 + (params.startAngleDeg || 0) * Math.PI / 180;
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
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  // Spacing between copies when `extent` covers first to last center.
  function patternStep(extent, count) {
    return count > 1 ? extent / (count - 1) : 0;
  }

  // Degrees between circular copies for a Total Angle (see above).
  function circularStep(totalAngle, count) {
    var total = totalAngle == null || totalAngle === '' ? 360 : Number(totalAngle);
    if (Math.abs(total) >= 360) return (total < 0 ? -360 : 360) / count;
    return count > 1 ? total / (count - 1) : 0;
  }

  function patternDescription(p) {
    if (!p || !p.enabled) return '';
    if (p.style === 'linear' || p.style === 'honeycomb') {
      var label = p.style === 'honeycomb' ? 'Honeycomb' : 'Linear';
      var angle = Number(p.angle) || 0;
      var xc = Math.max(1, Math.floor(p.xCount || 1)), yc = Math.max(1, Math.floor(p.yCount || 1));
      var xe = patternAxisExtent(p, 'x'), ye = patternAxisExtent(p, 'y');
      var dims = xe || ye
        ? 'extent ' + (xe ? 'X=' + (p.xDist || 0) : '') + (xe && ye ? ', ' : '') + (ye ? 'Y=' + (p.yDist || 0) : '') +
          '; dX=' + (xe ? parseFloat(patternStep(p.xDist || 0, xc).toFixed(4)) : (p.xDist || 0)) +
          ', dY=' + (ye ? parseFloat(patternStep(p.yDist || 0, yc).toFixed(4)) : (p.yDist || 0))
        : 'dX=' + (p.xDist || 0) + ', dY=' + (p.yDist || 0);
      // Gap mode: the stock asked for between copies, which the spacings give.
      var gaps = [p.xGap != null ? 'X=' + p.xGap : '', p.yGap != null ? 'Y=' + p.yGap : ''].filter(Boolean).join(', ');
      // Overall mode: the edge-to-edge size asked for, which the spacings give.
      var overall = [p.xOverall != null ? 'X=' + p.xOverall : '', p.yOverall != null ? 'Y=' + p.yOverall : ''].filter(Boolean).join(', ');
      return label + ' ' + (p.xCount || 1) + 'x' + (p.yCount || 1) +
             ' (' + dims + (overall ? '; overall ' + overall : '') + (gaps ? '; gap ' + gaps : '') + ')' +
             (angle ? ' angle=' + angle + '°' + (p.rotateShapes ? ' rotated' : '') : '');
    }
    if (p.style === 'grid') {
      var gAngle = Number(p.angle) || 0;
      var gxe = patternAxisExtent(p, 'x'), gye = patternAxisExtent(p, 'y');
      var gDims = (gxe ? 'extent X=' : 'dX=') + (p.xDist || 0) + ', ' + (gye ? (gxe ? 'Y=' : 'extent Y=') : 'dY=') + (p.yDist || 0);
      return 'Grid ' + (p.xCount || 1) + 'x' + (p.yCount || 1) + ' lines (' + gDims + ')' + (gAngle ? ' angle=' + gAngle + '°' : '');
    }
    var follow = p.style === 'circular-follow' || !!p.rotate;
    // Inside / Outside Radius: the edge distance asked for, which r gives.
    var edge = (p.radiusTo === 'inside' || p.radiusTo === 'outside') && p.radiusEdge != null ? ' (' + p.radiusTo + ' ' + p.radiusEdge + ')' : '';
    return 'Circular' + (follow ? ' (Path Direction)' : ' (Identical)') + ' n=' + (p.count || 1) +
           ' r=' + (p.radius || 0) + edge + ' start=' + (p.startAngle || 0) + '°' +
           (p.totalAngle != null && Number(p.totalAngle) !== 360 ? ' total=' + p.totalAngle + '°' : '');
  }

  // === HOLDING TABS =======================================================
  //
  // Tabs leave small bridges of material on the final passes of an
  // inner/outer profile so the part (or drop-out) stays attached.
  //
  // The profile is described as a list of segments along the tool path,
  // in work coordinates (already rotated):
  //   { type: 'line', x0, y0, x1, y1, len }
  //   { type: 'arc',  cx, cy, r, a0, a1, len }   (radians, CCW like G3)
  // On the tool path each tab spans tabWidth + bitDiameter: the cutter
  // takes a radius off each side, which leaves tabWidth of material at
  // the part. A tab may cover the start point (a rectangle's
  // middle-bottom tab does); the tabbed passes then start and end
  // lifted over it.

  // The tab settings to use, or null when tabs are off or don't apply.
  function tabSettings(params) {
    var t = params.tabs;
    if (!t || (params.cutType || 'inner') === 'clearing') return null;
    var count = Math.floor(t.count || 0);
    if (!(count >= 1) || !(t.width > 0) || !(t.height > 0) || !(t.height < params.depth)) return null;
    return { count: count, width: t.width, height: t.height };
  }

  function tabsComment(tabs, unitsLabel) {
    return 'Tabs: ' + tabs.count + ' x ' + tabs.width + unitsLabel + ' wide, ' +
           tabs.height + unitsLabel + ' high';
  }

  // Depths of each pass. With tabTop set, a pass is added at exactly
  // tabTop so the tabs come out at the requested height.
  function depthLevels(depth, depthOfCut, tabTop) {
    var levels = [];
    var current = 0;
    while (current < depth - 1e-6) {
      var next = Math.min(depth, current + depthOfCut);
      if (tabTop != null && current < tabTop - 1e-6 && next > tabTop + 1e-6) levels.push(tabTop);
      levels.push(next);
      current = next;
    }
    return levels;
  }

  // Clearing rings further apart than r * (1 + cos(pi/n)) leave an island
  // between them in each corner (a triangle past 75% stepover, a square
  // past about 85%).
  function clearingRingStep(step, toolRadius, sides) {
    return Math.min(step, toolRadius * (1 + Math.cos(Math.PI / sides)));
  }

  function pushLine(segs, a, b) {
    var len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 1e-9) segs.push({ type: 'line', x0: a.x, y0: a.y, x1: b.x, y1: b.y, len: len });
  }

  // Same path as emitRectanglePath: mid-bottom start, CCW.
  function rectangleSegments(geom) {
    var cx = geom.cx, cy = geom.cy;
    var rot = geom.rotationDeg || 0;
    var xR = cx + geom.halfW, xL = cx - geom.halfW;
    var yT = cy + geom.halfH, yB = cy - geom.halfH;
    var r = geom.cornerR;
    var segs = [];
    var px = cx, py = yB;
    function lineTo(x, y) {
      pushLine(segs, rotatePoint(cx, cy, px, py, rot), rotatePoint(cx, cy, x, y, rot));
      px = x; py = y;
    }
    function arcTo(x, y, ctrX, ctrY, startDeg) {
      var c = rotatePoint(cx, cy, ctrX, ctrY, rot);
      var a0 = (startDeg + rot) * Math.PI / 180;
      segs.push({ type: 'arc', cx: c.x, cy: c.y, r: r, a0: a0, a1: a0 + Math.PI / 2, len: r * Math.PI / 2 });
      px = x; py = y;
    }
    if (r <= 0) {
      lineTo(xR, yB); lineTo(xR, yT); lineTo(xL, yT); lineTo(xL, yB); lineTo(cx, yB);
      return segs;
    }
    var xRt = xR - r, xLt = xL + r, yTt = yT - r, yBt = yB + r;
    lineTo(xRt, yB); arcTo(xR, yBt, xRt, yBt, -90);
    lineTo(xR, yTt); arcTo(xRt, yT, xRt, yTt, 0);
    lineTo(xLt, yT); arcTo(xL, yTt, xLt, yTt, 90);
    lineTo(xL, yBt); arcTo(xLt, yB, xLt, yBt, 180);
    lineTo(cx, yB);
    return segs;
  }

  // Full circle from the rightmost point, CCW (as emitOneCircle cuts it).
  function circleSegments(geom) {
    var r = geom.pathRadius;
    return [{ type: 'arc', cx: geom.cx, cy: geom.cy, r: r, a0: 0, a1: 2 * Math.PI, len: 2 * Math.PI * r }];
  }

  function polygonSegments(geom) {
    if (geom.arcR > 0) return roundedPolygonSegments(geom.cx, geom.cy, geom.coreApothem, geom.arcR, geom.sides, geom.startAngle);
    var verts = polygonVertices(geom.cx, geom.cy, geom.pathRadius, geom.sides, geom.startAngle);
    var segs = [];
    for (var i = 0; i < verts.length; i++) pushLine(segs, verts[i], verts[(i + 1) % verts.length]);
    return segs;
  }

  // Tab spans along the path as [{start, end}] distances. Tabs that
  // would leave no cut between them are dropped, so the result can be
  // shorter than tabs.count (or empty).
  //
  // Evenly spaced tabs can land on a corner, where a tab is weak and
  // awkward to clean up. So each evenly spaced position picks the
  // straight edge it falls on (or the nearest one, from a corner arc),
  // and the tabs on each edge are then spread evenly along it: 4 tabs
  // on a rectangle give one in the middle of each side. A circle has
  // no straight edges and keeps the even spacing, as does any shape
  // whose edges are too short for their tabs.
  // A corner relief move counts as no length for tabs, so relief never
  // moves them (it isn't part of an edge, and adds no distance round).
  function tabLen(seg) { return seg.relief ? 0 : seg.len; }
  function tabIntervals(segs, tabs, bitDiameter) {
    var total = 0;
    for (var i = 0; i < segs.length; i++) total += tabLen(segs[i]);
    var lift = tabs.width + bitDiameter;
    var n = tabs.count;
    while (n > 0 && lift >= total / n) n--;
    var nominal = [];
    for (var k = 0; k < n; k++) nominal.push((k + 0.5) * total / n);
    var centers = (n && tabsOnEdges(segs, nominal, lift, total)) || nominal;
    // A tab across the start point is split into its two ends of the lap.
    var out = [];
    centers.forEach(function(c) {
      var a = c - lift / 2, b = c + lift / 2;
      if (a < 0) out.push({ start: a + total, end: total }, { start: 0, end: b });
      else if (b > total) out.push({ start: a, end: total }, { start: 0, end: b - total });
      else out.push({ start: a, end: b });
    });
    return out.sort(function(x, y) { return x.start - y.start; });
  }

  // Straight runs of the path as { start, end } distances. Collinear
  // neighbours are merged, including the last line into the first when
  // the path starts mid-edge (a rectangle's bottom edge then runs from a
  // negative start, i.e. it wraps through the start point).
  function straightEdges(segs, total) {
    var edges = [];
    var d = 0;
    function dir(s) { return { x: (s.x1 - s.x0) / s.len, y: (s.y1 - s.y0) / s.len }; }
    function collinear(a, b) {
      return Math.abs(a.x * b.y - a.y * b.x) < 1e-6 && a.x * b.x + a.y * b.y > 0;
    }
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.type === 'line' && !s.relief) {
        var last = edges[edges.length - 1];
        if (last && Math.abs(last.end - d) < 1e-9 && collinear(last.dir, dir(s))) {
          last.end += s.len;
        } else {
          edges.push({ start: d, end: d + s.len, dir: dir(s) });
        }
      }
      d += tabLen(s);
    }
    if (edges.length > 1) {
      var first = edges[0], tail = edges[edges.length - 1];
      if (first.start < 1e-9 && Math.abs(tail.end - total) < 1e-9 && collinear(tail.dir, first.dir)) {
        first.start = tail.start - total;
        edges.pop();
      }
    }
    return edges;
  }

  // Tab centers spread along straight edges, or null to keep the even
  // spacing. Each edge gets a share of the tabs by its length (largest
  // remainder); ties go to the edges the evenly spaced positions fall
  // on, so 3 tabs on a hexagon take every other side. Centers can be
  // negative on an edge that wraps through the start point.
  function tabsOnEdges(segs, nominal, lift, total) {
    var edges = straightEdges(segs, total);
    if (!edges.length) return null;
    var hits = edges.map(function() { return 0; });
    nominal.forEach(function(c) {
      var best = -1, bestDist = Infinity;
      for (var e = 0; e < edges.length; e++) {
        // Distance from c to the edge, also trying c one lap back for
        // an edge that wraps through the start.
        var cs = [c, c - total];
        for (var j = 0; j < 2; j++) {
          var dist = Math.max(edges[e].start - cs[j], 0, cs[j] - edges[e].end);
          if (dist < bestDist - 1e-9) { bestDist = dist; best = e; }
        }
      }
      hits[best]++;
    });
    var straight = 0;
    edges.forEach(function(edge) { straight += edge.end - edge.start; });
    var quota = edges.map(function(edge) { return nominal.length * (edge.end - edge.start) / straight; });
    var counts = quota.map(function(q) { return Math.floor(q + 1e-9); });
    var left = nominal.length - counts.reduce(function(a, b) { return a + b; }, 0);
    var order = edges.map(function(edge, i) { return i; }).sort(function(a, b) {
      var rem = (quota[b] - counts[b]) - (quota[a] - counts[a]);
      if (Math.abs(rem) > 1e-9) return rem;
      return (hits[b] - hits[a]) || (a - b);
    });
    for (var o = 0; o < left; o++) counts[order[o]]++;
    var centers = [];
    for (var e = 0; e < edges.length; e++) {
      var k = counts[e];
      var len = edges[e].end - edges[e].start;
      if (!k) continue;
      if (k * lift >= len) return null;
      for (var i = 0; i < k; i++) {
        centers.push(edges[e].start + (i + 0.5) * len / k);
      }
    }
    return centers;
  }

  // toFixed without "-0.000" for values that round to zero.
  function fixed(v, dp) {
    var str = v.toFixed(dp);
    return /^-0\.0*$/.test(str) ? str.slice(1) : str;
  }

  // Emit the part of `seg` from distance s to e along it.
  // Corner relief (params.cornerRelief, Inner cuts on Rectangle and
  // Polygon): a round bit can't reach into a sharp inside corner, so at
  // each corner of a closed lap of straight lines the bit runs out and
  // back far enough for its edge to reach the shape's corner, or the
  // typed Corner Radius when that's smaller than the bit's radius.
  //   dogbone  out along the corner's bisector
  //   tbone    straight on along one edge, so only the other wall is
  //            notched: the longer edge (the more horizontal one, then the
  //            one sloping up to the right, when they're equal). With
  //            pinwheel (Polygon), every edge runs on past its end in the
  //            cut's direction instead, all the way round.
  // Corners are the lap's left turns (laps run CCW).
  function cornerRelief(params) {
    var cut = params.cutType || 'inner', style = params.cornerRelief;
    return (style === 'dogbone' || style === 'tbone') && (cut === 'inner' || cut === 'clearing') &&
      Math.max(0, params.cornerRadius || 0) < (params.bitDiameter || 0) / 2 ? style : null;
  }
  function cornerReliefSegments(segs, style, toolRadius, cornerRadius, pinwheel) {
    var reach = toolRadius - Math.max(0, cornerRadius || 0);
    var n = segs.length, out = [];
    function dir(s) { return { x: (s.x1 - s.x0) / s.len, y: (s.y1 - s.y0) / s.len }; }
    function straightOn(s, t) {
      if (s.type !== 'line' || t.type !== 'line') return false;
      var p = dir(s), q = dir(t);
      return Math.abs(p.x * q.y - p.y * q.x) < 1e-9 && p.x * q.x + p.y * q.y > 0;
    }
    // A whole edge's length, across the lap's start where one is split.
    function edgeLen(k) {
      var len = segs[k].len;
      for (var f = 1; f < n && straightOn(segs[(k + f - 1) % n], segs[(k + f) % n]); f++) len += segs[(k + f) % n].len;
      for (var b = 1; b < n && straightOn(segs[(k - b + n) % n], segs[(k - b + 1 + n) % n]); b++) len += segs[(k - b + n) % n].len;
      return len;
    }
    for (var i = 0; i < n; i++) {
      var a = segs[i], b2 = segs[(i + 1) % n];
      out.push(a);
      if (a.type !== 'line' || b2.type !== 'line' || !(reach > 0)) continue;
      var u = dir(a), v = dir(b2);
      if (u.x * v.y - u.y * v.x < 1e-9) continue;
      // Half the corner's inside angle, from the turn.
      var sinHalf = Math.sqrt((1 + u.x * v.x + u.y * v.y) / 2);
      var cosHalf = Math.sqrt((1 - u.x * v.x - u.y * v.y) / 2);
      var d, m;
      if (style === 'tbone') {
        var la = edgeLen(i), lb = edgeLen((i + 1) % n);
        // Longer edge; then the more horizontal; then the one sloping up to
        // the right, so the choice doesn't depend on the lap's direction.
        var alongIn = pinwheel ? true : Math.abs(la - lb) > 1e-9 ? la > lb
          : Math.abs(Math.abs(u.x) - Math.abs(v.x)) > 1e-9 ? Math.abs(u.x) > Math.abs(v.x)
          : u.x * u.y > 0;
        d = reach * cosHalf / sinHalf;
        m = alongIn ? u : { x: -v.x, y: -v.y };
      } else {
        d = reach * (1 / sinHalf - 1);
        var bx = u.x - v.x, by = u.y - v.y, bl = Math.hypot(bx, by);
        if (!(bl > 1e-9)) continue;
        m = { x: bx / bl, y: by / bl };
      }
      if (!(d > 1e-6)) continue;
      var corner = { x: a.x1, y: a.y1 }, tip = { x: a.x1 + m.x * d, y: a.y1 + m.y * d };
      // Marked, so tabs aren't placed by them: a T-bone runs on in line
      // with its edge and would otherwise count as part of it.
      pushLine(out, corner, tip);
      out[out.length - 1].relief = true;
      pushLine(out, tip, corner);
      out[out.length - 1].relief = true;
    }
    return out;
  }

  function emitSegmentPiece(lines, seg, s, e, feedSuffix) {
    if (seg.type === 'line') {
      var f = e / seg.len;
      lines.push('G1 X' + fixed(seg.x0 + (seg.x1 - seg.x0) * f, xyDp) +
                 ' Y' + fixed(seg.y0 + (seg.y1 - seg.y0) * f, xyDp) + feedSuffix);
      return;
    }
    // dir -1: a clockwise arc (angles decrease), written as G2.
    var sg = seg.dir === -1 ? -1 : 1;
    var as = seg.a0 + sg * s / seg.r, ae = seg.a0 + sg * e / seg.r;
    var sx = seg.cx + seg.r * Math.cos(as), sy = seg.cy + seg.r * Math.sin(as);
    lines.push((sg < 0 ? 'G2' : 'G3') + ' X' + fixed(seg.cx + seg.r * Math.cos(ae), 5) +
               ' Y' + fixed(seg.cy + seg.r * Math.sin(ae), 5) +
               ' I' + fixed(seg.cx - sx, 5) + ' J' + fixed(seg.cy - sy, 5) + feedSuffix);
  }

  // One lap of the path at cutZ, rising to tabZ over each tab. The lap
  // makes its own entry plunge at the start point: to cutZ, or only to
  // tabZ when a tab covers the start (the lap then also ends lifted).
  function emitTabbedLap(lines, segs, intervals, cutZ, tabZ, feedRate, plungeFeedRate) {
    var dist = 0;
    var inTab = null;
    var needFeed = true;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var cuts = [0, seg.len];
      for (var j = 0; j < intervals.length && !seg.relief; j++) {
        var edges = [intervals[j].start - dist, intervals[j].end - dist];
        for (var k = 0; k < 2; k++) {
          if (edges[k] > 1e-9 && edges[k] < seg.len - 1e-9) cuts.push(edges[k]);
        }
      }
      cuts.sort(function(a, b) { return a - b; });
      for (var c = 0; c < cuts.length - 1; c++) {
        var s = cuts[c], e = cuts[c + 1];
        if (e - s < 1e-9) continue;
        var mid = dist + tabLen(seg) * (s + e) / 2 / seg.len;
        var tab = false;
        for (var t = 0; t < intervals.length; t++) {
          if (mid > intervals[t].start && mid < intervals[t].end) tab = true;
        }
        if (tab !== inTab) {
          lines.push('G1 Z' + (tab ? tabZ : cutZ).toFixed(3) + ' F' + plungeFeedRate + (tab ? ' ; Tab' : ''));
          inTab = tab;
          needFeed = true;
        }
        emitSegmentPiece(lines, seg, s, e, needFeed ? ' F' + feedRate : '');
        needFeed = false;
      }
      dist += tabLen(seg);
    }
  }

  // Header comment and warning lines for a profile's tabs.
  function tabHeaderNotes(params, segs, extras) {
    var tabs = tabSettings(params);
    if (!tabs) return [];
    extras.push(tabsComment(tabs, isImperial ? 'inch' : 'mm'));
    var fit = tabIntervals(segs, tabs, params.bitDiameter).length;
    if (fit >= tabs.count) return [];
    return [fit
      ? '(WARNING: only ' + fit + ' of ' + tabs.count + ' tabs fit; using ' + fit + ')'
      : '(WARNING: tabs too wide for this path; no tabs cut)'];
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
  // Origin on a corner of the first copy ('corner:N', 1-based in cut
  // order) or the shape's own center ('shape-center'), as picked by
  // tapping the Rectangle / Polygon preview. A corner is where the two
  // edges meet, even when the corners are rounded (the point found by
  // probing two edges). Any other origin is a point of the pattern's
  // box, as before. A corner the shape no longer has falls back to
  // center.
  function resolveShapeOrigin(params, positions, bbox, corners) {
    var origin = params.origin || 'center';
    var p0 = positions[0];
    if (origin === 'shape-center') return { shift: { x: -p0.x, y: -p0.y }, label: 'shape center' };
    var m = /^corner:(\d+)$/.exec(origin);
    var note = '';
    if (m) {
      var c = corners(p0.rotDeg || 0)[+m[1] - 1];
      if (c) return { shift: { x: -(p0.x + c.x), y: -(p0.y + c.y) }, label: 'corner ' + m[1] };
      origin = 'center';
      note = ' (picked corner not on shape)';
    }
    return { shift: computePatternAnchorShift(origin, positions, bbox, params.inset), label: origin + note + insetNote(origin, params.inset) };
  }

  // A copy's corners about its own center, for a turn of rot degrees
  // (the pattern's turn; Rectangle's Start Angle is already in it).
  // Rectangle: front-left, front-right, back-right, back-left (CCW,
  // before turning), then the middles of the front, right, back and left
  // edges (corner:5-8). Polygon: its vertices in cut order.
  function rectangleCorners(params) {
    return function(rot) {
      var w = params.width / 2, h = params.height / 2;
      return [[-w, -h], [w, -h], [w, h], [-w, h], [0, -h], [w, 0], [0, h], [-w, 0]]
        .map(function(c) { return rotatePoint(0, 0, c[0], c[1], rot); });
    };
  }
  // Circle: the box points of the first copy, numbered as Rectangle's
  // (corners, then edge middles), so they can be X0 Y0 with a pattern on.
  function circleCorners(params) {
    return function() {
      var r = params.diameter / 2;
      return [[-r, -r], [r, -r], [r, r], [-r, r], [0, -r], [r, 0], [0, r], [-r, 0]]
        .map(function(c) { return { x: c[0], y: c[1] }; });
    };
  }
  // Keyhole: the same points of the box around the first keyhole, about
  // its plunge hole, then that box's center (corner:9).
  function keyholeCorners(params) {
    return function(rot) {
      var b = keyholeBbox(params, (params.startAngleDeg || 0) + rot);
      var mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
      return [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY],
              [mx, b.minY], [b.maxX, my], [mx, b.maxY], [b.minX, my], [mx, my]]
        .map(function(c) { return { x: c[0], y: c[1] }; });
    };
  }
  function polygonCorners(params) {
    return function(rot) {
      var radius = params.radius != null ? params.radius : (params.diameter || 0) / 2;
      var sides = Math.max(3, Math.min(12, Math.floor(params.sides || 6)));
      var start = Math.PI / sides - Math.PI / 2 + ((params.startAngleDeg || 0) + rot) * Math.PI / 180;
      return polygonVertices(0, 0, radius, sides, start);
    };
  }

  // Where X0 Y0 sits relative to the first copy's center (Keyhole: its
  // plunge hole), in machine units, worked out exactly as the program
  // does. The previews draw their origin crosshair from it.
  function shapeOriginOffset(shape, params) {
    var positions = computePatternPositions(params.pattern);
    var shift;
    if (shape === 'rectangle') {
      positions = withShapeTurn(positions, params.startAngleDeg);
      shift = resolveShapeOrigin(params, positions, rectangleShapeBbox(params), rectangleCorners(params)).shift;
    } else if (shape === 'polygon') {
      shift = resolveShapeOrigin(params, positions, polygonShapeBbox(params), polygonCorners(params)).shift;
    } else if (shape === 'circle') {
      shift = resolveShapeOrigin(params, positions, circleShapeBbox(params), circleCorners(params)).shift;
    } else if (shape === 'slot') {
      var cl = slotCenterline(params);
      if (slotProblem(params, cl, slotHalfWidth(params))) return { x: 0, y: 0 };
      var op = slotOriginParts(params, cl);
      shift = resolveShapeOrigin(params, positions, op.bbox, op.corners).shift;
    } else if (shape === 'keyhole') {
      var startDeg = params.startAngleDeg || 0;
      shift = (params.origin || 'hole') === 'hole' ? { x: 0, y: 0 } : resolveKeyholeOrigin(params, positions).shift;
    } else {
      return { x: 0, y: 0 };
    }
    return { x: -shift.x - positions[0].x, y: -shift.y - positions[0].y };
  }

  // On an inner or clearing cut a corner can't be tighter than the bit's
  // own radius; when the typed Corner Radius is smaller, the header says
  // what the bit leaves. The path itself is unchanged (sharp, so the bit
  // rounds the corner).
  function bitCornerNote(params, unitsLabel) {
    var cut = params.cutType || 'inner';
    var bitR = (params.bitDiameter || 0) / 2;
    if ((cut !== 'inner' && cut !== 'clearing') || !(bitR > (params.cornerRadius || 0))) return '';
    var relief = cornerRelief(params);
    if (relief) return relief === 'tbone' ? ', T-bone corners' : ', dog-bone corners';
    return ' (the bit leaves ' + parseFloat(bitR.toFixed(4)) + unitsLabel + ')';
  }

  // Rectangle Start Angle: every copy is turned by `deg` about its own
  // center, on top of any turn the pattern gives it. The emitters,
  // tabs and anchor shift already handle a per-copy rotation.
  function withShapeTurn(positions, deg) {
    var turn = Number(deg) || 0;
    if (!turn) return positions;
    return positions.map(function(p) {
      return { x: p.x, y: p.y, rotDeg: (p.rotDeg || 0) + turn };
    });
  }

  function generateRectangleProgram(params) {
    if ((params.cutType || 'inner') === 'clearing') {
      return generateRectangleClearingProgram(params);
    }
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = withShapeTurn(computePatternPositions(params.pattern), params.startAngleDeg);
    var baseGeom = computeRectangleGeom(params);

    var extras = [
      'Size: ' + params.width + unitsLabel + ' x ' + params.height + unitsLabel,
      'Corner Radius: ' + (params.cornerRadius || 0) + unitsLabel + bitCornerNote(params, unitsLabel) +
        (Number(params.startAngleDeg) ? ', Start Angle: ' + Number(params.startAngleDeg) + '°' : ''),
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Origin: ' + resolveShapeOrigin(params, positions, rectangleShapeBbox(params), rectangleCorners(params)).label
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));
    var tabNotes = tabHeaderNotes(params, rectangleSegments(baseGeom), extras);

    var lines = programHeader(params, {
      shapeLabel: 'Rectangle' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.halfW <= 0 || baseGeom.halfH <= 0) {
      lines.push('(WARNING: shape smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, tabNotes);
    lines.push.apply(lines, startupBlock(params));

    // Origin is applied to the WHOLE pattern's aggregate bounding box,
    // not to each instance individually — see computePatternAnchorShift.
    var shift = resolveShapeOrigin(params, positions, rectangleShapeBbox(params), rectangleCorners(params)).shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + rotStr + ')');
      }
      emitOneRectangle(lines, params, mx, my, pos.rotDeg);
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
    lines.push('G0 X' + startX.toFixed(xyDp) + ' Y' + startY.toFixed(xyDp));
    var safeHeight = safeHopDelta.toFixed(3);
    lines.push('G0 Z' + safeHeight);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    lines.push('G0 Z' + slowPlungeStart);

    var tabs = tabSettings(params);
    var bones = cornerRelief(params) && geom.cornerR <= 0
      ? cornerReliefSegments(rectangleSegments(geom), cornerRelief(params), geom.toolRadius, params.cornerRadius) : null;
    var segs = tabs ? (bones || rectangleSegments(geom)) : null;
    var intervals = tabs ? tabIntervals(segs, tabs, params.bitDiameter) : [];
    var tabTop = intervals.length ? depth - tabs.height : null;

    var levels = depthLevels(depth, depthOfCut, tabTop);
    for (var i = 0; i < levels.length; i++) {
      if (tabTop != null && levels[i] > tabTop + 1e-6) {
        emitTabbedLap(lines, segs, intervals, -levels[i], -tabTop, feedRate, plungeFeedRate);
        continue;
      }
      lines.push('G1 Z' + (-levels[i]).toFixed(3) + ' F' + plungeFeedRate);
      if (bones) emitSegmentLap(lines, bones, feedRate);
      else emitRectanglePath(lines, geom, feedRate);
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
    var positions = withShapeTurn(computePatternPositions(params.pattern), params.startAngleDeg);
    var baseGeom = computeRectangleGeom(params);
    var stepoverPct = params.stepoverPct || 40;
    var step = params.bitDiameter * (stepoverPct / 100);

    var extras = [
      'Size: ' + params.width + unitsLabel + ' x ' + params.height + unitsLabel,
      'Corner Radius: ' + (params.cornerRadius || 0) + unitsLabel + bitCornerNote(params, unitsLabel) +
        (Number(params.startAngleDeg) ? ', Start Angle: ' + Number(params.startAngleDeg) + '°' : ''),
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Stepover: ' + stepoverPct + '% (' + step.toFixed(3) + unitsLabel + ')',
      'Entry: helical bore then expanding outward',
      'Origin: ' + resolveShapeOrigin(params, positions, rectangleShapeBbox(params), rectangleCorners(params)).label
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

    var shift = resolveShapeOrigin(params, positions, rectangleShapeBbox(params), rectangleCorners(params)).shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + rotStr + ')');
      }
      emitOneRectangleClearing(lines, params, mx, my, step, pos.rotDeg);
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
    var ringStep = clearingRingStep(step, base.toolRadius, 4);
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
      // A last level that would close up leaves the middle a bit radius in.
      var shortHalf = Math.min(hW, hH);
      offset += shortHalf - ringStep <= 1e-9 && shortHalf - base.toolRadius > 1e-9 ? shortHalf - base.toolRadius : ringStep;
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

    lines.push('G0 X' + helixStartX.toFixed(xyDp) + ' Y' + helixStartY.toFixed(xyDp));
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
        lines.push('G1 X' + innerStart.x.toFixed(xyDp) + ' Y' + innerStart.y.toFixed(xyDp) +
                   ' F' + plungeFeedRate);

        for (var i = 0; i < levels.length; i++) {
          var lvl = levels[i];
          if (i === levels.length - 1 && cornerRelief(params) && lvl.cornerR <= 0) {
            emitSegmentLap(lines, cornerReliefSegments(rectangleSegments(lvl), cornerRelief(params), base.toolRadius, params.cornerRadius), feedRate);
          } else {
            emitRectanglePath(lines, lvl, feedRate);
          }
          if (i < levels.length - 1) {
            var next = levels[i + 1];
            var nextStart = rotatePoint(next.cx, next.cy,
                                        next.cx, next.cy - next.halfH,
                                        next.rotationDeg || 0);
            lines.push('G1 X' + nextStart.x.toFixed(xyDp) + ' Y' + nextStart.y.toFixed(xyDp) +
                       ' F' + plungeFeedRate);
          }
        }
      }

      prevZ = targetZ;
      currentDepth = nextDepth;

      if (currentDepth < depth - 1e-6) {
        lines.push('G0 X' + helixStartX.toFixed(xyDp) + ' Y' + helixStartY.toFixed(xyDp));
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
    var toolRadius = params.bitDiameter / 2;

    var pathRadius;
    if (cutType === 'inner' || cutType === 'clearing') {
      pathRadius = diameter / 2 - toolRadius;
    } else {
      pathRadius = diameter / 2 + toolRadius;
    }

    // Origin is handled by the pattern loop via computePatternAnchorShift;
    // this fn just centers the shape at the passed offset.
    return {
      cx: (offsetX || 0), cy: (offsetY || 0),
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

    var placed = resolveShapeOrigin(params, positions, circleShapeBbox(params), circleCorners(params));
    var extras = [
      'Diameter: ' + params.diameter + unitsLabel,
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Origin: ' + placed.label
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));
    var tabNotes = tabHeaderNotes(params, circleSegments(baseGeom), extras);

    var lines = programHeader(params, {
      shapeLabel: 'Circle' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.pathRadius <= 0) {
      lines.push('(WARNING: circle smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, tabNotes);
    lines.push.apply(lines, startupBlock(params));

    var shift = placed.shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + ')');
      }
      emitOneCircle(lines, params, mx, my);
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
    lines.push('G0 X' + (cx + pathRadius).toFixed(xyDp) + ' Y' + cy.toFixed(xyDp));
    var safeHeight = safeHopDelta.toFixed(3);
    lines.push('G0 Z' + safeHeight);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    lines.push('G0 Z' + slowPlungeStart);

    // Helical descent: each revolution = two semicircles descending by
    // DOC/2 each. This is a CUTTING motion (spiraling around the
    // perimeter while descending) so it uses the cutting feed rate, not
    // plunge rate — plunge rate is reserved for straight-Z entries.
    // With tabs, the helix stops at the top of the tabs; the passes
    // below that are flat tabbed laps entered by a plunge at the start.
    var tabs = tabSettings(params);
    var segs = tabs ? circleSegments(geom) : null;
    var intervals = tabs ? tabIntervals(segs, tabs, params.bitDiameter) : [];
    var tabTop = intervals.length ? depth - tabs.height : null;
    var levels = depthLevels(depth, depthOfCut, tabTop);

    var prevZ = parseFloat(slowPlungeStart);
    for (var i = 0; i < levels.length; i++) {
      if (tabTop != null && levels[i] > tabTop + 1e-6) break;
      var targetZ = -levels[i];
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
    }

    // Final cleanup full-circle at target Z — removes spiral marks from
    // the descending pass.
    lines.push('G3 X' + (cx - pathRadius).toFixed(5) + ' Y' + cy.toFixed(5) +
               ' I' + (-pathRadius).toFixed(5) + ' J0 F' + feedRate);
    lines.push('G3 X' + (cx + pathRadius).toFixed(5) + ' Y' + cy.toFixed(5) +
               ' I' + pathRadius.toFixed(5) + ' J0');

    for (; i < levels.length; i++) {
      emitTabbedLap(lines, segs, intervals, -levels[i], -tabTop, feedRate, plungeFeedRate);
    }

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

    var placed = resolveShapeOrigin(params, positions, circleShapeBbox(params), circleCorners(params));
    var extras = [
      'Diameter: ' + params.diameter + unitsLabel,
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Stepover: ' + stepoverPct + '% (' + step.toFixed(3) + unitsLabel + ')',
      'Entry: helical bore then expanding outward',
      'Origin: ' + placed.label
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

    var shift = placed.shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + ')');
      }
      emitOneCircleClearing(lines, params, mx, my, step);
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

    lines.push('G0 X' + helixStartX.toFixed(xyDp) + ' Y' + cy.toFixed(xyDp));
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
        lines.push('G1 X' + (cx + radii[0]).toFixed(xyDp) + ' Y' + cy.toFixed(xyDp) +
                   ' F' + plungeFeedRate);
        for (var i = 0; i < radii.length; i++) {
          var rr = radii[i];
          // Full circle at Z = targetZ, as two semicircles.
          lines.push('G3 X' + (cx - rr).toFixed(5) + ' Y' + cy.toFixed(5) +
                     ' I' + (-rr).toFixed(5) + ' J0 F' + feedRate);
          lines.push('G3 X' + (cx + rr).toFixed(5) + ' Y' + cy.toFixed(5) +
                     ' I' + rr.toFixed(5) + ' J0');
          if (i < radii.length - 1) {
            lines.push('G1 X' + (cx + radii[i + 1]).toFixed(xyDp) + ' Y' + cy.toFixed(xyDp) +
                       ' F' + plungeFeedRate);
          }
        }
      }

      prevZ = targetZ;
      currentDepth = nextDepth;

      if (currentDepth < depth - 1e-6) {
        lines.push('G0 X' + helixStartX.toFixed(xyDp) + ' Y' + cy.toFixed(xyDp));
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

    // Wasteboard: the front-left corner of the machine's travel. That's
    // machine 0,0 when homing sets the origin there (travel runs 0…$130),
    // or -$130,-$131 on machines whose coordinates run negative, which
    // travelMin gives; without it, 0,0 as before.
    var bl = isWasteboard && params.travelMin
      ? { x: params.travelMin.x, y: params.travelMin.y }
      : regionBottomLeft(params.origin || 'front-left', width, height);
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
    // Wasteboard: leave out ncSender Pro's keepout zone (machine
    // coordinates, like this mode's), widened by the bit radius so the
    // cutter's edge stays out of it. What's left is up to four
    // rectangles, each surfaced in turn on every pass.
    // Each zone (ncSender's, the ATCi's) is taken out of what's left of
    // the last; keepoutsHit are those that removed something.
    var keepouts = isWasteboard && params.keepouts ? params.keepouts : [];
    var areas = [{ x: startX, y: startY, w: cutW, h: cutH }];
    var keepoutsHit = [];
    keepouts.forEach(function(k) {
      var next = [];
      areas.forEach(function(a) { next = next.concat(subtractKeepout(a, k, bitDiameter / 2)); });
      if (next.length !== areas.length || next.some(function(a, i) { return a !== areas[i]; })) keepoutsHit.push(k);
      areas = next;
    });

    var modeLabels = { depth: 'Target Depth', thickness: 'Target Thickness', wasteboard: 'Wasteboard Surfacing' };
    var extras = [
      'Mode: ' + (modeLabels[mode] || mode),
      'Region: ' + width + ' x ' + height + ' ' + unitsLabel
    ];
    if (isWasteboard) {
      extras.push('Machine coordinates — set G54 origin to machine zero (0,0,0) before running');
      if (bl.x || bl.y) {
        extras.push('Machine travel: X ' + bl.x + ' to ' + +(bl.x + width).toFixed(4) + ', Y ' + bl.y + ' to ' + +(bl.y + height).toFixed(4) + ' ' + unitsLabel);
      }
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
    keepoutsHit.forEach(function(k) {
      extras.push('Keepout zone left out: ' + (k.name ? k.name + ', ' : '') + 'X ' + k.minX + '-' + k.maxX +
                  ', Y ' + k.minY + '-' + k.maxY + unitsLabel + ' plus the bit radius');
    });
    if (keepoutsHit.length) extras.push('Surfacing ' + areas.length + ' area' + (areas.length === 1 ? '' : 's') + ' around the keepout');
    // A zone that's on but outside the surfacing area, e.g. on a machine
    // whose coordinates run negative, removes nothing; say so rather than
    // let it look avoided.
    keepouts.forEach(function(k) {
      if (keepoutsHit.indexOf(k) >= 0) return;
      extras.push('Keepout zone outside the surfacing area, not avoided: ' + (k.name ? k.name + ', ' : '') + 'X ' + k.minX + '-' + k.maxX +
                  ', Y ' + k.minY + '-' + k.maxY + unitsLabel);
    });
    extras.push('Origin: ' + (params.origin || 'front-left'));

    var lines = programHeader(params, {
      shapeLabel: 'Planer' + (isThickness ? ' (thickness)' : isWasteboard ? ' (wasteboard)' : ''),
      extraComments: extras
    });

    if (bitDiameter <= 0 || stepoverDist <= 0 || cutW <= 0 || cutH <= 0 || !areas.length) {
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
      for (var ai = 0; ai < areas.length; ai++) {
        var a = areas[ai];
        // Around a keepout, the move to the next area would cross the zone
        // at the surface hop height, low enough to hit a tool rack there,
        // so lift to machine safe Z first (the startup block already did
        // for the first area).
        if (keepoutsHit.length && (ai > 0 || currentDepth > 0)) lines.push(machineSafeZLine(params));
        lines.push('G0 X' + a.x.toFixed(xyDp) + ' Y' + a.y.toFixed(xyDp));
        lines.push('G0 Z' + safeHopWork);
        // In thickness mode approach plunge from just above the previous
        // surface (or slowPlungeStart above workpiece top, whichever is
        // lower). Simpler: just G0 to a safe-approach Z above the target.
        var approachZ = isThickness
          ? (startingThickness - currentDepth + 0.5).toFixed(3)
          : (parseFloat(slowPlungeStart) - currentDepth).toFixed(3);   // depth mode: just above the previous pass's floor
        lines.push('G0 Z' + approachZ);
        lines.push('G1 Z' + z.toFixed(3) + ' F' + plungeFeedRate);
        emitPlanerLap(lines, pattern, a.x, a.y, a.w, a.h, stepoverDist, feedRate);
        lines.push('G0 Z' + safeHopWork);
      }
      currentDepth = nextDepth;
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  // The surfacing area (tool-centre box) minus a keepout box widened by
  // r: what's in front of and behind the zone runs the full width, what's
  // beside it only the zone's depth. A zone clear of the area changes
  // nothing.
  function subtractKeepout(a, k, r) {
    var x0 = a.x, y0 = a.y, x1 = a.x + a.w, y1 = a.y + a.h;
    var kx0 = k.minX - r, ky0 = k.minY - r, kx1 = k.maxX + r, ky1 = k.maxY + r;
    if (kx0 >= x1 || kx1 <= x0 || ky0 >= y1 || ky1 <= y0) return [a];
    var out = [];
    function add(ax0, ay0, ax1, ay1) {
      if (ax1 - ax0 > 1e-6 && ay1 - ay0 > 1e-6) out.push({ x: ax0, y: ay0, w: ax1 - ax0, h: ay1 - ay0 });
    }
    var my0 = Math.max(y0, ky0), my1 = Math.min(y1, ky1);
    add(x0, y0, x1, my0);
    add(x0, my0, Math.min(x1, kx0), my1);
    add(Math.max(x0, kx1), my0, x1, my1);
    add(x0, my1, x1, y1);
    return out;
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
        lines.push('G1 X' + xEnd.toFixed(xyDp) + ' F' + feedRate);
      } else {
        var x = Math.min(startX + p * step, startX + cutW);
        if (p > 0) lines.push('G1 X' + x.toFixed(xyDp) + ' F' + feedRate);
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
      lines.push('G1 X' + right.toFixed(xyDp) + ' Y' + bottom.toFixed(xyDp) + ' F' + feedRate);
      curX = right; curY = bottom;
      bottom += effStep; if (bottom >= top) break;
      lines.push('G1 X' + curX.toFixed(xyDp) + ' Y' + top.toFixed(xyDp) + ' F' + feedRate);
      curY = top;
      right -= effStep; if (left >= right) break;
      lines.push('G1 X' + left.toFixed(xyDp) + ' Y' + curY.toFixed(xyDp) + ' F' + feedRate);
      curX = left;
      top -= effStep; if (bottom >= top) break;
      lines.push('G1 X' + curX.toFixed(xyDp) + ' Y' + bottom.toFixed(xyDp) + ' F' + feedRate);
      curY = bottom;
      left += effStep; if (left >= right) break;
      lines.push('G1 X' + left.toFixed(xyDp) + ' Y' + curY.toFixed(xyDp) + ' F' + feedRate);
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
  // Cut direction, with the spindle clockwise (M3):
  //   conventional — material on the left of the bit's travel, so each
  //                  tooth's chip starts thin (as G42 with M3)
  //   climb        — material on the right, chips start thick (G41)
  //   both         — strokes alternate, conventional first, each starting
  //                  where the last ended (no trip back)
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

    // Feed start/end along feed axis (with overrun both ends). The
    // material is on the stepDir side; conventional keeps it on the left
    // of the travel: +X when it's at +Y, -Y when it's at +X.
    var feedStart = -overrun;
    var feedEnd = length + overrun;
    var plusIsConventional = feedAxis === 'x' ? stepDir > 0 : stepDir < 0;
    if ((cutDirection === 'climb') === plusIsConventional) {
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
    var stroke = 0;
    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var z = -nextDepth;
      lines.push('(Pass Z' + z.toFixed(3) + ')');
      for (var i = 0; i < numTrims; i++) {
        var stepOffset = i * trimWidth * stepDir;
        // Both Ways: every other stroke runs back, from where the last ended.
        var back = cutDirection === 'both' && stroke++ % 2 === 1;
        var a = back ? feedEnd : feedStart, b = back ? feedStart : feedEnd;
        var fromX, fromY, toX, toY;
        if (feedAxis === 'x') {
          fromX = a; fromY = stepOffset;
          toX = b;   toY = stepOffset;
        } else {
          fromX = stepOffset; fromY = a;
          toX = stepOffset;   toY = b;
        }
        lines.push('(Trim ' + (i + 1) + '/' + numTrims + ')');
        lines.push('G0 X' + fromX.toFixed(xyDp) + ' Y' + fromY.toFixed(xyDp));
        lines.push('G0 Z' + safeHeight);
        // Rapid to just above the floor the previous pass left: this spot
        // is already cut that deep, so only the new step is plunged slowly.
        lines.push('G0 Z' + (parseFloat(slowPlungeStart) - currentDepth).toFixed(3));
        lines.push('G1 Z' + z.toFixed(3) + ' F' + plungeFeedRate);
        lines.push('G1 X' + toX.toFixed(xyDp) + ' Y' + toY.toFixed(xyDp) + ' F' + feedRate);
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
    // Feed positions along feed axis: 0 → cuttingLength, or back. The cut
    // is a full slot; Cut Direction is for the kept piece's edge, on the
    // origin side of the bit. With the spindle clockwise (M3) conventional
    // keeps that piece on the left of the travel: -X from a front origin,
    // +Y from a left one, the other way from back / right. Both Ways
    // alternates the depth passes, conventional first.
    var feedFrom = 0;
    var feedTo = cuttingLength;
    var plusIsConventional = feedAxis === 'x' ? perpDir < 0 : perpDir > 0;
    if ((cutDirection === 'climb') === plusIsConventional) {
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

    // Both Ways: every other pass runs back, from where the last ended.
    var pass = 0;
    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      var z = -nextDepth;
      var back = cutDirection === 'both' && pass++ % 2 === 1;
      var a = back ? feedTo : feedFrom, b = back ? feedFrom : feedTo;
      var fromX, fromY, toX, toY;
      if (feedAxis === 'x') {
        // Feed along X, cut line at Y = cutPos.
        fromX = a; toX = b; fromY = cutPos; toY = cutPos;
      } else {
        // Feed along Y, cut line at X = cutPos.
        fromY = a; toY = b; fromX = cutPos; toX = cutPos;
      }
      lines.push('(Pass Z' + z.toFixed(3) + ')');
      lines.push('G0 X' + fromX.toFixed(xyDp) + ' Y' + fromY.toFixed(xyDp));
      lines.push('G0 Z' + safeHeight);
      // Rapid to just above the floor the previous pass left: this spot
      // is already cut that deep, so only the new step is plunged slowly.
      lines.push('G0 Z' + (parseFloat(slowPlungeStart) - currentDepth).toFixed(3));
      lines.push('G1 Z' + z.toFixed(3) + ' F' + plungeFeedRate);
      lines.push('G1 X' + toX.toFixed(xyDp) + ' Y' + toY.toFixed(xyDp) + ' F' + feedRate);
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
    var toolRadius = params.bitDiameter / 2;
    var apothem = radius * Math.cos(Math.PI / sides);

    var shrinkInward = (cutType === 'inner' || cutType === 'clearing');
    var newApothem = shrinkInward ? apothem - toolRadius : apothem + toolRadius;
    var pathRadius = newApothem / Math.cos(Math.PI / sides);

    var startDeg = (params.startAngleDeg || 0) + (extraRotDeg || 0);
    var startAngle = Math.PI / sides - Math.PI / 2 + startDeg * Math.PI / 180;

    // Corner Radius (on the part): each corner is an arc tangent to both
    // edges. The arc centers are the vertices of a smaller "core" polygon
    // whose apothem is the part's minus the radius, and the tool path is
    // that core grown by (tool path apothem - core apothem). When that is
    // 0 or less (an inner cut whose corner radius is no bigger than the
    // bit's) the sharp path stays: the bit rounds the corner itself.
    var cornerR = Math.max(0, Math.min(params.cornerRadius || 0, apothem));
    var coreApothem = apothem - cornerR;
    var arcR = cornerR > 0 ? newApothem - coreApothem : 0;

    // Origin is handled by the pattern loop via computePatternAnchorShift;
    // this fn just centers the polygon at the passed offset.
    return {
      cx: (offsetX || 0),
      cy: (offsetY || 0),
      pathRadius: pathRadius,
      sides: sides,
      toolRadius: toolRadius,
      startAngle: startAngle,
      cornerR: cornerR,
      coreApothem: coreApothem,
      arcR: arcR > 1e-9 ? arcR : 0
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

  // A rounded polygon path, CCW, starting where vertex 0's corner arc
  // begins: an arc of radius arcR about each core vertex (spanning the
  // corner's 360/sides degrees), then a straight edge to the next arc.
  function roundedPolygonSegments(cx, cy, coreApothem, arcR, sides, startAngle) {
    var half = Math.PI / sides;
    var core = polygonVertices(cx, cy, coreApothem / Math.cos(half), sides, startAngle);
    var segs = [];
    function at(i, a) { return { x: core[i].x + arcR * Math.cos(a), y: core[i].y + arcR * Math.sin(a) }; }
    for (var i = 0; i < sides; i++) {
      var theta = startAngle + i * 2 * half;
      segs.push({ type: 'arc', cx: core[i].x, cy: core[i].y, r: arcR,
                  a0: theta - half, a1: theta + half, len: arcR * 2 * half });
      pushLine(segs, at(i, theta + half), at((i + 1) % sides, theta + half));
    }
    return segs;
  }

  // Start point of a segment path.
  function segmentStart(seg) {
    return seg.type === 'line' ? { x: seg.x0, y: seg.y0 }
      : { x: seg.cx + seg.r * Math.cos(seg.a0), y: seg.cy + seg.r * Math.sin(seg.a0) };
  }

  // One full lap of a segment path at the current Z. Line ends are
  // written at 5 decimals like the arcs, since each one is where an arc
  // starts (see the note at the top of the file).
  function emitSegmentLap(lines, segs, feedRate) {
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i], feed = i === 0 ? ' F' + feedRate : '';
      if (seg.type === 'line') lines.push('G1 X' + fixed(seg.x1, 5) + ' Y' + fixed(seg.y1, 5) + feed);
      else emitSegmentPiece(lines, seg, 0, seg.len, feed);
    }
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
      'Diameter: ' + (params.sizeMode === 'flats' || params.sizeMode === 'edge'
        ? parseFloat(polyDiameter.toFixed(4)) + unitsLabel + ' (circumscribed; ' + params.sizeValue + unitsLabel +
          (params.sizeMode === 'flats' ? ' across flats)' : ' edge length)')
        : polyDiameter + unitsLabel + ' (circumscribed)'),
      'Start Angle: ' + (params.startAngleDeg || 0) + '°' +
        (baseGeom.cornerR > 0 || bitCornerNote(params, unitsLabel)
          ? ', Corner Radius: ' + baseGeom.cornerR + unitsLabel + bitCornerNote(params, unitsLabel) : ''),
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Origin: ' + resolveShapeOrigin(params, positions, polygonShapeBbox(params), polygonCorners(params)).label
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));
    var tabNotes = tabHeaderNotes(params, polygonSegments(baseGeom), extras);

    var lines = programHeader(params, {
      shapeLabel: 'Polygon (' + baseGeom.sides + '-sided)' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (baseGeom.pathRadius <= 0) {
      lines.push('(WARNING: polygon smaller than tool diameter; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, tabNotes);
    lines.push.apply(lines, startupBlock(params));

    var shift = resolveShapeOrigin(params, positions, polygonShapeBbox(params), polygonCorners(params)).shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + rotStr + ')');
      }
      var geom = computePolygonGeom(params, mx, my, pos.rotDeg);
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

    var rounded = geom.arcR > 0;
    var roundSegs = rounded ? polygonSegments(geom) : null;
    if (rounded) {
      var start = segmentStart(roundSegs[0]);
      lines.push('G0 X' + fixed(start.x, 5) + ' Y' + fixed(start.y, 5));
    } else {
      lines.push('G0 X' + verts[0].x.toFixed(xyDp) + ' Y' + verts[0].y.toFixed(xyDp));
    }
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + slowPlungeStart);

    var tabs = tabSettings(params);
    var bones = !rounded && cornerRelief(params) ? cornerReliefSegments(polygonSegments(geom), cornerRelief(params), geom.toolRadius, params.cornerRadius, true) : null;
    var segs = tabs ? (roundSegs || bones || polygonSegments(geom)) : null;
    var intervals = tabs ? tabIntervals(segs, tabs, params.bitDiameter) : [];
    var tabTop = intervals.length ? depth - tabs.height : null;

    var levels = depthLevels(depth, depthOfCut, tabTop);
    for (var l = 0; l < levels.length; l++) {
      if (tabTop != null && levels[l] > tabTop + 1e-6) {
        emitTabbedLap(lines, segs, intervals, -levels[l], -tabTop, feedRate, plungeFeedRate);
        continue;
      }
      lines.push('G1 Z' + (-levels[l]).toFixed(3) + ' F' + plungeFeedRate);
      if (rounded || bones) {
        emitSegmentLap(lines, roundSegs || bones, feedRate);
        continue;
      }
      for (var i = 1; i <= verts.length; i++) {
        var v = verts[i % verts.length];
        lines.push('G1 X' + v.x.toFixed(xyDp) + ' Y' + v.y.toFixed(xyDp) + ' F' + feedRate);
      }
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
      'Diameter: ' + (params.sizeMode === 'flats' || params.sizeMode === 'edge'
        ? parseFloat(polyDiameter.toFixed(4)) + unitsLabel + ' (circumscribed; ' + params.sizeValue + unitsLabel +
          (params.sizeMode === 'flats' ? ' across flats)' : ' edge length)')
        : polyDiameter + unitsLabel + ' (circumscribed)'),
      'Start Angle: ' + (params.startAngleDeg || 0) + '°' +
        (baseGeom.cornerR > 0 || bitCornerNote(params, unitsLabel)
          ? ', Corner Radius: ' + baseGeom.cornerR + unitsLabel + bitCornerNote(params, unitsLabel) : ''),
      'Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel,
      'Stepover: ' + stepoverPct + '% (' + step.toFixed(3) + unitsLabel + ')',
      'Entry: straight plunge at innermost polygon start',
      'Origin: ' + resolveShapeOrigin(params, positions, polygonShapeBbox(params), polygonCorners(params)).label
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

    var shift = resolveShapeOrigin(params, positions, polygonShapeBbox(params), polygonCorners(params)).shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + rotStr + ')');
      }
      var geom = computePolygonGeom(params, mx, my, pos.rotDeg);
      emitOnePolygonClearing(lines, params, geom, step);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOnePolygonClearing(lines, params, geom, step) {
    if (geom.cornerR > 0) return emitOnePolygonClearingRounded(lines, params, geom, step);
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;

    var cosHalfAngle = Math.cos(Math.PI / geom.sides);
    var apoOuter = geom.pathRadius * cosHalfAngle;
    var apoMin = geom.toolRadius;
    var radii = [];
    var apo = apoOuter;
    var ringStep = clearingRingStep(step, geom.toolRadius, geom.sides);
    while (apo > 0) {
      radii.push(apo / cosHalfAngle);
      if (apo <= apoMin) break;
      if (apo - ringStep > 1e-9) apo -= ringStep;
      // A last ring that would close up stops a bit radius from the middle.
      else if (apo - apoMin > 1e-9) apo = apoMin;
      else break;
    }
    radii.reverse();

    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    var innerVerts = polygonVertices(geom.cx, geom.cy, radii[0], geom.sides, geom.startAngle);

    lines.push('G0 X' + innerVerts[0].x.toFixed(xyDp) + ' Y' + innerVerts[0].y.toFixed(xyDp));
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + slowPlungeStart);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      lines.push('G1 Z' + (-nextDepth).toFixed(3) + ' F' + plungeFeedRate);

      for (var r = 0; r < radii.length; r++) {
        var verts = polygonVertices(geom.cx, geom.cy, radii[r], geom.sides, geom.startAngle);
        if (r > 0) {
          lines.push('G1 X' + verts[0].x.toFixed(xyDp) + ' Y' + verts[0].y.toFixed(xyDp) +
                     ' F' + plungeFeedRate);
        }
        if (r === radii.length - 1 && cornerRelief(params)) {
          var ring = [];
          for (var vi = 0; vi < verts.length; vi++) pushLine(ring, verts[vi], verts[(vi + 1) % verts.length]);
          emitSegmentLap(lines, cornerReliefSegments(ring, cornerRelief(params), geom.toolRadius, params.cornerRadius, true), feedRate);
          continue;
        }
        for (var i = 1; i <= verts.length; i++) {
          var v = verts[i % verts.length];
          lines.push('G1 X' + v.x.toFixed(xyDp) + ' Y' + v.y.toFixed(xyDp) + ' F' + feedRate);
        }
      }

      currentDepth = nextDepth;
      if (currentDepth < depth - 1e-6) {
        lines.push('G0 X' + innerVerts[0].x.toFixed(xyDp) + ' Y' + innerVerts[0].y.toFixed(xyDp));
      }
    }

    lines.push('G0 Z' + safeHeight);
  }

  // Clearing with rounded corners: the same rings as above (tool path
  // apothems stepping in from the outside), but each ring larger than
  // the core polygon is a rounded path about the core vertices; the
  // rings inside it stay sharp.
  function emitOnePolygonClearingRounded(lines, params, geom, step) {
    var depth = params.depth;
    var depthOfCut = params.depthOfCut;
    var feedRate = params.feedRate;
    var plungeFeedRate = params.plungeFeedRate;
    var half = Math.PI / geom.sides;

    var apos = [];
    var apo = geom.pathRadius * Math.cos(half);
    var ringStep = clearingRingStep(step, geom.toolRadius, geom.sides);
    while (apo > 0) {
      apos.push(apo);
      if (apo <= geom.toolRadius) break;
      if (apo - ringStep > 1e-9) apo -= ringStep;
      else if (apo - geom.toolRadius > 1e-9) apo = geom.toolRadius;
      else break;
    }
    apos.reverse();
    var rings = apos.map(function(a) {
      if (a > geom.coreApothem + 1e-9) {
        return roundedPolygonSegments(geom.cx, geom.cy, geom.coreApothem, a - geom.coreApothem, geom.sides, geom.startAngle);
      }
      var v = polygonVertices(geom.cx, geom.cy, a / Math.cos(half), geom.sides, geom.startAngle), segs = [];
      for (var i = 0; i < v.length; i++) pushLine(segs, v[i], v[(i + 1) % v.length]);
      return segs;
    });
    if (cornerRelief(params) && rings.length) {
      rings[rings.length - 1] = cornerReliefSegments(rings[rings.length - 1], cornerRelief(params), geom.toolRadius, params.cornerRadius, true);
    }

    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    var first = segmentStart(rings[0][0]);
    function moveTo(cmd, p, feed) { lines.push(cmd + ' X' + fixed(p.x, 5) + ' Y' + fixed(p.y, 5) + (feed || '')); }

    moveTo('G0', first);
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + slowPlungeStart);

    var currentDepth = 0;
    while (currentDepth < depth - 1e-6) {
      var nextDepth = Math.min(depth, currentDepth + depthOfCut);
      lines.push('G1 Z' + (-nextDepth).toFixed(3) + ' F' + plungeFeedRate);
      for (var r = 0; r < rings.length; r++) {
        if (r > 0) moveTo('G1', segmentStart(rings[r][0]), ' F' + plungeFeedRate);
        emitSegmentLap(lines, rings[r], feedRate);
      }
      currentDepth = nextDepth;
      if (currentDepth < depth - 1e-6) {
        moveTo('G0', first);
      }
    }

    lines.push('G0 Z' + safeHeight);
  }

  // === SLOT ================================================================
  //
  // A straight or arc (kidney) slot of a set width. Straight: overall Length
  // (end to end) at Angle. Arc: a centre line of Radius from Start Angle
  // through Sweep (CCW; negative = CW), or the same arc given as Chord and
  // Rise, bulging toward Angle. The outline is the centre line grown by half
  // the width, with half-circle ends. Cut types:
  //   center    one pass along the centre line; the slot is the bit's width
  //   inner     the outline, a bit radius inside (holding tabs allowed)
  //   clearing  rings from the centre line out to that outline
  //   outer     the outline, a bit radius outside: a slot-shaped part
  // Local coordinates: a straight slot is centred on (0, 0); an arc slot has
  // the arc's centre at (0, 0), so origin 'shape-center' is its pivot.

  // The centre line, normalised to run CCW: {type:'line', x0..y1, t} (t =
  // its direction, radians) or {type:'arc', r, a0, a1} (a1 > a0, radians),
  // or null when the numbers don't make a slot.
  function slotCenterline(params) {
    if ((params.slotType || 'straight') === 'arc') {
      var r, a0, sweep;
      if (params.arcMode === 'chord') {
        var c = params.chord || 0, h = params.rise || 0;
        if (!(c > 0 && h > 0)) return null;
        r = (c * c / 4 + h * h) / (2 * h);
        sweep = 4 * Math.atan(2 * h / c) * 180 / Math.PI;
        a0 = (params.bulgeAngleDeg != null ? params.bulgeAngleDeg : 90) - sweep / 2;
      } else {
        r = params.radius || 0;
        a0 = params.startAngleDeg || 0;
        sweep = params.sweepDeg || 0;
      }
      if (!(r > 0) || !sweep) return null;
      if (sweep < 0) { a0 += sweep; sweep = -sweep; }
      return { type: 'arc', r: r, a0: a0 * Math.PI / 180, a1: (a0 + sweep) * Math.PI / 180 };
    }
    var half = Math.max(0, (params.length || 0) - 2 * slotHalfWidth(params)) / 2;
    var t = (params.angleDeg || 0) * Math.PI / 180;
    return { type: 'line', t: t,
             x0: -half * Math.cos(t), y0: -half * Math.sin(t),
             x1: half * Math.cos(t), y1: half * Math.sin(t) };
  }

  // The centre line turned by rotDeg about the local origin and moved to
  // (cx, cy): line ends get x0..y1, an arc gets its centre cx, cy.
  function placeSlot(cl, cx, cy, rotDeg) {
    var rot = (rotDeg || 0) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
    if (cl.type === 'line') {
      return { type: 'line', t: cl.t + rot,
               x0: cx + cl.x0 * c - cl.y0 * s, y0: cy + cl.x0 * s + cl.y0 * c,
               x1: cx + cl.x1 * c - cl.y1 * s, y1: cy + cl.x1 * s + cl.y1 * c };
    }
    return { type: 'arc', cx: cx, cy: cy, r: cl.r, a0: cl.a0 + rot, a1: cl.a1 + rot };
  }

  function arcSeg(cx, cy, r, a0, a1, dir) {
    var seg = { type: 'arc', cx: cx, cy: cy, r: r, a0: a0, a1: a1, len: r * Math.abs(a1 - a0) };
    if (dir === -1) seg.dir = -1;
    return seg;
  }

  // Closed outline at half-width d (> 0) around a placed centre line, CCW.
  // Straight: from the middle of one long side. Arc: from the start of the
  // outer arc; the inner arc runs back clockwise (dir -1, G2).
  function slotOutline(pc, d) {
    var segs = [];
    if (pc.type === 'line') {
      var nx = -Math.sin(pc.t), ny = Math.cos(pc.t);
      var mx = (pc.x0 + pc.x1) / 2, my = (pc.y0 + pc.y1) / 2;
      var p = function(x, y, k) { return { x: x + k * nx, y: y + k * ny }; };
      pushLine(segs, p(mx, my, -d), p(pc.x1, pc.y1, -d));
      segs.push(arcSeg(pc.x1, pc.y1, d, pc.t - Math.PI / 2, pc.t + Math.PI / 2));
      pushLine(segs, p(pc.x1, pc.y1, d), p(pc.x0, pc.y0, d));
      segs.push(arcSeg(pc.x0, pc.y0, d, pc.t + Math.PI / 2, pc.t + 3 * Math.PI / 2));
      pushLine(segs, p(pc.x0, pc.y0, -d), p(mx, my, -d));
      return segs;
    }
    var e0 = { x: pc.cx + pc.r * Math.cos(pc.a0), y: pc.cy + pc.r * Math.sin(pc.a0) };
    var e1 = { x: pc.cx + pc.r * Math.cos(pc.a1), y: pc.cy + pc.r * Math.sin(pc.a1) };
    segs.push(arcSeg(pc.cx, pc.cy, pc.r + d, pc.a0, pc.a1));
    segs.push(arcSeg(e1.x, e1.y, d, pc.a1, pc.a1 + Math.PI));
    if (pc.r - d > 1e-9) segs.push(arcSeg(pc.cx, pc.cy, pc.r - d, pc.a1, pc.a0, -1));
    segs.push(arcSeg(e0.x, e0.y, d, pc.a0 + Math.PI, pc.a0 + 2 * Math.PI));
    return segs;
  }

  // The centre line out and back as one path (the innermost clearing ring,
  // and the pass for a centre-line cut): straight from its middle, arc from
  // its start. Empty for a zero-length straight slot (a round hole).
  function slotCenterLoop(pc) {
    var segs = [];
    if (pc.type === 'line') {
      var m = { x: (pc.x0 + pc.x1) / 2, y: (pc.y0 + pc.y1) / 2 };
      pushLine(segs, m, { x: pc.x1, y: pc.y1 });
      pushLine(segs, { x: pc.x1, y: pc.y1 }, { x: pc.x0, y: pc.y0 });
      pushLine(segs, { x: pc.x0, y: pc.y0 }, m);
      return segs;
    }
    segs.push(arcSeg(pc.cx, pc.cy, pc.r, pc.a0, pc.a1));
    segs.push(arcSeg(pc.cx, pc.cy, pc.r, pc.a1, pc.a0, -1));
    return segs;
  }

  // The centre line one way, for alternate passes of a centre-line cut.
  function slotCenterPass(pc, backward) {
    var segs = [];
    if (pc.type === 'line') {
      if (backward) pushLine(segs, { x: pc.x1, y: pc.y1 }, { x: pc.x0, y: pc.y0 });
      else pushLine(segs, { x: pc.x0, y: pc.y0 }, { x: pc.x1, y: pc.y1 });
      return segs;
    }
    segs.push(backward ? arcSeg(pc.cx, pc.cy, pc.r, pc.a1, pc.a0, -1) : arcSeg(pc.cx, pc.cy, pc.r, pc.a0, pc.a1));
    return segs;
  }

  // Bounding box of a segment path, arcs included exactly.
  function segmentsBbox(segs) {
    var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    function add(x, y) {
      if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    }
    segs.forEach(function(s) {
      if (s.type === 'line') { add(s.x0, s.y0); add(s.x1, s.y1); return; }
      var lo = Math.min(s.a0, s.a1), hi = Math.max(s.a0, s.a1);
      add(s.cx + s.r * Math.cos(lo), s.cy + s.r * Math.sin(lo));
      add(s.cx + s.r * Math.cos(hi), s.cy + s.r * Math.sin(hi));
      for (var k = Math.ceil(lo / (Math.PI / 2)); k * Math.PI / 2 <= hi; k++) {
        add(s.cx + s.r * Math.cos(k * Math.PI / 2), s.cy + s.r * Math.sin(k * Math.PI / 2));
      }
    });
    return b;
  }

  // Why the numbers don't make a slot, or null when they do.
  function slotProblem(params, cl, half) {
    if (!cl) return 'the slot\'s size or angles are missing or zero';
    if (!(half > 0)) return 'the slot width must be more than 0';
    if (cl.type === 'arc') {
      if (half >= cl.r) return 'the slot is as wide as its radius or wider, so its inner edge would cross the centre';
      // An outer cut runs a bit radius outside the slot, so its inner arc
      // is that much tighter; at or past the centre the ends don't join and
      // the controller rejects the arcs.
      if (params.cutType === 'outer' && half + (params.bitDiameter || 0) / 2 >= cl.r) {
        return 'with the Outer cut the bit\'s path is as wide as its radius or wider, so its inner edge would cross the centre: make the radius bigger, or the slot or bit narrower';
      }
      var gap = 2 * Math.PI - (cl.a1 - cl.a0);
      // An outer cut's ends run a bit radius outside the slot's, so when
      // they face each other across a gap under 180° they meet sooner and
      // the bit would cut into the part's ends.
      var endReach = half + (params.cutType === 'outer' && gap < Math.PI ? (params.bitDiameter || 0) / 2 : 0);
      if (gap <= 0 || 2 * cl.r * Math.sin(gap / 2) < 2 * endReach) return 'the slot\'s ends would overlap: the sweep is too close to a full circle for this width' + (endReach > half ? ' and bit' : '');
    }
    return null;
  }

  // The slot's box (per copy) and its tappable points (the two end
  // centres) for resolveShapeOrigin. A centre-line cut is the bit's width.
  function slotHalfWidth(params) {
    return ((params.cutType || 'inner') === 'center' ? (params.bitDiameter || 0) : (params.width || 0)) / 2;
  }
  function slotOriginParts(params, cl) {
    var half = slotHalfWidth(params);
    return {
      bbox: function(pos) { return segmentsBbox(slotOutline(placeSlot(cl, 0, 0, pos.rotDeg), half)); },
      corners: function(rot) {
        var pc = placeSlot(cl, 0, 0, rot);
        if (pc.type !== 'line') {
          return [{ x: pc.r * Math.cos(pc.a0), y: pc.r * Math.sin(pc.a0) }, { x: pc.r * Math.cos(pc.a1), y: pc.r * Math.sin(pc.a1) }];
        }
        // Straight: the end centres (1, 2), then where the long sides meet the
        // round ends (3 start-right, 4 end-right, 5 end-left, 6 start-left, seen
        // along the Angle) and the middles of the long sides (7 right, 8 left),
        // so an edge of the cut can be X0 Y0 at any angle.
        var nx = -Math.sin(pc.t) * half, ny = Math.cos(pc.t) * half;
        var mx = (pc.x0 + pc.x1) / 2, my = (pc.y0 + pc.y1) / 2;
        return [{ x: pc.x0, y: pc.y0 }, { x: pc.x1, y: pc.y1 },
                { x: pc.x0 - nx, y: pc.y0 - ny }, { x: pc.x1 - nx, y: pc.y1 - ny },
                { x: pc.x1 + nx, y: pc.y1 + ny }, { x: pc.x0 + nx, y: pc.y0 + ny },
                { x: mx - nx, y: my - ny }, { x: mx + nx, y: my + ny }];
      }
    };
  }

  function generateSlotProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var cutType = params.cutType || 'inner';
    var tr = (params.bitDiameter || 0) / 2;
    var half = slotHalfWidth(params), width = half * 2;
    var cl = slotCenterline(params);
    var isArc = (params.slotType || 'straight') === 'arc';
    // Grid: each line is a straight slot as long as the span its copy
    // carries (centre line from the first line to the last), so the Slot's
    // own Length and Angle don't apply.
    var isGrid = !isArc && !!(params.pattern && params.pattern.enabled && params.pattern.style === 'grid');
    var lineParams = function(pos) {
      return Object.assign({}, params, { slotType: 'straight', length: (pos.span || 0) + width, angleDeg: 0 });
    };
    var clFor = function(pos) { return isGrid ? slotCenterline(lineParams(pos)) : cl; };
    var deg = function(rad) { return parseFloat((rad * 180 / Math.PI).toFixed(3)); };
    var size = isArc
      ? (params.arcMode === 'chord'
          ? 'Slot: arc, chord ' + params.chord + unitsLabel + ', rise ' + params.rise + unitsLabel + ', bulging toward ' + (params.bulgeAngleDeg != null ? params.bulgeAngleDeg : 90) + '°'
          : 'Slot: arc, radius ' + params.radius + unitsLabel + ', start ' + (params.startAngleDeg || 0) + '°, sweep ' + (params.sweepDeg || 0) + '°')
      : isGrid ? 'Slot: straight grid lines, each spanning the grid'
      : 'Slot: straight, length ' + params.length + unitsLabel + ', angle ' + (params.angleDeg || 0) + '°';
    var extras = [size];
    if (isArc && cl && params.arcMode === 'chord') {
      extras.push('Arc: radius ' + parseFloat(cl.r.toFixed(4)) + unitsLabel + ', from ' + deg(cl.a0) + '° to ' + deg(cl.a1) + '°');
    }
    extras.push('Width: ' + (cutType === 'center' ? width + unitsLabel + ' (the bit)' : params.width + unitsLabel) +
                ', Cut: ' + ({ center: 'centre line', inner: 'inner (perimeter)', clearing: 'inner (clearing)', outer: 'outer (part)' }[cutType] || cutType));
    extras.push('Depth: ' + params.depth + unitsLabel + ', Step: ' + params.depthOfCut + unitsLabel);
    var problem = isGrid ? slotProblem(lineParams(positions[0]), clFor(positions[0]), half) : slotProblem(params, cl, half);
    var op = problem ? null : !isGrid ? slotOriginParts(params, cl) : {
      bbox: function(pos) { return slotOriginParts(lineParams(pos), clFor(pos)).bbox(pos); },
      corners: slotOriginParts(lineParams(positions[0]), clFor(positions[0])).corners
    };
    if (op) extras.push('Origin: ' + resolveShapeOrigin(params, positions, op.bbox, op.corners).label);
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));
    // Holding tabs (inner / outer only), noted like the other shapes and
    // checked on the first copy's outline.
    var tabNotes = !problem && (cutType === 'outer' || (cutType === 'inner' && half - tr > 1e-9))
      ? tabHeaderNotes(params, slotOutline(placeSlot(clFor(positions[0]), 0, 0, positions[0].rotDeg), cutType === 'outer' ? half + tr : half - tr), extras)
      : [];
    var lines = programHeader(params, {
      shapeLabel: 'Slot' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });
    if (!problem && (cutType === 'inner' || cutType === 'clearing') && half - tr <= 1e-9) {
      problem = 'the slot is no wider than the bit; use the Centre line cut type';
    }
    if (problem) {
      lines.push(comment('WARNING: ' + problem + '; nothing to cut'));
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }
    var shift = resolveShapeOrigin(params, positions, op.bbox, op.corners).shift;
    lines.push.apply(lines, tabNotes);
    lines.push.apply(lines, startupBlock(params));
    // Grid center lines go back and forth: each starts at the end nearer
    // where the last one finished (an odd number of passes ends at the far
    // end), so the hop between lines is short instead of back across.
    var serpentine = isGrid && cutType === 'center';
    var passCount = serpentine ? depthLevels(params.depth, params.depthOfCut, null).length : 0;
    var here = null;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x, my = pos.y + shift.y;
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + rotStr + ')');
      }
      var pc = placeSlot(clFor(pos), mx, my, pos.rotDeg);
      if (serpentine && here && Math.hypot(pc.x1 - here.x, pc.y1 - here.y) < Math.hypot(pc.x0 - here.x, pc.y0 - here.y) - 1e-9) {
        pc = { type: 'line', t: pc.t + Math.PI, x0: pc.x1, y0: pc.y1, x1: pc.x0, y1: pc.y0 };
      }
      emitOneSlot(lines, params, pc, cutType, half, tr);
      if (serpentine) here = passCount % 2 ? { x: pc.x1, y: pc.y1 } : { x: pc.x0, y: pc.y0 };
    }
    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOneSlot(lines, params, pc, cutType, half, tr) {
    var depth = params.depth, feed = params.feedRate, plunge = params.plungeFeedRate;
    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    function moveTo(cmd, pt, feedSuffix) { lines.push(cmd + ' X' + fixed(pt.x, 5) + ' Y' + fixed(pt.y, 5) + (feedSuffix || '')); }
    function approach(pt) {
      moveTo('G0', pt);
      lines.push('G0 Z' + safeHeight);
      lines.push('G0 Z' + slowPlungeStart);
    }
    var mid = pc.type === 'line' ? { x: (pc.x0 + pc.x1) / 2, y: (pc.y0 + pc.y1) / 2 } : null;

    if (cutType === 'center') {
      // Back and forth along the centre line, one pass per depth step.
      var fwd = slotCenterPass(pc, false), back = slotCenterPass(pc, true);
      var levelsC = depthLevels(depth, params.depthOfCut, null);
      approach(fwd.length ? segmentStart(fwd[0]) : mid);
      for (var i = 0; i < levelsC.length; i++) {
        lines.push('G1 Z' + (-levelsC[i]).toFixed(3) + ' F' + plunge);
        emitSegmentLap(lines, i % 2 ? back : fwd, feed);
      }
      lines.push('G0 Z' + safeHeight);
      return;
    }

    if (cutType === 'clearing') {
      // Rings from the centre line out to the outline, a stepover apart.
      var step = (params.bitDiameter || 0) * ((params.stepoverPct || 40) / 100);
      var outer = half - tr, ds = [];
      for (var d = outer; d > 1e-9; d -= step) ds.push(d);
      ds.reverse();
      var rings = [slotCenterLoop(pc)].concat(ds.map(function(dd) { return slotOutline(pc, dd); }))
        .filter(function(r) { return r.length; });
      var first = rings.length ? segmentStart(rings[0][0]) : mid;
      var levelsR = depthLevels(depth, params.depthOfCut, null);
      approach(first);
      for (var l = 0; l < levelsR.length; l++) {
        lines.push('G1 Z' + (-levelsR[l]).toFixed(3) + ' F' + plunge);
        for (var r = 0; r < rings.length; r++) {
          if (r > 0) moveTo('G1', segmentStart(rings[r][0]), ' F' + feed);
          emitSegmentLap(lines, rings[r], feed);
        }
        if (l < levelsR.length - 1) {
          lines.push('G0 Z' + safeHeight);
          moveTo('G0', first);
          lines.push('G0 Z' + slowPlungeStart);
        }
      }
      lines.push('G0 Z' + safeHeight);
      return;
    }

    // inner / outer: the closed outline, with holding tabs if set.
    var segs = slotOutline(pc, cutType === 'outer' ? half + tr : half - tr);
    var tabs = tabSettings(params);
    var intervals = tabs ? tabIntervals(segs, tabs, params.bitDiameter) : [];
    var tabTop = intervals.length ? depth - tabs.height : null;
    var levels = depthLevels(depth, params.depthOfCut, tabTop);
    approach(segmentStart(segs[0]));
    for (var k = 0; k < levels.length; k++) {
      if (tabTop != null && levels[k] > tabTop + 1e-6) {
        emitTabbedLap(lines, segs, intervals, -levels[k], -tabTop, feed, plunge);
        continue;
      }
      lines.push('G1 Z' + (-levels[k]).toFixed(3) + ' F' + plunge);
      emitSegmentLap(lines, segs, feed);
    }
    lines.push('G0 Z' + safeHeight);
  }

  // === KEYHOLE ============================================================
  //
  // Hanging slot cut with a keyhole / T-slot bit. The head is wider than
  // the neck, so the bit can only enter and leave the wood through the
  // plunge hole: plunge straight down to full depth, cut forward along
  // the slot, retrace back to the hole, and only then retract. There is
  // no Depth of Cut — a shallower slot pass would cut the narrow neck
  // slot out to the full head width.
  //
  // X0 Y0 is the plunge-hole center (of the first instance when a
  // pattern is on), so there's no origin picker / anchor shift. The slot
  // runs slotLength from the hole at startAngleDeg (CCW from +X); a
  // pattern's per-instance rotDeg turns the slot with it.
  // Footprint of one keyhole relative to its plunge hole: the head
  // (bitDiameter) swept from the hole to the slot end at angleDeg.
  function keyholeBbox(params, angleDeg) {
    var R = (params.bitDiameter || 0) / 2;
    var a = angleDeg * Math.PI / 180;
    var ex = (params.slotLength || 0) * Math.cos(a), ey = (params.slotLength || 0) * Math.sin(a);
    return { minX: Math.min(0, ex) - R, maxX: Math.max(0, ex) + R,
             minY: Math.min(0, ey) - R, maxY: Math.max(0, ey) + R };
  }

  function resolveKeyholeOrigin(params, positions) {
    var startDeg = params.startAngleDeg || 0;
    return resolveShapeOrigin(params, positions, function(pos) {
      return keyholeBbox(params, startDeg + (pos.rotDeg || 0));
    }, keyholeCorners(params));
  }

  // Origin 'hole' (the default) puts the first plunge hole at X0 Y0.
  // Any other origin is a point of the bounding box of every keyhole's
  // footprint, as with the other shapes.
  function generateKeyholeProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var slotLength = params.slotLength || 0;
    var startDeg = params.startAngleDeg || 0;
    var origin = params.origin || 'hole';

    var extras = [
      'Slot Length: ' + slotLength + unitsLabel + ', Slot Angle: ' + startDeg + '°',
      'Depth: ' + params.depth + unitsLabel,
      'Origin: ' + (origin === 'hole' ? 'plunge hole center' : resolveKeyholeOrigin(params, positions).label),
      'Entry: single plunge, retrace to hole before retract'
    ];
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Keyhole' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (!(slotLength > 0) || !(params.depth > 0)) {
      lines.push('(WARNING: slot length and depth must be greater than 0; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    var shift = origin === 'hole' ? { x: 0, y: 0 } : resolveKeyholeOrigin(params, positions).shift;
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var mx = pos.x + shift.x;
      var my = pos.y + shift.y;
      if (positions.length > 1) {
        var rotStr = pos.rotDeg ? (' rot=' + pos.rotDeg.toFixed(3) + '°') : '';
        lines.push('(Instance ' + (p + 1) + '/' + positions.length +
                   ' at X' + mx.toFixed(3) + ' Y' + my.toFixed(3) + rotStr + ')');
      }
      emitOneKeyhole(lines, params, mx, my, startDeg + (pos.rotDeg || 0));
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOneKeyhole(lines, params, cx, cy, angleDeg) {
    var end = rotatePoint(cx, cy, cx + params.slotLength, cy, angleDeg);
    var safeHeight = safeHopDelta.toFixed(3);
    var slowPlungeStart = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    var hole = 'X' + cx.toFixed(xyDp) + ' Y' + cy.toFixed(xyDp);

    lines.push('G0 ' + hole);
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + slowPlungeStart);
    lines.push('G1 Z' + (-params.depth).toFixed(3) + ' F' + params.plungeFeedRate);
    lines.push('G1 X' + end.x.toFixed(xyDp) + ' Y' + end.y.toFixed(xyDp) + ' F' + params.feedRate);
    lines.push('G1 ' + hole + ' ; Retrace to plunge hole');
    lines.push('G0 Z' + safeHeight);
  }

  // === DRILL ==============================================================
  //
  // Point holes at each pattern position, hole diameter = bit diameter.
  // Origin works as on Circle: a point of the bounding box of all the
  // holes (center by default, which for one hole is the hole itself).
  //
  // Pecking uses explicit moves, not G81/G83 canned cycles: plain grbl
  // doesn't support those, and explicit moves show in the visualizer.
  //   clear: after each peck, rapid out to the 2mm clearance to clear
  //          chips, then rapid back to 0.5mm above the bottom.
  //   break: after each peck, back off 0.5mm to snap the chip.
  // An optional dwell at the bottom cleans up the hole floor.
  function generateDrillProgram(params) {
    var unitsLabel = isImperial ? 'inch' : 'mm';
    var positions = computePatternPositions(params.pattern);
    var peck = params.peckDepth > 0 && params.peckDepth < params.depth ? params.peckDepth : 0;
    var mode = params.peckMode === 'break' ? 'break' : 'clear';

    var origin = resolveDrillOrigin(params.origin, params.pattern, positions, params.bitDiameter, params.inset);

    var extras = [
      'Depth: ' + params.depth + unitsLabel,
      'Peck: ' + (peck ? peck + unitsLabel + ', ' + (mode === 'break' ? 'short retract' : 'full retract') : 'none'),
      'Origin: ' + origin.label
    ];
    if (params.dwell > 0) extras.push('Dwell: ' + params.dwell + 's');
    if (positions.length > 1) extras.push('Pattern: ' + patternDescription(params.pattern));

    var lines = programHeader(params, {
      shapeLabel: 'Drill' + (positions.length > 1 ? ' × ' + positions.length : ''),
      extraComments: extras
    });

    if (!(params.depth > 0)) {
      lines.push('(WARNING: depth must be greater than 0; nothing to cut)');
      lines.push.apply(lines, programFooter(params));
      return lines.join('\n');
    }

    lines.push.apply(lines, startupBlock(params));

    var shift = origin.shift;
    for (var p = 0; p < positions.length; p++) {
      var mx = positions[p].x + shift.x;
      var my = positions[p].y + shift.y;
      if (positions.length > 1) {
        lines.push('(Hole ' + (p + 1) + '/' + positions.length +
                   ' at X' + fixed(mx, 3) + ' Y' + fixed(my, 3) + ')');
      }
      emitOneHole(lines, params, mx, my, peck, mode);
    }

    lines.push('');
    lines.push.apply(lines, programFooter(params));
    return lines.join('\n');
  }

  function emitOneHole(lines, params, x, y, peck, mode) {
    var safeHeight = safeHopDelta.toFixed(3);
    var clearance = (isImperial ? (2 * 0.0393701) : 2).toFixed(3);
    var backoff = isImperial ? 0.5 * 0.0393701 : 0.5;
    var depth = params.depth;

    lines.push('G0 X' + fixed(x, xyDp) + ' Y' + fixed(y, xyDp));
    lines.push('G0 Z' + safeHeight);
    lines.push('G0 Z' + clearance);

    var d = 0;
    while (d < depth - 1e-6) {
      var next = peck ? Math.min(depth, d + peck) : depth;
      lines.push('G1 Z' + (-next).toFixed(3) + ' F' + params.plungeFeedRate);
      if (next < depth - 1e-6) {
        if (mode === 'clear') lines.push('G0 Z' + clearance + ' ; Clear chips');
        lines.push('G0 Z' + (backoff - next).toFixed(3) + (mode === 'break' ? ' ; Break chip' : ''));
      }
      d = next;
    }
    if (params.dwell > 0) lines.push('G4 P' + params.dwell + ' ; Dwell');
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
    generateKeyholeProgram: generateKeyholeProgram,
    generateDrillProgram: generateDrillProgram,
    computePatternPositions: computePatternPositions,
    computePatternAnchorShift: computePatternAnchorShift,
    tabIntervals: tabIntervals,
    patternPositionKeys: patternPositionKeys,
    resolveDrillOrigin: resolveDrillOrigin,
    rectangleCorners: rectangleCorners,
    polygonCorners: polygonCorners,
    shapeOriginOffset: shapeOriginOffset,
    generateSlotProgram: generateSlotProgram,
    slotCenterline: slotCenterline,
    placeSlot: placeSlot,
    slotOutline: slotOutline,
    segmentsBbox: segmentsBbox,
    slotProblem: slotProblem,
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
