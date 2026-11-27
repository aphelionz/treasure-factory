// editor.js: the authoring tool. Reads the served scene.json + manifest, lets
// you draw / move / resize rectangle hotspots on a photo and assign navigation
// targets, then writes scene.json back to your app/ folder via the File System
// Access API (Chrome/Edge). Falls back to a Download for other browsers.
// Reuses geometry.js so a box drawn here is clickable at the same spot in the player.
import { containRect, rectToScreen, screenToNorm } from './geometry.js';
import { renderAtlas } from './atlas.js';
import { validateScene } from './validate.js';

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
let buildState = 'unknown';
let buildTimer = null;

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
  refreshBuild();
  openAtlas();   // the map is the editor's home screen
}

// ---------- atlas (the map home view) ----------
let atlasApi = null;

function openAtlas() {
  if (!scene) return;
  el('atlasView').hidden = false;   // unhide first so fit-zoom sees real dimensions
  atlasApi = renderAtlas(el('atlasBody'), scene, manifest, {
    currentId: currentNodeId,
    onPick: (id) => { closeAtlas(); selectNode(id); },
  });
  const s = atlasApi.stats;
  el('atlasStats').innerHTML = '<b>' + s.scenes + '</b> scenes · <b>' + s.paths +
    '</b> paths · <b class="gold">' + s.items + '</b> items placed' +
    (s.orphans ? ' · <b style="color:#ff5a6a">' + s.orphans + ' unreachable</b>' : '');
}

function closeAtlas() { el('atlasView').hidden = true; }

function applyMode() {
  const tokenBtn = el('helpTokenBtn');
  tokenBtn.hidden = !HOSTED;
  if (HOSTED) tokenBtn.textContent = 'Sign out';
  const saveBtn = el('saveBtn');
  if (HOSTED) {
    saveBtn.innerHTML = 'Save<span class="wide"> to GitHub</span>';
    setStatus('Saves commit to ' + GH.owner + '/' + GH.repo + '.');
  } else if (IS_LOCAL && FSA) {
    saveBtn.innerHTML = 'Save<span class="wide"> to folder</span>';
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
// Photos added from this device show from memory until Pages has deployed them.
const localPreview = {};
function imageUrl(key) {
  if (localPreview[key]) return localPreview[key];
  const e = manifest[key]; return e ? 'images/' + e.file : '';
}
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
function huntItemList() {
  return (scene.meta && scene.meta.hunt && Array.isArray(scene.meta.hunt.items))
    ? scene.meta.hunt.items : [];
}
function huntItemLabel(id) {
  const it = huntItemList().find(i => i.id === id);
  return (it && it.label) || id || 'item';
}
function populateItemOptions() {
  const sel = el('hsItem');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const it of huntItemList()) {
    const o = document.createElement('option');
    o.value = it.id; o.textContent = it.label + (it.room ? ' (' + it.room + ')' : '');
    sel.appendChild(o);
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

function addNode(img, title = '') {
  let base = (img || 'node').replace(/[^a-z0-9_]+/gi, '_');
  let id = base, i = 2;
  while (scene.nodes.some(n => n.id === id)) id = base + '_' + (i++);
  scene.nodes.push({ id, image: img, title, hotspots: [] });
  if (!scene.meta.entry) scene.meta.entry = id;
  populateNodeSelect(); populateTargetOptions(); markDirty();
  return id;
}
function createNodeFromImage(img) {
  const ans = prompt('Name this room:', '');
  if (ans === null) return;   // cancelled
  selectNode(addNode(img, ans.trim()));
}

// ---------- image grid (the selector) ----------
let gridMode = 'assign';
let linkHotspotId = null;

function openImageGrid(mode) {
  gridMode = mode;
  el('imageGridFilter').value = '';
  el('imageGrid').hidden = false;   // show first so the observer sees real layout
  renderImageGrid('');
  el('imageGridFilter').focus();
}
function closeImageGrid() { el('imageGrid').hidden = true; el('addPhotos').hidden = true; }

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
    tile.className = 'tile' + (owner ? ' used' : '') + (cur && cur.image === key ? ' current' : '') +
      (localPreview[key] ? ' fresh' : '');
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
  if (gridMode === 'link') {
    closeImageGrid();
    const node = currentNode(); if (!node) return;
    const hs = node.hotspots.find(h => h.id === linkHotspotId); if (!hs) return;
    const existing = buildUsedMap()[key];           // link to existing room, or create one
    hs.action = { type: 'goto', target: existing ? existing.id : addNode(key) };
    markDirty(); renderHotspots(); selectHotspot(linkHotspotId);   // stay on current node
    return;
  }
  const node = currentNode();
  closeImageGrid();
  if (!node) return;
  node.image = key; markDirty(); selectNode(node.id);
}

function wireImageGrid() {
  el('imageGridClose').addEventListener('click', closeImageGrid);
  wireAddPhotos();
  el('imageGridFilter').addEventListener('input', (e) => renderImageGrid(e.target.value));
  el('imageGridList').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile'); if (tile) onGridPick(tile.dataset.key);
  });
  el('imageGrid').addEventListener('click', (e) => { if (e.target === el('imageGrid')) closeImageGrid(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('imageGrid').hidden) closeImageGrid(); });
}

