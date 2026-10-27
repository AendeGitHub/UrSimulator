// Copies the built game (dist/) into the desktop app (desktop/app) with the app icon, and keeps
// the app's version in step with the game's.
//
//   npm run build && node tools/prepare-desktop.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(ROOT, 'desktop', 'app');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}
fs.rmSync(APP, { recursive: true, force: true });
fs.cpSync(DIST, APP, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'desktop', 'build', 'icon.png'), path.join(APP, 'icon.png'));

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const desktopPkg = path.join(ROOT, 'desktop', 'package.json');
const pkg = JSON.parse(fs.readFileSync(desktopPkg, 'utf8'));
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(desktopPkg, `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(`desktop/app ready (UrSim ${version})`);
