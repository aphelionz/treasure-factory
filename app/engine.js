// engine.js: the player. Loads scene.json + the image manifest, shows the
// current node as a photo, hit-tests clicks against its hotspots, and cuts to
// the target node. Vanilla, no dependencies. Press H to reveal clickable areas.
import { containRect, rectToScreen, hitTest } from './geometry.js';

const SCENE_URL = 'scene.json';
const MANIFEST_URL = 'images/manifest.json';

const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const overlay = document.getElementById('overlay');
const titleEl = document.getElementById('title');
const hintEl = document.getElementById('hint');

let scene = null;
let manifest = null;
let nodeById = new Map();
let current = null;
let naturalW = 0, naturalH = 0;
let debug = false;

init();

async function init() {
  try {
    const [s, m] = await Promise.all([
      // cache-bust scene.json so editor saves go live promptly (Pages caches 10 min)
      fetch(SCENE_URL + '?v=' + Date.now()).then(r => r.json()),
      fetch(MANIFEST_URL).then(r => r.json()),
    ]);
    scene = s;
    manifest = m;
    nodeById = new Map((scene.nodes || []).map(n => [n.id, n]));
    document.title = (scene.meta && scene.meta.title) || 'Treasure Factory';
    const entry = (scene.meta && scene.meta.entry) ||
      (scene.nodes && scene.nodes[0] && scene.nodes[0].id);
    if (!entry) return showError('scene.json has no nodes.');
    goto(entry);
  } catch (err) {
    console.error(err);
    showError('Could not load the game. Serve over http first: ./scripts/serve.sh');
  }
}

function imageUrl(imageKey) {
  const entry = manifest[imageKey];
  if (!entry) { console.warn('missing image in manifest:', imageKey); return null; }
  return 'images/' + entry.file;
}

function goto(nodeId) {
  const node = nodeById.get(nodeId);
  if (!node) { console.warn('unknown node:', nodeId); return; }
  const url = imageUrl(node.image);
  if (!url) return showError('Missing image for node "' + node.id + '": ' + node.image);

  current = node;
  titleEl.textContent = node.title || '';
  hintEl.textContent = '';

  frame.classList.add('fading');
  const next = new Image();
  next.onload = () => {
    naturalW = next.naturalWidth;
    naturalH = next.naturalHeight;
    frame.src = url;
    frame.classList.remove('fading');
    if (debug) drawOutlines();
    preloadNeighbors(node);
  };
  next.onerror = () => showError('Failed to load image: ' + url);
  next.src = url;
}

function preloadNeighbors(node) {
  for (const hs of node.hotspots || []) {
    if (hs.action && hs.action.type === 'goto') {
      const target = nodeById.get(hs.action.target);
      if (target) {
        const u = imageUrl(target.image);
        if (u) { const im = new Image(); im.src = u; }
      }
    }
  }
}

function layout() {
  const box = overlay.getBoundingClientRect();
  return { box, ...containRect(box.width, box.height, naturalW, naturalH) };
}

function localPoint(e, box) {
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}

overlay.addEventListener('mousemove', (e) => {
  if (!current) return;
  const L = layout();
  const p = localPoint(e, L.box);
  const hs = hitTest(p.x, p.y, current.hotspots || [], L);
  overlay.style.cursor = hs ? (hs.cursor || 'pointer') : 'default';
  hintEl.textContent = hs && hs.hint ? hs.hint : '';
});

overlay.addEventListener('click', (e) => {
  if (!current) return;
  const L = layout();
  const p = localPoint(e, L.box);
  const hs = hitTest(p.x, p.y, current.hotspots || [], L);
  if (hs) dispatch(hs.action);
});

function dispatch(action) {
  if (!action) return;
  switch (action.type) {
    case 'goto':
      goto(action.target);
      break;
    // inspect / text / sound / animate / puzzle: future work
    default:
      console.warn('unknown action type:', action.type);
  }
}

// --- developer aid: press H to reveal clickable areas ---
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    debug = !debug;
    debug ? drawOutlines() : clearOutlines();
  }
});
window.addEventListener('resize', () => { if (debug) drawOutlines(); });

function clearOutlines() {
  overlay.querySelectorAll('.hs-outline').forEach(n => n.remove());
}

function drawOutlines() {
  clearOutlines();
  if (!current) return;
  const L = layout();
  for (const hs of current.hotspots || []) {
    if (!hs.shape || hs.shape.type !== 'rect') continue;
    const s = rectToScreen(hs.shape, L);
    const d = document.createElement('div');
    d.className = 'hs-outline';
    d.style.cssText = `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px`;
    overlay.appendChild(d);
  }
}

function showError(msg) {
  titleEl.textContent = '';
  let e = document.getElementById('error');
  if (!e) { e = document.createElement('div'); e.id = 'error'; stage.appendChild(e); }
  e.textContent = msg;
}