// ---------- add photos (hosted) ----------
// Photos picked on a phone (or any browser) are shrunk to the game's size here,
// then committed to app/images/ with an updated manifest in ONE commit via the Git
// Data API, so Pages deploys once. Keys are <room>-NNN numbered from 101 so they
// group into the room on the map and never collide with the Mac's <Folder>-NN
// photos. Entries carry "source": "phone" so build-assets.sh keeps them.
const MAXDIM = 1600, QUALITY = 0.82, PHONE_START = 101;
const MAX_BYTES = 560 * 1024;   // under check-scene.mjs's 600 KB limit, with headroom
const REPO_IMAGES_DIR = 'app/images';
const roomOfKey = (k) => k.replace(/-\d+$/, '');
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (p) => p.split('-').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');

function wireAddPhotos() {
  const btn = el('addPhotosBtn');
  btn.hidden = !HOSTED;
  btn.addEventListener('click', () => {
    const box = el('addPhotos');
    box.hidden = !box.hidden;
    if (!box.hidden) { populateRooms(); el('addStatus').hidden = true; }
  });
  el('addCancel').addEventListener('click', () => { el('addPhotos').hidden = true; });
  el('addRoom').addEventListener('change', (e) => {
    el('addRoomNewRow').hidden = e.target.value !== '__new';
    if (e.target.value === '__new') el('addRoomNew').focus();
  });
  el('addFiles').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';              // let the same photo be picked again later
    if (files.length) await addPhotos(files);
  });
}

function populateRooms() {
  const rooms = [...new Set(Object.keys(manifest).map(roomOfKey))].sort();
  const cur = currentNode();
  const sel = el('addRoom');
  sel.innerHTML = '';
  for (const r of rooms) sel.add(new Option(titleCase(r), r));
  sel.add(new Option('New room…', '__new'));
  if (cur && cur.image && rooms.includes(roomOfKey(cur.image))) sel.value = roomOfKey(cur.image);
  el('addRoomNewRow').hidden = sel.value !== '__new';
}

function addStatus(msg, isErr) {
  const s = el('addStatus');
  s.hidden = false; s.textContent = msg; s.classList.toggle('err', !!isErr);
}

function nextPhoneKey(room, taken) {
  let n = PHONE_START;
  for (const k of taken) {
    if (roomOfKey(k) !== room) continue;
    const num = parseInt(k.slice(room.length + 1), 10);
    if (num >= n) n = num + 1;
  }
  return room + '-' + String(n);
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('could not read this image')); };
    img.src = url;
  });
}

