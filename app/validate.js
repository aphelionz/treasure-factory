// validate.js: integrity checks for scene.json, shared by the editor (before a
// save) and CI (scripts/check-scene.mjs). Pure function, no DOM, no deps.
//
// errors   = the game is broken (missing room, missing photo, bad box). CI fails.
// warnings = the game works but a player could get stuck or miss content.

export const TRANSITIONS = ['dissolve', 'cut', 'wipe', 'zoom', 'iris'];
const EPS = 1e-6;   // float slack for boxes drawn right up to the photo edge

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => typeof v === 'string' && v.length > 0;

export function validateScene(scene, manifest) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!scene || typeof scene !== 'object') {
    err('scene.json is not an object');
    return { errors, warnings };
  }
  if (scene.schemaVersion !== 1) err(`schemaVersion is ${JSON.stringify(scene.schemaVersion)}, expected 1`);
  if (!Array.isArray(scene.nodes) || !scene.nodes.length) {
    err('scene.nodes must be a non-empty array');
    return { errors, warnings };
  }

  // --- nodes ---
  const nodeById = new Map();
  scene.nodes.forEach((n, i) => {
    if (!n || !isId(n.id)) { err(`nodes[${i}] has no id`); return; }
    if (nodeById.has(n.id)) err(`duplicate node id "${n.id}"`);
    nodeById.set(n.id, n);
  });

  const meta = scene.meta || {};
  if (!isId(meta.entry)) err('meta.entry is missing');
  else if (!nodeById.has(meta.entry)) err(`meta.entry "${meta.entry}" is not a node`);

  // --- hunt catalog ---
  const items = new Map();
  const hunt = meta.hunt;
  if (hunt !== undefined) {
    if (!hunt || !Array.isArray(hunt.items)) err('meta.hunt.items must be an array');
    else hunt.items.forEach((it, i) => {
      if (!it || !isId(it.id)) { err(`meta.hunt.items[${i}] has no id`); return; }
      if (items.has(it.id)) err(`duplicate hunt item id "${it.id}"`);
      if (!isId(it.label)) err(`hunt item "${it.id}" has no label`);
      if (!Number.isInteger(it.count) || it.count < 1) err(`hunt item "${it.id}" count must be a positive integer`);
      items.set(it.id, it);
    });
  }

  // --- per-node checks ---
  for (const n of nodeById.values()) {
    const where = `node "${n.id}"`;
    if (!isId(n.image)) err(`${where} has no image`);
    else if (manifest && !manifest[n.image]) err(`${where} uses image "${n.image}", which is not in images/manifest.json`);

    if (!Array.isArray(n.hotspots)) { err(`${where} hotspots must be an array`); continue; }
    const hsIds = new Set();
    for (const [i, hs] of n.hotspots.entries()) {
      const hw = `${where} hotspot ${hs && hs.id ? `"${hs.id}"` : `#${i}`}`;
      if (!hs || !isId(hs.id)) err(`${hw} has no id`);
      else if (hsIds.has(hs.id)) err(`${where} has duplicate hotspot id "${hs.id}"`);
      else hsIds.add(hs.id);

      const s = hs && hs.shape;
      if (!s || s.type !== 'rect') err(`${hw} shape must be {type:"rect"} (the player ignores anything else)`);
      else if (![s.x, s.y, s.w, s.h].every(isNum)) err(`${hw} rect needs numeric x, y, w, h`);
      else {
        if (s.w <= 0 || s.h <= 0) err(`${hw} has zero or negative size`);
        if (s.x < -EPS || s.y < -EPS || s.x + s.w > 1 + EPS || s.y + s.h > 1 + EPS)
          err(`${hw} box falls outside the photo (coordinates must stay within 0..1)`);
      }

      const a = hs && hs.action;
      if (!a) { err(`${hw} has no action`); continue; }
      if (a.type === 'goto') {
        if (!nodeById.has(a.target)) err(`${hw} goes to "${a.target}", which is not a node`);
        else if (a.target === n.id) warn(`${hw} goes to its own node`);
        if (a.transition !== undefined && !TRANSITIONS.includes(a.transition))
          err(`${hw} transition "${a.transition}" is not one of ${TRANSITIONS.join(', ')}`);
      } else if (a.type === 'find') {
        if (!items.has(a.item)) err(`${hw} finds "${a.item}", which is not in meta.hunt.items`);
      } else {
        err(`${hw} action type "${a.type}" is not goto or find`);
      }
    }
    if (!n.hotspots.some(h => h && h.action && h.action.type === 'goto'))
      warn(`${where} is a dead end: no way out once a player arrives`);
  }

  // --- reachability from the entry ---
  if (nodeById.has(meta.entry)) {
    const seen = new Set([meta.entry]);
    const stack = [meta.entry];
    while (stack.length) {
      const n = nodeById.get(stack.pop());
      for (const h of (n && Array.isArray(n.hotspots) ? n.hotspots : [])) {
        const t = h && h.action && h.action.type === 'goto' && h.action.target;
        if (t && nodeById.has(t) && !seen.has(t)) { seen.add(t); stack.push(t); }
      }
    }
    for (const id of nodeById.keys()) if (!seen.has(id)) warn(`node "${id}" can't be reached from the entry`);
  }

  return { errors, warnings };
}
