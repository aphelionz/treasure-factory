#!/usr/bin/env node
// check-scene.mjs: validate app/scene.json and app/images/ before they ship.
// Runs in CI on every PR and before every Pages deploy, and locally:
//   node scripts/check-scene.mjs
// Exits 1 on any error. Warnings are printed but don't fail the run.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'app');
const IMAGES = join(APP, 'images');
const MAX_IMAGE_BYTES = 600 * 1024;   // build-assets.sh output is ~300 KB; a bigger file means an unoptimized photo slipped in

const { validateScene } = await import(join(APP, 'validate.js'));

const errors = [];
const warnings = [];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { errors.push(`${path.slice(ROOT.length + 1)}: ${e.message}`); return null; }
}

const scene = readJson(join(APP, 'scene.json'));
const manifest = readJson(join(IMAGES, 'manifest.json'));

if (scene && manifest) {
  const r = validateScene(scene, manifest);
  errors.push(...r.errors);
  warnings.push(...r.warnings);
}

if (manifest) {
  const listed = new Set();
  for (const [key, e] of Object.entries(manifest)) {
    if (!e || typeof e.file !== 'string') { errors.push(`manifest entry "${key}" has no file`); continue; }
    listed.add(e.file);
    const p = join(IMAGES, e.file);
    if (!existsSync(p)) { errors.push(`manifest entry "${key}" points to missing file images/${e.file}`); continue; }
    if (!(e.w > 0 && e.h > 0)) errors.push(`manifest entry "${key}" needs positive w and h`);
    else if (e.w > e.h) errors.push(`image "${key}" is landscape (${e.w}x${e.h}); the game is portrait only`);
    const size = statSync(p).size;
    if (size > MAX_IMAGE_BYTES) errors.push(`images/${e.file} is ${Math.round(size / 1024)} KB (limit ${MAX_IMAGE_BYTES / 1024} KB); run it through build-assets.sh`);
  }
  for (const f of readdirSync(IMAGES)) {
    if (f === 'manifest.json' || f.startsWith('.')) continue;
    if (!listed.has(f)) warnings.push(`images/${f} is not in manifest.json, so the game can't use it`);
  }
}

// Summary of the scavenger hunt, for context (not a failure).
let info = '';
if (scene && scene.meta && scene.meta.hunt && Array.isArray(scene.meta.hunt.items) && Array.isArray(scene.nodes)) {
  const placed = new Set();
  for (const n of scene.nodes) for (const h of n.hotspots || []) if (h.action && h.action.type === 'find') placed.add(h.action.item);
  info = `hunt: ${placed.size} of ${scene.meta.hunt.items.length} items have a spot`;
}

// GitHub Actions turns these lines into annotations on the PR.
const gha = !!process.env.GITHUB_ACTIONS;
for (const w of warnings) console.log(gha ? `::warning file=app/scene.json::${w}` : `warning: ${w}`);
for (const e of errors) console.log(gha ? `::error file=app/scene.json::${e}` : `error: ${e}`);
const nodes = scene && Array.isArray(scene.nodes) ? scene.nodes.length : 0;
console.log(`scene check: ${nodes} nodes, ${errors.length} errors, ${warnings.length} warnings${info ? ', ' + info : ''}`);
process.exit(errors.length ? 1 : 0);
