// editor.js: the authoring tool. Reads the served scene.json + manifest, lets
// you draw / move / resize rectangle hotspots on a photo and assign navigation
// targets, then writes scene.json back to your app/ folder via the File System
// Access API (Chrome/Edge). Falls back to a Download for other browsers.
// Reuses geometry.js so a box drawn here is clickable at the same spot in the player.
import { containRect, rectToScreen, screenToNorm } from './geometry.js';

const SCENE_URL = 'scene.json';
const MANIFEST_URL = 'images/manifest.json';
const FSA = 'showDirectoryPicker' in window;

// Save-mode detection: localhost uses the File System Access API; a GitHub Pages
// host commits scene.json via the GitHub Contents API; otherwise fall back to Download.
const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
const GH = githubConfig();                 // {owner, repo} from the Pages URL, or null
const HOSTED = !IS_LOCAL && !!GH;
const TOKEN_KEY = 'tf_gh_token';
const REPO_SCENE_PATH = 'app/scene.json';  // repo path (app/ is published as the site root)
const GH_BRANCH = 'main';

const el = (id) => document.getElementById(id);
const frame = el('editframe');
const overlay = el('overlay');

let scene = null;
let manifest = null;
let dirHandle = null;
let currentNodeId = null;
let selectedId = null;
let dirty = false;

// drag interaction state
let mode = 'idle';        // 'draw' | 'move' | 'resize'
let dragStart = null;     // {x,y} in box pixels
let dragOrig = null;      // original shape (normalized) for move/resize
let tempEl = null;        // live rectangle while drawing
let moved = false;
let wired = false;        // editor events wired once

init();

async function init() {
  wireGate();
  try {
    const [s, m] = await Promise.all([
      fetch(SCENE_URL).then(r => r.ok ? r.json() : emptyScene()).catch(emptyScene),
      fetch(MANIFEST_URL).then(r => r.json()),
    ]);
    scene = normalizeScene(s);
    manifest = m;
  } catch (e) {
    console.error(e);
    setStatus('Could not load. Serve via ./scripts/serve.sh');
    return;
  }
  try { dirHandle = await idbGet('projectDir'); } catch (_) { dirHandle = null; }

  // Hosted editor stays locked until a token with access to the repo is provided.
  if (HOSTED) {
    const tok = getToken();
    if (!tok) { showGate(); return; }
    const res = await checkToken(tok);
    if (!res.ok) { showGate(res.reason); return; }
  }
  startEditor();
}

function startEditor() {
  el('gate').hidden = true;
  if (!wired) { wireEvents(); wired = true; }
  populateNodeSelect();
  populateTargetOptions();
  const first = scene.nodes[0] && scene.nodes[0].id;
  selectNode((scene.meta && scene.meta.entry) || first || null);
  applyMode();
}

function applyMode() {
  const tokenBtn = el('helpTokenBtn');
  tokenBtn.hidden = !HOSTED;
  if (HOSTED) tokenBtn.textContent = 'Sign out';
  const saveBtn = el('saveBtn');
  if (HOSTED) {
    saveBtn.textContent = 'Save to GitHub';
    setStatus('Saves commit to ' + GH.owner + '/' + GH.repo + '.');
  } else if (IS_LOCAL && FSA) {
    saveBtn.textContent = 'Save to folder';
    setStatus('Reads the served scene. Save writes to your app/ folder.');
  } else {
    saveBtn.textContent = 'Save';
    el('unsupported').hidden = false;
    setStatus('Edit, then Download scene.json.');
  }
}

function emptyScene() { return { schemaVersion: 1, meta: { title: 'Treasure Factory', entry: null }, nodes: [] }; }
function normalizeScene(s) {
  s = s || emptyScene();
  s.schemaVersion = s.schemaVersion || 1;
  s.meta = s.meta || { title: 'Treasure Factory', entry: null };
  s.nodes = Array.isArray(s.nodes) ? s.nodes : [];
  for (const n of s.nodes) n.hotspots = Array.isArray(n.hotspots) ? n.hotspots : [];
  return s;
}