// Resize to fit MAXDIM (never upscale). <img> already applies EXIF rotation, and
// re-encoding through a canvas drops all metadata, including location.
async function shrinkPhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const k = Math.min(1, MAXDIM / Math.max(w0, h0));
    const w = Math.round(w0 * k), h = Math.round(h0 * k);
    if (w >= h) return { landscape: true, w, h };
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    // WebP where the browser can encode it, else JPEG. Step the quality down until the
    // file fits under MAX_BYTES, or the Pages deploy check (scripts/check-scene.mjs) rejects it.
    const encode = async (q) => {
      const webp = await new Promise(r => c.toBlob(r, 'image/webp', q));
      if (webp && webp.type === 'image/webp') return webp;
      return new Promise(r => c.toBlob(r, 'image/jpeg', q));
    };
    let blob = null;
    for (const q of [QUALITY, 0.72, 0.62, 0.5, 0.4]) {
      blob = await encode(q);
      if (!blob) throw new Error('could not encode the image');
      if (blob.size <= MAX_BYTES) break;
    }
    if (blob.size > MAX_BYTES) throw new Error('still too big after compressing (' + Math.round(blob.size / 1024) + ' KB)');
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return { blob, ext, w, h };
  } finally { URL.revokeObjectURL(url); }
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/${path}`, {
    method,
    headers: { ...ghHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = ''; try { msg = (await r.json()).message || ''; } catch (_) {}
    const e = new Error(method + ' ' + path.split('?')[0] + ': ' + r.status + (msg ? ' ' + msg : ''));
    e.status = r.status; throw e;
  }
  return r.status === 204 ? null : r.json();
}

// One commit: image blobs + the merged manifest, on top of the current main.
async function commitPhotos(photos, message) {
  const blobs = [];
  for (const p of photos) {
    const b = await gh('POST', 'git/blobs', { content: p.base64, encoding: 'base64' });
    blobs.push({ path: REPO_IMAGES_DIR + '/' + p.file, mode: '100644', type: 'blob', sha: b.sha });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh('GET', 'git/ref/heads/' + GH_BRANCH);
    const head = ref.object.sha;
    const commit = await gh('GET', 'git/commits/' + head);
    // Merge into the manifest as it is on main right now, not the (maybe stale) deployed copy.
    const cur = await gh('GET', `contents/${REPO_IMAGES_DIR}/manifest.json?ref=${head}`);
    const remote = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cur.content.replace(/\n/g, '')), c => c.charCodeAt(0))));
    for (const p of photos) {
      if (remote[p.key]) throw new Error(p.key + ' already exists on GitHub. Reload the editor and try again.');
      remote[p.key] = { file: p.file, h: p.h, source: 'phone', w: p.w };
    }
    const sorted = Object.fromEntries(Object.keys(remote).sort().map(k => [k, remote[k]]));
    const tree = await gh('POST', 'git/trees', {
      base_tree: commit.tree.sha,
      tree: [...blobs, { path: REPO_IMAGES_DIR + '/manifest.json', mode: '100644', type: 'blob',
        content: JSON.stringify(sorted, null, 2) + '\n' }],
    });
    const next = await gh('POST', 'git/commits', { message, tree: tree.sha, parents: [head] });
    try {
      await gh('PATCH', 'git/refs/heads/' + GH_BRANCH, { sha: next.sha });
      return { sha: next.sha, manifest: sorted };
    } catch (e) {
      if (e.status !== 422 || attempt === 2) throw e;   // main moved under us: rebuild on the new head
    }
  }
}

async function addPhotos(files) {
  let room = el('addRoom').value;
  if (room === '__new') {
    room = slugify(el('addRoomNew').value || '');
    if (!room) { addStatus('Type a name for the new room first.', true); return; }
  }
  const label = el('addFiles').parentElement;
  label.classList.add('busy');
  try {
    const taken = new Set(Object.keys(manifest));
    const photos = [], skipped = [];
    for (let i = 0; i < files.length; i++) {
      addStatus('Shrinking photo ' + (i + 1) + ' of ' + files.length + '…');
      let out;
      try { out = await shrinkPhoto(files[i]); }
      catch (e) { skipped.push(files[i].name + ': ' + e.message); continue; }
      if (out.landscape) { skipped.push(files[i].name + ': landscape (shoot it vertically)'); continue; }
      const key = nextPhoneKey(room, taken);
      taken.add(key);
      photos.push({ key, file: key + '.' + out.ext, w: out.w, h: out.h, blob: out.blob, base64: await blobToBase64(out.blob) });
    }
    if (!photos.length) { addStatus('Nothing to add.\n' + skipped.join('\n'), true); return; }
    addStatus('Saving ' + photos.length + ' photo' + (photos.length > 1 ? 's' : '') + ' to GitHub…');
    const n = photos.length;
    const res = await commitPhotos(photos, `Add ${n} photo${n > 1 ? 's' : ''} to ${titleCase(room)} via editor`);
    manifest = res.manifest;
    for (const p of photos) localPreview[p.key] = URL.createObjectURL(p.blob);
    addStatus('Added ' + photos.map(p => p.key).join(', ') + '. Tap one to use it; the public game has it in about a minute.' +
      (skipped.length ? '\nSkipped:\n' + skipped.join('\n') : ''), skipped.length > 0);
    el('imageGridFilter').value = room;
    renderImageGrid(room);
    setBuildState('building');
    watchBuild(res.sha);
  } catch (e) {
    console.error(e);
    if (e.status === 401 || e.status === 403) addStatus('GitHub refused the upload (' + e.status + '). The token needs Contents: Read and write.', true);
    else addStatus('Upload failed: ' + e.message, true);
  } finally {
    label.classList.remove('busy');
  }
}

// ---------- build status badge (hosted, anonymous Actions read) ----------
// `run` (optional) is the Actions run behind this state; for live/failed we show its
// short commit sha so you can tell at a glance which commit the public site is on.
function setBuildState(s, run) {
  buildState = s;
  const badge = el('buildBadge'); if (!badge) return;
  badge.hidden = !HOSTED;
  badge.className = 'buildbadge ' + s;
  const label = { unsaved: 'Unsaved', building: 'Building', live: 'Live', failed: 'Build failed', unknown: '·' }[s] || s;
  const sha = run && run.head_sha ? run.head_sha.slice(0, 7) : '';
  const showSha = sha && (s === 'live' || s === 'failed');
  el('buildBadgeText').textContent = showSha ? label + ' · ' + sha : label;
  badge.title = showSha
    ? 'GitHub Pages build for commit ' + sha + (run.updated_at ? ' (' + new Date(run.updated_at).toLocaleString() + ')' : '')
    : 'GitHub Pages build status';
}
function stopBuildPoll() { if (buildTimer) { clearTimeout(buildTimer); buildTimer = null; } }
async function fetchLatestRun() {
  try {
    const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/actions/runs?per_page=1`,
      { headers: { 'Accept': 'application/vnd.github+json' } });   // anonymous: public repo, 60/hr
    if (!r.ok) return undefined;                                   // error / rate-limited
    const j = await r.json();
    return (j.workflow_runs && j.workflow_runs[0]) || null;        // null = no runs yet
  } catch (_) { return undefined; }
}
function watchBuild(expectSha) {
  if (!HOSTED) return;
  stopBuildPoll();
  const deadline = Date.now() + 180000;            // give up after 3 min
  const tick = async () => {
    buildTimer = null;
    if (!HOSTED || dirty) return;                  // 'unsaved' is shown by markDirty
    const run = await fetchLatestRun();
    if (dirty) return;
    if (run === undefined) { if (Date.now() < deadline) buildTimer = setTimeout(tick, 15000); return; }
    const ours = !expectSha || (run && run.head_sha === expectSha);
    if (run && run.status === 'completed' && ours) {
      setBuildState(run.conclusion === 'success' ? 'live' : 'failed', run); return;
    }
    setBuildState('building');
    if (Date.now() < deadline) buildTimer = setTimeout(tick, 8000);
  };
  tick();
}
function refreshBuild() {                            // one-shot on load
  if (!HOSTED) { const b = el('buildBadge'); if (b) b.hidden = true; return; }
  if (dirty) { setBuildState('unsaved'); return; }
  fetchLatestRun().then(run => {
    if (dirty) return;
    if (run && run.status === 'completed') setBuildState(run.conclusion === 'success' ? 'live' : 'failed', run);
    else if (run) { setBuildState('building'); watchBuild(); }
    else setBuildState('unknown');
  });
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
    const isFind = hs.action && hs.action.type === 'find';
    let tgtName;
    if (isFind) {
      tgtName = '★ ' + huntItemLabel(hs.action.item);
    } else {
      const target = hs.action && hs.action.target;
      const tgt = target && scene.nodes.find(n => n.id === target);
      tgtName = (tgt && (tgt.title || tgt.id)) || target || hs.id;
      d.title = 'Option-click to follow' + (target ? ' -> ' + tgtName : '');
    }
    if (isFind) d.classList.add('find');
    const label = document.createElement('span');
    label.className = 'hslabel';
    label.textContent = tgtName;
    d.appendChild(label);
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
    const name = document.createElement('span'); name.textContent = hs.id;
    const t = document.createElement('span'); t.className = 't';
    if (hs.action && hs.action.type === 'find') {
      t.textContent = '★ ' + huntItemLabel(hs.action.item);
    } else {
      const tgtId = hs.action && hs.action.target;
      const tNode = tgtId && scene.nodes.find(n => n.id === tgtId);
      t.textContent = '→ ' + ((tNode && (tNode.title || tNode.id)) || tgtId || '?');
    }
    li.append(name, t);
    li.addEventListener('click', () => selectHotspot(hs.id));
    list.appendChild(li);
  }
}

