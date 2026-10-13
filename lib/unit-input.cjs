/**
 * QuickCut unit-aware field parsing.
 *
 * MUST STAY IN SYNC WITH the inline parseUnitValue inside config.html
 * (same reason as lib/quickcut-gcode.cjs: the dialog can't load
 * external JS, so this is the Node-loadable twin used by tests).
 *
 * Turns what an operator types into a length or feed field into a plain
 * number in the active units (inches when isImperial, else mm):
 *   6.35        → 6.35 (no unit: already in active units, untouched)
 *   .25in  .25"  1/4"  1-1/2"  1 1/2 in  6.35mm  0.635cm
 *   feeds also: 100ipm  100 in/min  2540 mm/min
 * Converted values are rounded like roundDisplay (4 dp inch, 3 dp mm).
 * Returns null when the text can't be read as a value.
 */
function parseUnitValue(text, isImperial, kind) {
  var t = String(text == null ? '' : text).trim().toLowerCase()
    .replace(/[”″]/g, '"').replace(/''/g, '"');
  var m = t.match(/^([+-])?\s*(\d+(?:\.\d*)?|\.\d+)(?:(?:\s+|-)(\d+)\/(\d+)|\/(\d+))?\s*([a-z"/]*)$/);
  if (!m) return null;
  var whole = parseFloat(m[2]);
  var value;
  if (m[3] != null) {
    // Mixed number: 1-1/2 or 1 1/2. The whole part must be an integer.
    if (/\./.test(m[2]) || +m[4] === 0) return null;
    value = whole + (+m[3]) / (+m[4]);
  } else if (m[5] != null) {
    // Plain fraction: 1/4.
    if (/\./.test(m[2]) || +m[5] === 0) return null;
    value = whole / (+m[5]);
  } else {
    value = whole;
  }
  if (m[1] === '-') value = -value;

  var MM_PER = { mm: 1, cm: 10, 'in': 25.4, inch: 25.4, inches: 25.4, '"': 25.4 };
  if (kind === 'feed') {
    MM_PER['mm/min'] = 1;
    MM_PER['in/min'] = 25.4;
    MM_PER['inch/min'] = 25.4;
    MM_PER.ipm = 25.4;
  }
  var unit = m[6];
  if (!unit) return value;
  if (!Object.prototype.hasOwnProperty.call(MM_PER, unit)) return null;
  var mm = value * MM_PER[unit];
  var out = isImperial ? mm / 25.4 : mm;
  return parseFloat(out.toFixed(isImperial ? 4 : 3));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseUnitValue: parseUnitValue };
}