// ---------- selectors / model helpers ----------
const currentNode = () => scene.nodes.find(n => n.id === currentNodeId) || null;
const currentHotspot = () => { const n = currentNode(); return n ? n.hotspots.find(h => h.id === selectedId) : null; };
function imageUrl(key) { const e = manifest[key]; return e ? 'images/' + e.file : ''; }
function otherNodeId() { const o = scene.nodes.find(n => n.id !== currentNodeId); return o ? o.id : currentNodeId; }
function uniqueHotspotId(node) {
  let i = 1, id;
  do { id = 'h_' + i++; } while (node.hotspots.some(h => h.id === id));
  return id;
}

// ---------- populate dropdowns ----------
function buildUsedMap() {
  // image key -> the node that uses it (derived; last writer wins if duplicated)
  const used = {};
  for (const n of scene.nodes) { if (n.image) used[n.image] = n; }
  return used;
}
function populateNodeSelect() {
  const sel = el('nodeSelect');
  sel.innerHTML = '';
  for (const n of scene.nodes) {
    const o = document.createElement('option'); o.value = n.id; o.textContent = n.title || n.id; sel.appendChild(o);
  }
}
function populateTargetOptions() {
  const sel = el('hsTarget');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const n of scene.nodes) {
    const o = document.createElement('option'); o.value = n.id; o.textContent = n.title || n.id; sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

// ---------- node selection ----------
function selectNode(id) {
  currentNodeId = id;
  selectedId = null;
  const node = currentNode();
  el('nodeSelect').value = id || '';
  el('browseImagesBtn').disabled = !node;
  el('curImageName').textContent = (node && node.image) || 'none';
  if (node) {
    el('nodeTitle').value = node.title || '';
    const url = imageUrl(node.image);
    if (url) {
      el('empty').hidden = true;
      frame.onload = () => renderHotspots();
      frame.src = url;
    } else {
      frame.removeAttribute('src');
      el('empty').hidden = false;
    }
  } else {
    frame.removeAttribute('src');
    el('empty').hidden = false;
  }
  renderHotspots();
  updateHsEditor();
}

function createNodeFromImage(img) {
  let base = (img || 'node').replace(/[^a-z0-9_]+/gi, '_');
  let id = base, i = 2;
  while (scene.nodes.some(n => n.id === id)) id = base + '_' + (i++);
  const ans = prompt('Name this room:', '');
  if (ans === null) return;   // cancelled
  scene.nodes.push({ id, image: img, title: ans.trim(), hotspots: [] });
  if (!scene.meta.entry) scene.meta.entry = id;
  populateNodeSelect(); populateTargetOptions(); markDirty();
  selectNode(id);
}

// ---------- image grid (the selector) ----------
let gridMode = 'assign';

function openImageGrid(mode) {
  gridMode = mode;
  el('imageGridFilter').value = '';
  el('imageGrid').hidden = false;   // show first so the observer sees real layout
  renderImageGrid('');
  el('imageGridFilter').focus();
}
function closeImageGrid() { el('imageGrid').hidden = true; }

function renderImageGrid(filter) {
  const used = buildUsedMap();
  const cur = currentNode();
  const keys = Object.keys(manifest).sort();
  const q = (filter || '').toLowerCase();
  const list = el('imageGridList');
  list.innerHTML = '';
  for (const key of keys) {
    if (q && !key.toLowerCase().includes(q)) continue;
    const owner = used[key];
    const tile = document.createElement('div');
    tile.className = 'tile' + (owner ? ' used' : '') + (cur && cur.image === key ? ' current' : '');
    tile.dataset.key = key;
    const img = document.createElement('img');
    img.loading = 'lazy'; img.alt = key; img.src = imageUrl(key);
    tile.appendChild(img);
    if (owner) {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = owner.title || owner.id;
      tile.appendChild(b);
    }
    const cap = document.createElement('span');
    cap.className = 'cap'; cap.textContent = key;
    tile.appendChild(cap);
    list.appendChild(tile);
  }
  const u = Object.keys(used).length;
  el('imageGridCount').textContent = u + ' of ' + keys.length + ' used, ' + (keys.length - u) + ' left';
}

function onGridPick(key) {
  if (gridMode === 'create') { closeImageGrid(); createNodeFromImage(key); return; }
  const node = currentNode();
  closeImageGrid();
  if (!node) return;
  node.image = key; markDirty(); selectNode(node.id);
}

function wireImageGrid() {
  el('imageGridClose').addEventListener('click', closeImageGrid);
  el('imageGridFilter').addEventListener('input', (e) => renderImageGrid(e.target.value));
  el('imageGridList').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile'); if (tile) onGridPick(tile.dataset.key);
  });
  el('imageGrid').addEventListener('click', (e) => { if (e.target === el('imageGrid')) closeImageGrid(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('imageGrid').hidden) closeImageGrid(); });
}