function selectHotspot(id) { selectedId = id; renderHotspots(); updateHsEditor(); }

function updateHsEditor() {
  const hs = currentHotspot();
  const box = el('hsEditor');
  syncSheet();
  if (!hs) { box.hidden = true; return; }
  box.hidden = false;
  el('followHsBtn').hidden = (hs.action && hs.action.type) === 'find';
  const type = (hs.action && hs.action.type) || 'goto';
  el('hsActionType').value = type;
  el('hsTargetRow').hidden = type === 'find';
  el('hsItemRow').hidden = type !== 'find';
  el('hsFxRow').hidden = type === 'find';
  el('hsFx').value = (hs.action && hs.action.transition) || 'dissolve';
  if (type === 'find') {
    populateItemOptions();
    el('hsItem').value = (hs.action && hs.action.item) || '';
  } else {
    populateTargetOptions();
    el('hsTarget').value = (hs.action && hs.action.target) || '';
  }
  const s = hs.shape;
  el('hsCoords').textContent =
    `x ${s.x.toFixed(3)}  y ${s.y.toFixed(3)}  w ${s.w.toFixed(3)}  h ${s.h.toFixed(3)}`;
}

// Play the selected transition on the stage, into the hotspot's target image,
// with the same shared CSS the engine uses. Ends by snapping back to the
// node being edited.
let fxPreviewDone = null;
function previewTransition() {
  const hs = currentHotspot();
  if (!hs || !hs.action || hs.action.type !== 'goto') return;
  const target = scene.nodes.find(n => n.id === hs.action.target);
  const url = target && imageUrl(target.image);
  if (!url) return;

  const fx = hs.action.transition || 'dissolve';
  const layer = el('fxpreview');
  if (fxPreviewDone) fxPreviewDone();
  const finish = () => {
    if (fxPreviewDone !== finish) return;
    fxPreviewDone = null;
    clearTimeout(timer);
    layer.hidden = true;
    layer.className = '';
  };
  fxPreviewDone = finish;
  layer.src = url;
  layer.className = fx === 'cut' ? '' : 'fx-' + fx;
  layer.hidden = false;
  layer.addEventListener('animationend', () => setTimeout(finish, 350), { once: true });
  const timer = setTimeout(finish, 1400);   // covers 'cut' (no animation) and any missed event
}

