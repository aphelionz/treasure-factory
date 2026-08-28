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

// --- scavenger hunt state (active only when scene.meta.hunt exists) ---
let hunt = null;             // { storageKey, items: [{id, room, label, count}] }
let huntItems = new Map();   // item id -> item config
let huntSpots = new Map();   // "nodeId:hotspotId" -> item id, every find hotspot
let found = new Set();       // "nodeId:hotspotId" keys the player has found
let toastTimer = null;

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
    initHunt();
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
    renderMarkers();
    pulseNavHotspots(node);
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
  if (hs) dispatch(hs);
});

// every tap gets a ripple, so a miss still visibly registered (phones have no hover)
overlay.addEventListener('pointerdown', (e) => {
  const box = overlay.getBoundingClientRect();
  const d = document.createElement('div');
  d.className = 'tap-ripple';
  d.style.left = (e.clientX - box.left) + 'px';
  d.style.top = (e.clientY - box.top) + 'px';
  d.addEventListener('animationend', () => d.remove());
  overlay.appendChild(d);
});

// on scene entry, briefly pulse where the exits are: goto hotspots only, so the
// hunt's find boxes stay secret
function pulseNavHotspots(node) {
  overlay.querySelectorAll('.hs-pulse').forEach(n => n.remove());
  if (debug) return;
  const L = layout();
  for (const hs of node.hotspots || []) {
    if (!(hs.action && hs.action.type === 'goto')) continue;
    if (!hs.shape || hs.shape.type !== 'rect') continue;
    const s = rectToScreen(hs.shape, L);
    const d = document.createElement('div');
    d.className = 'hs-pulse';
    d.style.cssText = `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px`;
    d.addEventListener('animationend', () => d.remove());
    overlay.appendChild(d);
  }
}