// ---------- layout / geometry ----------
function layout() {
  const box = overlay.getBoundingClientRect();
  return { box, ...containRect(box.width, box.height, frame.naturalWidth, frame.naturalHeight) };
}
function clampPt(e, L) {
  const x = Math.min(L.dx + L.dw, Math.max(L.dx, e.clientX - L.box.left));
  const y = Math.min(L.dy + L.dh, Math.max(L.dy, e.clientY - L.box.top));
  return { x, y };
}
function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function positionEl(node, r) {
  node.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
}

// ---------- render hotspots ----------
function renderHotspots() {
  overlay.querySelectorAll('.hs:not(.drawing)').forEach(n => n.remove());
  const node = currentNode();
  if (!node || !frame.naturalWidth) { renderHotspotList(); return; }
  const L = layout();
  for (const hs of node.hotspots) {
    if (!hs.shape || hs.shape.type !== 'rect') continue;
    const d = document.createElement('div');
    d.className = 'hs' + (hs.id === selectedId ? ' selected' : '');
    d.dataset.id = hs.id;
    positionEl(d, rectToScreen(hs.shape, L));
    const target = hs.action && hs.action.target;
    const tgt = target && scene.nodes.find(n => n.id === target);
    const tgtName = (tgt && (tgt.title || tgt.id)) || target || hs.id;
    const label = document.createElement('span');
    label.className = 'hslabel';
    label.textContent = tgtName;
    d.appendChild(label);
    d.title = 'Option-click to follow' + (target ? ' -> ' + tgtName : '');
    if (hs.id === selectedId) { const h = document.createElement('div'); h.className = 'handle'; d.appendChild(h); }
    overlay.appendChild(d);
  }
  renderHotspotList();
}

function renderHotspotList() {
  const list = el('hotspotList');
  list.innerHTML = '';
  const node = currentNode();
  if (!node) return;
  for (const hs of node.hotspots) {
    const li = document.createElement('li');
    if (hs.id === selectedId) li.className = 'sel';
    li.dataset.id = hs.id;
    const name = document.createElement('span'); name.textContent = hs.hint || hs.id;
    const t = document.createElement('span'); t.className = 't';
    const tgtId = hs.action && hs.action.target;
    const tNode = tgtId && scene.nodes.find(n => n.id === tgtId);
    t.textContent = '→ ' + ((tNode && (tNode.title || tNode.id)) || tgtId || '?');
    li.append(name, t);
    li.addEventListener('click', () => selectHotspot(hs.id));
    list.appendChild(li);
  }
}

function selectHotspot(id) { selectedId = id; renderHotspots(); updateHsEditor(); }

function updateHsEditor() {
  const hs = currentHotspot();
  const box = el('hsEditor');
  if (!hs) { box.hidden = true; return; }
  box.hidden = false;
  el('hsHint').value = hs.hint || '';
  el('hsActionType').value = (hs.action && hs.action.type) || 'goto';
  populateTargetOptions();
  el('hsTarget').value = (hs.action && hs.action.target) || '';
  const s = hs.shape;
  el('hsCoords').textContent =
    `x ${s.x.toFixed(3)}  y ${s.y.toFixed(3)}  w ${s.w.toFixed(3)}  h ${s.h.toFixed(3)}`;
}

