// Leaving the Chamfer tab redraws the shape's own preview, so the V-bit's
// side view doesn't stay on Cutter or Circle (their tabs don't redraw when
// opened). Runs config.html's exitChamferMode with the page stubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'config.html'), 'utf8');
const fn = (name) => {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
};
const names = ['exitChamferMode'].concat(html.indexOf('function redrawChamferShape(') >= 0 ? ['redrawChamferShape'] : []);
const SHAPES = ['cutter', 'circle', 'rectangle', 'polygon', 'slot', 'keyhole'];
const PREVIEWS = { cutter: 'updateCutterPreview', circle: 'updateCirclePreview', rectangle: 'updateRectanglePreview', polygon: 'updatePolygonPreview', slot: 'updateSlotPreview', keyhole: 'updateKeyholePreview' };

function leave(target) {
  const calls = [];
  const el = () => ({ checked: true, value: '', style: {}, dispatchEvent() {} });
  const els = {};
  const env = {
    state: { chamferMode: target, toolByShape: { [target]: { bit: 6 } }, wasPocket: null },
    $: (id) => els[id] || (els[id] = el()),
    ROOT: { querySelectorAll: () => [] },
    chamferHead: null,
    placeChamferEdge() {},
    writeToolToInputs() { calls.push('tool'); }
  };
  Object.keys(PREVIEWS).forEach((k) => {
    env[PREVIEWS[k]] = () => calls.push(k + (env.state.chamferMode ? ' (still chamfering)' : ''));
  });
  const keys = Object.keys(env);
  const run = new Function(...keys, names.map(fn).join('\n') + '\nreturn exitChamferMode;')(...keys.map((k) => env[k]));
  run();
  return calls;
}

for (const tab of SHAPES) {
  test('leaving the Chamfer tab on ' + tab + ' redraws its own preview after the tool', () => {
    const calls = leave(tab);
    assert.ok(calls.indexOf(tab) > calls.indexOf('tool'), calls.join(', '));
    assert.ok(!calls.some((c) => /still/.test(c)), calls.join(', '));
  });
}

// Another Edge picked on the Chamfer tab leaves the first shape's panel with
// the chamfer drawing and no exitChamferMode for it: opening any chamfer
// shape's tab must redraw it.
test('opening a chamfer shape\'s tab redraws its preview', () => {
  const sw = fn('switchTab');
  SHAPES.forEach((tab) => {
    const re = new RegExp("if \\(target === '" + tab + "'\\) (setTimeout\\()?" + PREVIEWS[tab] + '\\b');
    assert.match(sw, re, tab);
  });
});
