#!/usr/bin/env node
// smoke.mjs: load the game and the editor in headless Chromium, walk a few rooms
// by tapping real hotspots, and fail on any console error, page error, or
// missing file. Saves phone-sized screenshots for the PR comment.
//   npm install --no-save playwright && npx playwright install chromium
//   node scripts/smoke.mjs [outDir]
// Playwright is installed on the fly in CI; it is NOT a dependency of the repo.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'app');
const OUT = process.argv[2] || join(ROOT, 'dist', 'smoke');
const MAX_STEPS = 6;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Tiny static server for app/ (what GitHub Pages serves).
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(APP, path.endsWith('/') ? path + 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

const problems = [];
const shots = [];
await mkdir(OUT, { recursive: true });

function watch(page, label) {
  page.on('console', m => { if (m.type() === 'error') problems.push(`${label}: console error: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`${label}: uncaught ${e.message}`));
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) problems.push(`${label}: ${r.status()} ${r.url().slice(BASE.length)}`); });
}

async function shot(page, name) {
  const file = join(OUT, name + '.jpg');
  await page.screenshot({ path: file, type: 'jpeg', quality: 75 });
  shots.push(name);
}

// On the editor's photo a tap or click on a box follows it to its room, and a
// press-and-hold selects it for editing (then the same finger can drag it).
// On desktop a mouse drag selects and moves it too.
async function hotspotGestures(ed, label) {
  const tag = 'editor-' + label;
  if (await ed.locator('#atlasView').isVisible()) await ed.click('#atlasClose');
  // Open a node that has a box leading somewhere.
  const ok = await ed.evaluate(async () => {
    const sel = document.getElementById('nodeSelect');
    for (const opt of sel.options) {
      sel.value = opt.value; sel.dispatchEvent(new Event('change'));
      const img = document.getElementById('editframe');
      for (let i = 0; i < 40 && !(img.complete && img.naturalWidth); i++) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 100));
      if ([...document.querySelectorAll('#overlay .hs:not(.find)')].some(b => /^Click to go/.test(b.title))) return opt.value;
    }
    return null;
  });
  if (!ok) { problems.push(`${tag}: no node has a box to follow`); return; }
  const boxCenter = async () => {
    const b = await ed.locator('#overlay .hs:not(.find)[title^="Click to go"]').first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const nodeNow = () => ed.inputValue('#nodeSelect');
  const reopen = async () => {
    await ed.selectOption('#nodeSelect', ok);
    await ed.waitForTimeout(400);
  };
  const cdp = label === 'phone' ? await ed.context().newCDPSession(ed) : null;
  const finger = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const press = async (holdMs, dragBy = 0) => {
    const { x, y } = await boxCenter();
    if (cdp) {
      await finger('touchStart', x, y);
      await ed.waitForTimeout(holdMs);
      for (let d = 5; d <= dragBy; d += 5) await finger('touchMove', x + d, y + d);
      await finger('touchEnd', x, y);
    } else {
      await ed.mouse.move(x, y); await ed.mouse.down();
      await ed.waitForTimeout(holdMs);
      for (let d = 5; d <= dragBy; d += 5) await ed.mouse.move(x + d, y + d);
      await ed.mouse.up();
    }
    await ed.waitForTimeout(300);
  };
  const selected = () => ed.evaluate(() => !!document.querySelector('#overlay .hs.selected') &&
    !document.getElementById('hsEditor').hidden);

  // 1. A quick tap/click follows the box.
  await press(60);
  if (await nodeNow() === ok) problems.push(`${tag}: tapping a box should open the room it leads to`);
  else console.log(`${tag}: tap on a box in ${ok} followed it to ${await nodeNow()}`);

  // 2. Press and hold selects it and stays in the room.
  await reopen();
  await press(700);
  if (await nodeNow() !== ok) problems.push(`${tag}: holding a box should not leave the room`);
  if (!(await selected())) problems.push(`${tag}: holding a box should select it for editing`);
  await shot(ed, `${tag}-hotspot-held`);

  // 3. Dragging moves it: on a phone after a hold, on desktop straight away.
  await reopen();
  const before = (await boxCenter()).b;
  await press(label === 'phone' ? 700 : 30, 40);
  const after = await ed.locator('#overlay .hs.selected').boundingBox();
  if (await nodeNow() !== ok) problems.push(`${tag}: dragging a box should not leave the room`);
  if (!after || Math.abs(after.x - before.x) < 20) problems.push(`${tag}: dragging a box should move it`);
  else console.log(`${tag}: dragged a box by ${Math.round(after.x - before.x)}px`);
}

// Pinch out on the editor's map with two real touch points and check it zooms
// in around the fingers instead of zooming the whole page.
async function pinchMap(ed) {
  const body = await ed.locator('#atlasBody').boundingBox();
  if (!body) { problems.push('editor-phone: map is not showing'); return; }
  const zoomOf = () => ed.evaluate(() => {
    const m = /scale\(([\d.]+)\)/.exec(document.querySelector('.at-canvas').style.transform);
    return m ? +m[1] : NaN;
  });
  const before = await zoomOf();
  const cdp = await ed.context().newCDPSession(ed);
  const cx = body.x + body.width / 2, cy = body.y + body.height / 2;
  const touch = (type, gap) => cdp.send('Input.dispatchTouchEvent', { type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: cx - gap, y: cy, id: 1 }, { x: cx + gap, y: cy, id: 2 }] });
  await touch('touchStart', 20);
  for (let gap = 30; gap <= 120; gap += 10) await touch('touchMove', gap);
  await touch('touchEnd', 0);
  await ed.waitForTimeout(300);
  const after = await zoomOf();
  const pageScale = await ed.evaluate(() => window.visualViewport ? window.visualViewport.scale : 1);
  console.log(`editor-phone: map pinch zoom ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  if (!(after > before * 3)) problems.push(`editor-phone: pinching the map should zoom it in (zoom went ${before} -> ${after})`);
  if (pageScale > 1.01) problems.push(`editor-phone: pinching the map zoomed the whole page (scale ${pageScale})`);
  await shot(ed, 'editor-phone-map-pinched');
}

const browser = await chromium.launch();
try {
  const scene = JSON.parse(await readFile(join(APP, 'scene.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(APP, 'images', 'manifest.json'), 'utf8'));
  const nodeById = new Map(scene.nodes.map(n => [n.id, n]));

  // ---------- player, on a phone ----------
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await phone.newPage();
  watch(page, 'player');
  await page.goto(BASE + '/');
  const frameFile = () => page.evaluate(() => decodeURIComponent(document.getElementById('frame').src.split('/').pop()));
  const waitFor = (file) => page.waitForFunction(f => {
    const im = document.getElementById('frame');
    return im.complete && im.naturalWidth > 0 && decodeURIComponent(im.src).endsWith('/' + f);
  }, file, { timeout: 10000 });

  let node = nodeById.get(scene.meta.entry);
  await waitFor(manifest[node.image].file);
  if (await page.locator('#checklist').isVisible()) {   // first visit opens the hunt checklist
    await shot(page, 'player-checklist');
    await page.click('#clClose');
  }
  await shot(page, 'player-1-' + node.id);

  // Walk: tap the centre of a goto hotspot leading somewhere new, like a player would.
  const visited = new Set([node.id]);
  for (let step = 2; step <= MAX_STEPS + 1; step++) {
    const gotos = node.hotspots.filter(h => h.action.type === 'goto');
    const hs = gotos.find(h => !visited.has(h.action.target)) || gotos[0];
    if (!hs) break;
    const target = nodeById.get(hs.action.target);
    const pt = await page.evaluate((s) => {
      const im = document.getElementById('frame');
      const box = document.getElementById('overlay').getBoundingClientRect();
      const ar = im.naturalWidth / im.naturalHeight;
      let dw = box.width, dh = box.width / ar;
      if (dh > box.height) { dh = box.height; dw = box.height * ar; }
      const dx = box.left + (box.width - dw) / 2, dy = box.top + (box.height - dh) / 2;
      return { x: dx + (s.x + s.w / 2) * dw, y: dy + (s.y + s.h / 2) * dh };
    }, hs.shape);
    await page.mouse.click(pt.x, pt.y);
    try {
      await waitFor(manifest[target.image].file);
    } catch {
      problems.push(`player: tapping ${node.id}/${hs.id} should open "${target.id}", but the screen shows ${await frameFile()}`);
      break;
    }
    await page.waitForTimeout(900);   // let the transition finish before the screenshot
    node = target;
    visited.add(node.id);
    if (step <= 3) await shot(page, `player-${step}-${node.id}`);
  }
  console.log(`player: walked ${visited.size} rooms: ${[...visited].join(' -> ')}`);
  await phone.close();

  // ---------- editor, on a phone and a laptop ----------
  for (const [label, ctxOpts] of [['phone', devices['iPhone 13']], ['desktop', { viewport: { width: 1280, height: 800 } }]]) {
    const ctx = await browser.newContext(ctxOpts);
    const ed = await ctx.newPage();
    watch(ed, 'editor-' + label);
    await ed.goto(BASE + '/editor.html');
    await ed.waitForFunction(() => {
      const s = document.getElementById('nodeSelect');
      return s && s.options.length > 0;
    }, null, { timeout: 10000 }).catch(() => problems.push(`editor-${label}: node list never loaded`));
    await ed.waitForTimeout(500);
    await shot(ed, 'editor-' + label);
    if (label === 'phone') await pinchMap(ed);
    await hotspotGestures(ed, label);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`screenshots: ${shots.length} in ${OUT}`);
for (const p of problems) console.log(process.env.GITHUB_ACTIONS ? `::error::${p}` : `error: ${p}`);
console.log(problems.length ? `smoke test FAILED (${problems.length} problems)` : 'smoke test passed');
process.exit(problems.length ? 1 : 0);