function deleteSelected() {
  const node = currentNode();
  if (!node || !selectedId) return;
  node.hotspots = node.hotspots.filter(h => h.id !== selectedId);
  selectedId = null;
  markDirty(); renderHotspots(); updateHsEditor();
}

// ---------- pointer interaction ----------
const capture = (e) => { try { capture(e); } catch (_) {} };

overlay.addEventListener('pointerdown', (e) => {
  const node = currentNode();
  if (!node || !frame.naturalWidth) return;
  // Option/Alt-click a hotspot to follow it to its target node
  const hsEl = e.target.closest('.hs');
  if (e.altKey && hsEl) {
    const hs = node.hotspots.find(h => h.id === hsEl.dataset.id);
    const target = hs && hs.action && hs.action.target;
    if (target && scene.nodes.some(n => n.id === target)) selectNode(target);
    return;
  }
  const L = layout();
  const p = clampPt(e, L);
  moved = false;

  if (e.target.classList.contains('handle')) {
    selectHotspot(e.target.parentElement.dataset.id);
    mode = 'resize'; dragOrig = { ...currentHotspot().shape }; dragStart = p;
    capture(e); return;
  }
  if (e.target.classList.contains('hs')) {
    selectHotspot(e.target.dataset.id);
    mode = 'move'; dragOrig = { ...currentHotspot().shape }; dragStart = p;
    capture(e); return;
  }
  // empty space: start drawing a new box
  mode = 'draw'; dragStart = p;
  tempEl = document.createElement('div'); tempEl.className = 'hs drawing';
  positionEl(tempEl, { x: p.x, y: p.y, w: 0, h: 0 });
  overlay.appendChild(tempEl);
  capture(e);
});

overlay.addEventListener('pointermove', (e) => {
  if (mode === 'idle') return;
  const L = layout();
  const p = clampPt(e, L);
  moved = true;
  if (mode === 'draw') {
    positionEl(tempEl, rectFromPoints(dragStart, p));
  } else if (mode === 'move') {
    const hs = currentHotspot(); if (!hs) return;
    const dxn = (p.x - dragStart.x) / L.dw;
    const dyn = (p.y - dragStart.y) / L.dh;
    hs.shape = {
      type: 'rect',
      x: Math.min(1 - dragOrig.w, Math.max(0, dragOrig.x + dxn)),
      y: Math.min(1 - dragOrig.h, Math.max(0, dragOrig.y + dyn)),
      w: dragOrig.w, h: dragOrig.h,
    };
    renderHotspots();
  } else if (mode === 'resize') {
    const hs = currentHotspot(); if (!hs) return;
    const n = screenToNorm(p.x, p.y, L, { clamp: true });
    hs.shape = {
      type: 'rect',
      x: Math.min(dragOrig.x, n.x), y: Math.min(dragOrig.y, n.y),
      w: Math.max(0.005, Math.abs(n.x - dragOrig.x)), h: Math.max(0.005, Math.abs(n.y - dragOrig.y)),
    };
    renderHotspots();
  }
});

overlay.addEventListener('pointerup', (e) => {
  if (mode === 'draw') {
    const L = layout();
    const r = rectFromPoints(dragStart, clampPt(e, L));
    if (tempEl) { tempEl.remove(); tempEl = null; }
    if (r.w > 6 && r.h > 6) {
      const a = screenToNorm(r.x, r.y, L, { clamp: true });
      const b = screenToNorm(r.x + r.w, r.y + r.h, L, { clamp: true });
      const node = currentNode();
      const id = uniqueHotspotId(node);
      node.hotspots.push({
        id,
        shape: { type: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) },
        hint: '',
        action: { type: 'goto', target: otherNodeId() },
      });
      markDirty(); renderHotspots(); selectHotspot(id);
    }
  } else if ((mode === 'move' || mode === 'resize') && moved) {
    markDirty(); updateHsEditor();
  }
  mode = 'idle'; dragStart = null; dragOrig = null; moved = false;
});