function dispatch(hs) {
  const action = hs && hs.action;
  if (!action) return;
  switch (action.type) {
    case 'goto':
      goto(action.target);
      break;
    case 'find':
      onFind(hs, action);
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
window.addEventListener('resize', () => { if (debug) drawOutlines(); renderMarkers(); });

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

// --- scavenger hunt ---
// scene.meta.hunt declares the items; hotspots with {type:'find', item} place
// them. Progress is a Set of "nodeId:hotspotId" keys in localStorage, so two
// hotspots for the same item (e.g. "Two candy canes") count separately.

const huntStorageKey = () => (hunt && hunt.storageKey) || 'tf-hunt-v1';

function initHunt() {
  hunt = scene.meta && scene.meta.hunt;
  if (!hunt || !Array.isArray(hunt.items) || !hunt.items.length) return;
  huntItems = new Map(hunt.items.map(i => [i.id, i]));
  for (const n of scene.nodes || []) {
    for (const hs of n.hotspots || []) {
      if (hs.action && hs.action.type === 'find' && huntItems.has(hs.action.item)) {
        huntSpots.set(n.id + ':' + hs.id, hs.action.item);
      }
    }
  }
  try {
    const raw = localStorage.getItem(huntStorageKey());
    for (const k of raw ? JSON.parse(raw) : []) if (huntSpots.has(k)) found.add(k);
  } catch (_) {}
  const hud = document.getElementById('hud');
  hud.hidden = false;
  hud.addEventListener('click', toggleChecklist);
  updateHud();
  // first visit: open the checklist once so a new player learns it's a hunt
  try {
    if (!localStorage.getItem('tf-intro-v1')) {
      localStorage.setItem('tf-intro-v1', '1');
      toggleChecklist();
    }
  } catch (_) {}
}

function saveHunt() {
  try { localStorage.setItem(huntStorageKey(), JSON.stringify([...found])); } catch (_) {}
}

// found / placed hotspot counts for one item id
function itemCounts(id) {
  let total = 0, got = 0;
  for (const [k, item] of huntSpots) {
    if (item === id) { total++; if (found.has(k)) got++; }
  }
  return { got, total };
}

function onFind(hs, action) {
  const item = huntItems.get(action.item);
  if (!item) return;
  const key = current.id + ':' + hs.id;
  if (found.has(key)) { toast('Already found: ' + item.label); return; }
  found.add(key);
  saveHunt();
  renderMarkers();
  updateHud();
  const c = itemCounts(action.item);
  toast(c.got >= c.total ? '✓ ' + item.label + '!' : '✓ ' + item.label + ' · ' + c.got + ' of ' + c.total);
  if (found.size === huntSpots.size) {
    setTimeout(showWin, 900);
  }
  if (!document.getElementById('checklist').hidden) renderChecklist();
}

// full-screen finale. Prose comes from scene.json (meta.hunt.winText, and
// meta.hunt.winUrl + winLinkLabel for the outbound button), all author-written;
// without them the card is just the trophy and the count.
function showWin() {
  const w = document.getElementById('win');
  let html = '<div class="win-card"><div class="trophy">🏆</div>' +
    '<div class="count">' + found.size + '/' + huntSpots.size + '</div>';
  if (hunt.winText) html += '<p>' + esc(hunt.winText) + '</p>';
  if (hunt.winUrl && hunt.winLinkLabel) {
    html += '<a class="win-link" href="' + esc(hunt.winUrl) +
      '" target="_blank" rel="noopener">' + esc(hunt.winLinkLabel) + '</a>';
  }
  html += '<button id="winClose" aria-label="Close">×</button></div>';
  w.innerHTML = html;
  w.hidden = false;
  document.getElementById('winClose').addEventListener('click', () => { w.hidden = true; });
  w.onclick = (e) => { if (e.target === w) w.hidden = true; };
}

function updateHud() {
  if (!hunt) return;
  document.getElementById('hudCount').textContent = found.size + '/' + huntSpots.size;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// gold check badges on already-found hotspots of the current node
function renderMarkers() {
  overlay.querySelectorAll('.hs-found').forEach(n => n.remove());
  if (!current || !hunt) return;
  const L = layout();
  for (const hs of current.hotspots || []) {
    if (!(hs.action && hs.action.type === 'find')) continue;
    if (!found.has(current.id + ':' + hs.id)) continue;
    const s = rectToScreen(hs.shape, L);
    const d = document.createElement('div');
    d.className = 'hs-found';
    d.style.cssText = `left:${s.x + s.w / 2}px;top:${s.y + s.h / 2}px`;
    d.textContent = '✓';
    overlay.appendChild(d);
  }
}

function toggleChecklist() {
  const c = document.getElementById('checklist');
  if (c.hidden) { renderChecklist(); c.hidden = false; } else { c.hidden = true; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function renderChecklist() {
  const c = document.getElementById('checklist');
  const rooms = [];
  const byRoom = new Map();
  for (const item of hunt.items) {
    if (!byRoom.has(item.room)) { byRoom.set(item.room, []); rooms.push(item.room); }
    byRoom.get(item.room).push(item);
  }
  let html = '<div class="cl-card"><div class="cl-head"><b>Scavenger Hunt</b>' +
    '<button id="clClose" aria-label="Close">×</button></div>';
  for (const room of rooms) {
    html += '<h4>' + esc(room) + '</h4><ul>';
    for (const item of byRoom.get(room)) {
      const n = itemCounts(item.id);
      const done = n.total > 0 && n.got >= n.total;
      html += '<li class="' + (done ? 'done' : '') + '"><span>' + esc(item.label) +
        '</span><span class="n">' + (done ? '✓' : n.got + '/' + n.total) + '</span></li>';
    }
    html += '</ul>';
  }
  html += '<button id="clReset">Reset progress</button></div>';
  c.innerHTML = html;
  document.getElementById('clClose').addEventListener('click', toggleChecklist);
  document.getElementById('clReset').addEventListener('click', () => {
    if (!confirm('Reset all scavenger hunt progress?')) return;
    found.clear(); saveHunt(); renderMarkers(); updateHud(); renderChecklist();
  });
  c.onclick = (e) => { if (e.target === c) toggleChecklist(); };
}
