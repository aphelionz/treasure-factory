// atlas.js: the editor's home view. Draws scene.json as a constellation of
// rooms. A room is a photo folder (the image-key prefix, e.g. green-and-gold),
// not anything inferred from wiring, so the grouping stays true no matter how
// the scenes are linked. Edges are the actual goto hotspots. Everything is
// re-derived on each render; the atlas holds no state of its own.

export function renderAtlas(container, scene, manifest, { onPick, currentId } = {}) {
  const byId = new Map(scene.nodes.map(n => [n.id, n]));
  const gotos = (n) => (n.hotspots || [])
    .filter(h => h.action && h.action.type === 'goto' && byId.has(h.action.target))
    .map(h => h.action.target);
  const findsOf = (n) => (n.hotspots || []).filter(h => h.action && h.action.type === 'find');
  const entry = (scene.meta && scene.meta.entry) || (scene.nodes[0] && scene.nodes[0].id);

  // --- rooms: group nodes by image folder prefix ---
  const prefixOf = (n) => (n.image || 'unplaced').replace(/-\d+$/, '');
  const roomName = (p) => p.split('-').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  const rooms = new Map();               // prefix -> [node ids]
  for (const n of scene.nodes) {
    const p = prefixOf(n);
    if (!rooms.has(p)) rooms.set(p, []);
    rooms.get(p).push(n.id);
  }

  // reachability from the entry (unreachable nodes get flagged red)
  const reachable = new Set();
  const stack = [entry];
  while (stack.length) {
    const x = stack.pop();
    if (!x || reachable.has(x) || !byId.has(x)) continue;
    reachable.add(x);
    stack.push(...gotos(byId.get(x)));
  }

  // a room's hub is its main entrance: the member most linked from other rooms,
  // ties broken by total connections
  const inboundOutside = new Map(), degree = new Map();
  for (const n of scene.nodes) {
    for (const t of gotos(n)) {
      degree.set(n.id, (degree.get(n.id) || 0) + 1);
      degree.set(t, (degree.get(t) || 0) + 1);
      if (prefixOf(n) !== prefixOf(byId.get(t))) {
        inboundOutside.set(t, (inboundOutside.get(t) || 0) + 1);
      }
    }
  }
  const hubOf = new Map();
  for (const [p, members] of rooms) {
    hubOf.set(p, [...members].sort((a, b) =>
      (inboundOutside.get(b) || 0) - (inboundOutside.get(a) || 0) ||
      (degree.get(b) || 0) - (degree.get(a) || 0))[0]);
  }

  // order rooms by discovery from the entry's room, so the layout reads left to right
  const roomAdj = new Map([...rooms.keys()].map(p => [p, new Set()]));
  for (const n of scene.nodes) {
    for (const t of gotos(n)) {
      const a = prefixOf(n), b = prefixOf(byId.get(t));
      if (a !== b) { roomAdj.get(a).add(b); roomAdj.get(b).add(a); }
    }
  }
  const roomOrder = [];
  const rq = [prefixOf(byId.get(entry))];
  const rseen = new Set(rq);
  while (rq.length) {
    const p = rq.shift();
    roomOrder.push(p);
    for (const q of roomAdj.get(p) || []) if (!rseen.has(q)) { rseen.add(q); rq.push(q); }
  }
  for (const p of rooms.keys()) if (!rseen.has(p)) roomOrder.push(p);   // isolated rooms last

  // --- layout: rooms chained left to right, rings alternating above / below ---
  const pos = new Map();
  const ringMeta = [];
  let cursor = 60;
  let ringIdx = 0;
  for (const p of roomOrder) {
    const members = rooms.get(p);
    const hub = hubOf.get(p);
    if (members.length === 1) {
      pos.set(members[0], { x: cursor + 60, y: 0 });
      ringMeta.push({ p, hub, r: 0, cx: cursor + 60, cy: 0 });
      cursor += 300;
      continue;
    }
    // ring members walk the room's internal chain from the hub's first door
    const inRoom = new Set(members);
    const order = [];
    let cur = gotos(byId.get(hub)).find(t => inRoom.has(t) && t !== hub);
    while (cur && !order.includes(cur)) {
      order.push(cur);
      cur = gotos(byId.get(cur)).find(t => inRoom.has(t) && t !== hub && !order.includes(t));
    }
    for (const m of members) if (m !== hub && !order.includes(m)) order.push(m);
    const r = Math.max(150, Math.round(order.length * 103 / (2 * Math.PI)));
    const cx = cursor + r;
    const cy = (ringIdx++ % 2 === 0 ? -1 : 1) * (r * 0.3 + 130);
    pos.set(hub, { x: cx, y: cy });
    order.forEach((id, j) => {
      const a = -Math.PI / 2 + (j / order.length) * Math.PI * 2;
      pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    });
    ringMeta.push({ p, hub, r, cx, cy });
    cursor = cx + r + 220;
  }

  const PAD = 110, LABEL = 96;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pnt of pos.values()) {
    minX = Math.min(minX, pnt.x - 70); maxX = Math.max(maxX, pnt.x + 70);
    minY = Math.min(minY, pnt.y - 70); maxY = Math.max(maxY, pnt.y + 70);
  }
  for (const m of ringMeta) minY = Math.min(minY, m.cy - m.r - LABEL - 40);
  for (const pnt of pos.values()) { pnt.x += PAD - minX; pnt.y += PAD - minY; }
  for (const m of ringMeta) { m.cx += PAD - minX; m.cy += PAD - minY; }
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
  const hubs = new Set(hubOf.values());
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
      const cross = prefixOf(n) !== prefixOf(byId.get(t));
      line.setAttribute('class', cross ? 'at-spine' : (hubs.has(n.id) || hubs.has(t)) ? 'at-spoke' : 'at-ring');
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
  let itemCount = 0, orphanCount = 0;
  for (const n of scene.nodes) {
    const p = pos.get(n.id);
    const finds = findsOf(n);
    itemCount += finds.length;
    const orphan = !reachable.has(n.id);
    if (orphan) orphanCount++;
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'at-node'
      + (hubs.has(n.id) ? ' at-hub' : '')
      + (n.id === entry ? ' at-entry' : '')
      + (orphan ? ' at-orphan' : '')
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
      tip.textContent = (n.title || n.id)
        + (finds.length ? ' · ★' + finds.length : '')
        + (orphan ? ' · UNREACHABLE' : '');
      tip.style.left = p.x + 'px';
      tip.style.top = (p.y - (d.classList.contains('at-hub') ? 54 : 42)) + 'px';
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

  for (const m of ringMeta) {
    const members = rooms.get(m.p);
    const items = members.reduce((s, id) => s + findsOf(byId.get(id)).length, 0);
    const l = document.createElement('div');
    l.className = 'at-roomlabel';
    l.style.left = m.cx + 'px';
    l.style.top = (m.cy - m.r - LABEL) + 'px';
    const name = document.createElement('div');
    name.textContent = roomName(m.p);
    const sub = document.createElement('small');
    sub.textContent = members.length + (members.length === 1 ? ' scene' : ' scenes') + ' · ' + items + ' items';
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
    stats: { scenes: scene.nodes.length, paths: edgeCount, items: itemCount, orphans: orphanCount },
  };
}