// ---------- events ----------
function wireEvents() {
  el('nodeSelect').addEventListener('change', (e) => selectNode(e.target.value));
  el('newNodeBtn').addEventListener('click', () => openImageGrid('create'));
  el('browseImagesBtn').addEventListener('click', () => { if (currentNode()) openImageGrid('assign'); });
  wireImageGrid();
  el('nodeTitle').addEventListener('input', (e) => {
    const node = currentNode(); if (!node) return;
    node.title = e.target.value; markDirty();
    const opt = [...el('nodeSelect').options].find(o => o.value === node.id);
    if (opt) opt.textContent = node.title || node.id;
  });
  el('hsHint').addEventListener('input', (e) => {
    const hs = currentHotspot(); if (!hs) return;
    hs.hint = e.target.value; markDirty(); renderHotspotList();
  });
  el('hsTarget').addEventListener('change', (e) => {
    const hs = currentHotspot(); if (!hs) return;
    hs.action = hs.action || { type: 'goto' };
    hs.action.target = e.target.value; markDirty(); renderHotspots();
  });
  el('deleteHsBtn').addEventListener('click', deleteSelected);
  el('saveBtn').addEventListener('click', save);
  el('downloadBtn').addEventListener('click', download);
  window.addEventListener('resize', () => renderHotspots());
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId &&
        document.activeElement.tagName !== 'INPUT') {
      e.preventDefault(); deleteSelected();
    }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  el('helpTokenBtn').addEventListener('click', signOut);
}

function markDirty() { dirty = true; setStatus('Unsaved changes'); }
function setStatus(msg) { el('status').textContent = msg; }

// ---------- save / download ----------
function sceneJson() { return JSON.stringify(scene, null, 2) + '\n'; }

async function ensureDir() {
  if (dirHandle) {
    const opts = { mode: 'readwrite' };
    if (await dirHandle.queryPermission(opts) === 'granted') return true;
    if (await dirHandle.requestPermission(opts) === 'granted') return true;
  }
  dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tf-app' });
  try { await idbSet('projectDir', dirHandle); } catch (_) {}
  return true;
}

async function save() {
  if (IS_LOCAL && FSA) return saveFsa();
  if (HOSTED) return ghSave();
  return download();
}

async function saveFsa() {
  try {
    await ensureDir();
    // best-effort backup of the previous scene.json
    try {
      const old = await (await (await dirHandle.getFileHandle('scene.json')).getFile()).text();
      const bh = await dirHandle.getFileHandle('scene.json.bak', { create: true });
      const bw = await bh.createWritable(); await bw.write(old); await bw.close();
    } catch (_) {}
    const fh = await dirHandle.getFileHandle('scene.json', { create: true });
    const w = await fh.createWritable(); await w.write(sceneJson()); await w.close();
    dirty = false; setStatus('Saved scene.json ✓');
  } catch (e) {
    console.error(e);
    setStatus('Save failed (' + e.name + '). Use Download.');
  }
}

function download() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([sceneJson()], { type: 'application/json' }));
  a.download = 'scene.json'; a.click();
  URL.revokeObjectURL(a.href);
  dirty = false; setStatus('Downloaded scene.json. Move it into app/');
}

// ---------- GitHub save (hosted) ----------
function githubConfig() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (m) {
    const repo = location.pathname.split('/').filter(Boolean)[0] || '';
    if (repo) return { owner: m[1], repo };
  }
  return null; // localhost / non-Pages host: GitHub save is off (FSA or Download is used)
}

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }

// btoa() throws on non-ASCII, so encode the UTF-8 bytes first.
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + getToken(),
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGetSha() {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${REPO_SCENE_PATH}?ref=${GH_BRANCH}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;            // file does not exist yet -> create
  if (!r.ok) { const e = new Error('GET sha failed: ' + r.status); e.status = r.status; throw e; }
  return (await r.json()).sha;
}

async function ghPut(sha) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${REPO_SCENE_PATH}`;
  const body = { message: 'Update scene.json via editor', content: toBase64Utf8(sceneJson()), branch: GH_BRANCH };
  if (sha) body.sha = sha;
  return fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function ghSave() {
  if (!getToken()) { showGate('Paste a GitHub token to save.'); return; }
  try {
    setStatus('Saving to GitHub…');
    let sha = await ghGetSha();
    let r = await ghPut(sha);
    if (r.status === 409) { sha = await ghGetSha(); r = await ghPut(sha); }   // stale sha: retry once
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).message || ''; } catch (_) {}
      console.warn('ghSave failed', r.status, msg);
      if (r.status === 401 || r.status === 403) {
        signOut();
        setStatus('Save rejected (' + r.status + '): ' + (msg || 'token needs Contents: Read and write on this repo'));
      } else {
        setStatus('Save failed (' + r.status + ')' + (msg ? ': ' + msg : ''));
      }
      return;
    }
    dirty = false;
    setStatus('Committed scene.json. Pages redeploys shortly.');
  } catch (e) {
    console.error(e);
    if (e.status === 401 || e.status === 403) {
      signOut();
      setStatus('Token rejected (' + e.status + '). Re-enter a token with Contents: Read and write.');
    } else {
      setStatus('Save failed: could not reach GitHub (network or CORS). See console.');
    }
  }
}

// ---------- access gate (hosted) ----------
// Verify the token can reach this repo. A fine-grained PAT scoped to the repo
// returns 200 (Metadata: read is automatic); 401 = bad/expired token; 404 = token
// not granted to this repo. We do NOT check permissions.push (it is unreliable for
// fine-grained PATs); write capability is enforced by GitHub at save time.
async function checkToken(token) {
  try {
    const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}`, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (r.ok) return { ok: true };
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch (_) {}
    const reason = r.status === 401
      ? 'Token is invalid or expired (401).'
      : r.status === 404
      ? 'This token cannot see ' + GH.owner + '/' + GH.repo + ' (404). When creating it, set Resource owner = ' + GH.owner + ' and Repository access = Only select repositories, then pick ' + GH.repo + '.'
      : 'GitHub returned ' + r.status + (msg ? ' (' + msg + ')' : '') + '.';
    return { ok: false, status: r.status, reason };
  } catch (e) {
    return { ok: false, status: 0, reason: 'Could not reach GitHub (network or CORS): ' + (e.message || 'unknown') };
  }
}

function showGate(reason) {
  el('tokenInput').value = getToken();
  const err = el('gateError');
  if (reason) { err.textContent = reason; err.hidden = false; } else { err.hidden = true; }
  el('gate').hidden = false;
}

function signOut() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  showGate();
}

function wireGate() {
  el('gateUnlock').addEventListener('click', unlockFromGate);
  el('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlockFromGate(); } });
}

async function unlockFromGate() {
  const v = el('tokenInput').value.trim();
  const err = el('gateError');
  if (!v) { err.textContent = 'Paste a token to continue.'; err.hidden = false; return; }
  const btn = el('gateUnlock');
  btn.disabled = true; btn.textContent = 'Checking…'; err.hidden = true;
  const res = await checkToken(v);
  btn.disabled = false; btn.textContent = 'Unlock editor';
  if (!res.ok) {
    console.warn('token check failed', res);
    err.textContent = res.reason; err.hidden = false; return;
  }
  setToken(v);
  startEditor();
}

// ---------- IndexedDB (remember the chosen folder) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tf-editor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('handles', 'readonly').objectStore('handles').get(k);
    t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
  });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('handles', 'readwrite').objectStore('handles').put(v, k);
    t.onsuccess = () => res(); t.onerror = () => rej(t.error);
  });
}
