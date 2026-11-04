// Copies ncsender-unit-input's dist/unit-input.global.js into config.html,
// between its BEGIN/END lines (ncSender serves a plugin's config.html only,
// so the library is pasted in). Usage:
//   node .scripts/sync-unit-input.mjs [path to ncsender-unit-input]
// (default ../ncsender-unit-input). Build the library first (npm run build).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const lib = path.resolve(process.argv[2] || path.join(here, '..', 'ncsender-unit-input'));
const global = fs.readFileSync(path.join(lib, 'dist', 'unit-input.global.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(lib, 'package.json'), 'utf8'));
let rev = '';
try { rev = execFileSync('git', ['-C', lib, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (e) { /* not a git checkout */ }
const file = path.join(here, 'config.html');
const html = fs.readFileSync(file, 'utf8');
const begin = html.indexOf('// BEGIN ncsender-unit-input'), end = html.indexOf('// END ncsender-unit-input');
if (begin < 0 || end < begin) throw new Error('config.html has no BEGIN/END ncsender-unit-input lines');
const head = '// BEGIN ncsender-unit-input ' + pkg.version + (rev ? ' (' + rev + ')' : '') +
  ': pasted by node .scripts/sync-unit-input.mjs; edit the library, not this.\n';
fs.writeFileSync(file, html.slice(0, begin) + head + global + html.slice(end));
console.log('config.html: ncsender-unit-input ' + pkg.version + (rev ? ' ' + rev : ''));