function deleteSelected() {
  const node = currentNode();
  if (!node || !selectedId) return;
  node.hotspots = node.hotspots.filter(h => h.id !== selectedId);
  selectedId = null;
  markDirty(); renderHotspots(); updateHsEditor();
}

// Delete the current node plus every goto hotspot that leads to it, so no
// door is left pointing at a missing room. The entry node is protected.
function deleteCurrentNode() {
  const node = currentNode();
  if (!node) return;
  if (scene.meta && scene.meta.entry === node.id) {
    alert('"' + (node.title || node.id) + '" is the entry node; the game starts here. ' +
      'Point meta.entry at another node before deleting it.');
    return;
  }
  const inbound = [];
  for (const n of scene.nodes) {
    if (n.id === node.id) continue;
    for (const h of n.hotspots) {
      if (h.action && h.action.type === 'goto' && h.action.target === node.id) inbound.push({ n, h });
    }
  }
  const label = node.title ? node.title + ' (' + node.id + ')' : node.id;
  const msg = inbound.length
    ? 'Delete "' + label + '" and the ' + inbound.length + ' hotspot(s) leading to it?'
    : 'Delete "' + label + '"?';
  if (!confirm(msg)) return;
  for (const { n, h } of inbound) n.hotspots = n.hotspots.filter(x => x !== h);
  scene.nodes = scene.nodes.filter(n => n.id !== node.id);
  selectedId = null;
  markDirty();
  populateNodeSelect(); populateTargetOptions();
  selectNode((scene.meta && scene.meta.entry) || (scene.nodes[0] && scene.nodes[0].id) || null);
  if (!el('atlasView').hidden) openAtlas();   // redraw the map without the node
}

// ---------- pointer interaction ----------
const capture = (e) => { try { overlay.setPointerCapture(e.pointerId); } catch (_) {} };
let pointerActive = false;   // a finger/mouse is down on the photo

overlay.addEventListener('pointerdown', (e) => {
  const node = currentNode();
  if (!node || !frame.naturalWidth) return;
  if (!e.isPrimary) return;     // ignore a second finger
  closeMenu();
  pointerActive = true;
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
        action: { type: 'goto', target: otherNodeId() },
      });
      markDirty(); renderHotspots(); selectHotspot(id);
      linkHotspotId = id; openImageGrid('link');   // pick the destination right away
    }
  } else if ((mode === 'move' || mode === 'resize') && moved) {
    markDirty(); updateHsEditor();
  }
  endPointer();
});

