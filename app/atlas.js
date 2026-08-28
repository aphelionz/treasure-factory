// atlas.js: the editor's home view. Draws scene.json as a constellation: the
// entry spine, then each room as a ring of photo nodes around its hub, the way
// the scenes actually chain in play. Everything is derived from the scene graph
// on each render; the atlas holds no state of its own.

export function renderAtlas(container, scene, manifest, { onPick, currentId } = {}) {
  const byId = new Map(scene.nodes.map(n => [n.id, n]));
  const gotos = (n) => (n.hotspots || [])
    .filter(h => h.action && h.action.type === 'goto' && byId.has(h.action.target))
    .map(h => h.action.target);
  const findsOf = (n) => (n.hotspots || []).filter(h => h.action && h.action.type === 'find');

  // --- structure: entry -> hub -> room rings (nested rooms hang off their parent) ---
  const entry = (scene.meta && scene.meta.entry) || (scene.nodes[0] && scene.nodes[0].id);
  const hub = entry ? (gotos(byId.get(entry))[0] || entry) : null;
  const backrefs = new Map();
  for (const n of scene.nodes) for (const t of gotos(n)) backrefs.set(t, (backrefs.get(t) || 0) + 1);

  const roomHubs = hub ? gotos(byId.get(hub)).filter(t => t !== entry) : [];
  const spineIds = new Set([entry, hub, ...roomHubs]);
  for (const h of [...roomHubs]) {           // a hub's target that many nodes link back to is a nested room
    for (const t of gotos(byId.get(h))) {
      if (!spineIds.has(t) && (backrefs.get(t) || 0) > 2) { roomHubs.push(t); spineIds.add(t); }
    }
  }
  const cluster = new Map();
  for (const n of scene.nodes) {
    if (spineIds.has(n.id)) continue;
    const home = gotos(n).find(t => roomHubs.includes(t));
    if (home) cluster.set(n.id, home);
  }
  const ringOrder = (h) => {                 // walk the room's next/previous chain from the hub's first door
    const members = scene.nodes.filter(n => cluster.get(n.id) === h).map(n => n.id);
    const inRoom = new Set(members);
    const seen = [];
    let cur = gotos(byId.get(h)).find(t => inRoom.has(t)) || members[0];
    while (cur && !seen.includes(cur)) {
      seen.push(cur);
      cur = gotos(byId.get(cur)).find(t => inRoom.has(t) && !seen.includes(t));
    }
    for (const m of members) if (!seen.includes(m)) seen.push(m);
    return seen;
  };

  // --- layout: spine on a horizontal axis, rings alternating above / below it ---
  const pos = new Map();
  if (entry) pos.set(entry, { x: 0, y: 0 });
  if (hub && hub !== entry) pos.set(hub, { x: 300, y: 0 });
  let cursor = 560;
  const rings = [];
  roomHubs.forEach((h, i) => {
    const order = ringOrder(h);
    const r = Math.max(150, Math.round(order.length * 103 / (2 * Math.PI)));
    const cx = cursor + r;
    const cy = (i % 2 === 0 ? -1 : 1) * (r * 0.35 + 165);
    cursor = cx + r + 200;
    pos.set(h, { x: cx, y: cy });
    order.forEach((id, j) => {
      const a = -Math.PI / 2 + (j / order.length) * Math.PI * 2;
      pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    });
    rings.push({ hub: h, r, count: order.length });
  });
  scene.nodes.filter(n => !pos.has(n.id)).forEach((n, i) => {   // unlinked scenes: parked on the axis
    pos.set(n.id, { x: cursor + i * 110, y: 0 });
  });

  const PAD = 100, LABEL = 130;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, p] of pos) {
    minX = Math.min(minX, p.x - 60); maxX = Math.max(maxX, p.x + 60);
    minY = Math.min(minY, p.y - 60); maxY = Math.max(maxY, p.y + 60);
  }
  for (const ring of rings) {
    const p = pos.get(ring.hub);
    minY = Math.min(minY, p.y - ring.r - LABEL);
  }
  for (const p of pos.values()) { p.x += PAD - minX; p.y += PAD - minY; }
  const W = Math.ceil(maxX - minX + PAD * 2), H = Math.ceil(maxY - minY + PAD * 2);

  // --- render ---
  container.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'at-shell';
  const canvas = document.createElement('div');
  canvas.className = 'at-canvas';
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  shell.appendChild(canvas);
  container.appendChild(shell);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  canvas.appendChild(svg);

  const edgeEls = new Map();
  const seenEdges = new Set();
  let edgeCount = 0;
  for (const n of scene.nodes) {
    for (const t of gotos(n)) {
      const key = [n.id, t].sort().join('|');
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edgeCount++;
      const a = pos.get(n.id), b = pos.get(t);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      const cls = (spineIds.has(n.id) && spineIds.has(t)) ? 'at-spine'
        : (spineIds.has(n.id) || spineIds.has(t)) ? 'at-spoke' : 'at-ring';
      line.setAttribute('class', cls);
      svg.appendChild(line);
      if (!edgeEls.has(n.id)) edgeEls.set(n.id, []);
      if (!edgeEls.has(t)) edgeEls.set(t, []);
      edgeEls.get(n.id).push(line);
      edgeEls.get(t).push(line);
    }
  }

  const tip = document.createElement('div');
  tip.className = 'at-tip';
  tip.hidden = true;

  const nodeEls = new Map();
  let itemCount = 0;
  for (const n of scene.nodes) {
    const p = pos.get(n.id);
    const finds = findsOf(n);
    itemCount += finds.length;
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'at-node'
      + (roomHubs.includes(n.id) ? ' at-hub' : '')
      + (n.id === entry || n.id === hub ? ' at-hub at-entry' : '')
      + (n.id === currentId ? ' at-cur' : '');
    d.style.left = p.x + 'px';
    d.style.top = p.y + 'px';
    const img = manifest[n.image];
    if (img) d.style.backgroundImage = 'url(images/' + img.file + ')';
    d.setAttribute('aria-label', n.title || n.id);
    if (finds.length) {
      const b = document.createElement('span');
      b.className = 'at-badge';
      b.textContent = '★' + finds.length;
      d.appendChild(b);
    }
    d.addEventListener('mouseenter', () => {
      for (const l of edgeEls.get(n.id) || []) l.classList.add('at-lit');
      for (const t of gotos(n)) nodeEls.get(t) && nodeEls.get(t).classList.add('at-lit');
      tip.textContent = (n.title || n.id) + (finds.length ? ' · ★' + finds.length : '');
      tip.style.left = p.x + 'px';
      tip.style.top = (p.y - (d.classList.contains('at-hub') ? 50 : 38)) + 'px';
      tip.hidden = false;
    });
    d.addEventListener('mouseleave', () => {
      for (const l of edgeEls.get(n.id) || []) l.classList.remove('at-lit');
      for (const t of gotos(n)) nodeEls.get(t) && nodeEls.get(t).classList.remove('at-lit');
      tip.hidden = true;
    });
    d.addEventListener('click', () => onPick && onPick(n.id));
    canvas.appendChild(d);
    nodeEls.set(n.id, d);
  }
  canvas.appendChild(tip);

  for (const ring of rings) {
    const n = byId.get(ring.hub);
    const p = pos.get(ring.hub);
    const items = scene.nodes
      .filter(x => cluster.get(x.id) === ring.hub || x.id === ring.hub)
      .reduce((s, x) => s + findsOf(x).length, 0);
    const l = document.createElement('div');
    l.className = 'at-roomlabel';
    l.style.left = p.x + 'px';
    l.style.top = (p.y - ring.r - LABEL + 8) + 'px';
    const name = document.createElement('div');
    name.textContent = n.title || n.id;
    const sub = document.createElement('small');
    sub.textContent = ring.count + ' scenes · ' + items + ' items';
    l.append(name, sub);
    canvas.appendChild(l);
  }

  let zoom = 1;
  let fitTries = 0;
  const setZoom = (z) => {
    if (z === 'fit') {
      const cw = container.clientWidth - 8, ch = container.clientHeight - 8;
      if ((cw < 50 || ch < 50) && fitTries++ < 300) {
        // container not laid out yet (first paint); try again next frame
        requestAnimationFrame(() => setZoom('fit'));
        return;
      }
      fitTries = 0;
      zoom = Math.max(0.1, Math.min(1, cw / W, ch / H));
    } else {
      zoom = z;
    }
    canvas.style.transform = 'scale(' + zoom + ')';
    shell.style.width = Math.ceil(W * zoom) + 'px';
    shell.style.height = Math.ceil(H * zoom) + 'px';
  };
  setZoom('fit');

  return {
    setZoom,
    stats: { scenes: scene.nodes.length, paths: edgeCount, items: itemCount },
  };
}