// The browser took the touch (e.g. a system gesture): drop any half-drawn box.
overlay.addEventListener('pointercancel', () => {
  if (tempEl) { tempEl.remove(); tempEl = null; }
  endPointer();
  renderHotspots();
});

function endPointer() {
  mode = 'idle'; dragStart = null; dragOrig = null; moved = false;
  pointerActive = false;
  syncSheet();
}

// On a phone the hotspot panel is a sheet under the photo that grows while a
// hotspot is selected. Only resize it between drags, so the photo never moves
// under a finger.
function syncSheet() {
  if (pointerActive) return;
  document.body.classList.toggle('hs-selected', !!currentHotspot());
}

function closeMenu() {
  document.body.classList.remove('menu-open');
  el('moreBtn').setAttribute('aria-expanded', 'false');
}

function followSelected() {
  const hs = currentHotspot();
  const target = hs && hs.action && hs.action.type === 'goto' && hs.action.target;
  if (target && scene.nodes.some(n => n.id === target)) selectNode(target);
}

// ---------- events ----------
function wireEvents() {
  el('mapBtn').addEventListener('click', () => { closeMenu(); openAtlas(); });
  el('atlasClose').addEventListener('click', closeAtlas);
  el('atlasFit').addEventListener('click', () => atlasApi && atlasApi.setZoom('fit'));
  el('atlas100').addEventListener('click', () => atlasApi && atlasApi.setZoom(1));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('atlasView').hidden && el('imageGrid').hidden) closeAtlas();
  });
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
  el('hsFx').addEventListener('change', (e) => {
    const hs = currentHotspot(); if (!hs || !hs.action || hs.action.type !== 'goto') return;
    if (e.target.value === 'dissolve') delete hs.action.transition;   // default stays implicit
    else hs.action.transition = e.target.value;
    markDirty();
    previewTransition();
  });
  el('hsFxPlay').addEventListener('click', previewTransition);
  el('hsTarget').addEventListener('change', (e) => {
    const hs = currentHotspot(); if (!hs) return;
    hs.action = hs.action || { type: 'goto' };
    hs.action.target = e.target.value; markDirty(); renderHotspots();
  });
  el('hsActionType').addEventListener('change', (e) => {
    const hs = currentHotspot(); if (!hs) return;
    if (e.target.value === 'find') {
      const items = huntItemList();
      hs.action = { type: 'find', item: (hs.action && hs.action.item) || (items[0] && items[0].id) || '' };
    } else {
      hs.action = { type: 'goto', target: (hs.action && hs.action.target) || otherNodeId() };
    }
    markDirty(); renderHotspots(); updateHsEditor();
  });
  el('hsItem').addEventListener('change', (e) => {
    const hs = currentHotspot(); if (!hs || !hs.action || hs.action.type !== 'find') return;
    hs.action.item = e.target.value; markDirty(); renderHotspots();
  });
  el('deleteHsBtn').addEventListener('click', deleteSelected);
  el('followHsBtn').addEventListener('click', followSelected);
  el('doneHsBtn').addEventListener('click', () => selectHotspot(null));
  el('moreBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = document.body.classList.toggle('menu-open');
    el('moreBtn').setAttribute('aria-expanded', String(open));
  });
  // Close the phone menu after any action in it, or on a tap elsewhere.
  el('toolExtras').addEventListener('click', (e) => { if (e.target.closest('button')) closeMenu(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#toolExtras') && !e.target.closest('#moreBtn')) closeMenu();
  });
  // The stage changes size when the phone sheet grows or shrinks; keep boxes on the photo.
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (mode === 'idle') renderHotspots(); }).observe(el('stage'));
  el('deleteNodeBtn').addEventListener('click', deleteCurrentNode);
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

function markDirty() { dirty = true; setStatus('Unsaved changes'); if (HOSTED) { stopBuildPoll(); setBuildState('unsaved'); } }
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
  // Same check CI runs: never write a scene.json that would break the game.
  const { errors } = validateScene(scene, manifest);
  if (errors.length) {
    console.warn('scene.json not saved:', errors);
    setStatus('Not saved: ' + errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more, see console)` : ''));
    return;
  }
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
    const body = await r.json().catch(() => null);
    setBuildState('building');
    watchBuild(body && body.commit && body.commit.sha);
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
