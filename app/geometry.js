// geometry.js: the coordinate math shared by the engine (player) and the editor.
// Hotspot coordinates are stored as normalized fractions (0..1) of the image, so
// they stay aligned at any window size. Both sides MUST use these functions so a
// hotspot drawn in the editor is clickable at the exact same place in the player.

// The drawn-image rectangle inside a box, matching CSS `object-fit: contain`.
// Returns offsets/size in the box's pixel space.
export function containRect(boxW, boxH, imgW, imgH) {
  if (!imgW || !imgH || !boxW || !boxH) return { dx: 0, dy: 0, dw: boxW, dh: boxH };
  const arImg = imgW / imgH;
  const arBox = boxW / boxH;
  let dw, dh;
  if (arImg > arBox) { dw = boxW; dh = boxW / arImg; }   // letterbox top/bottom
  else { dh = boxH; dw = boxH * arImg; }                 // letterbox left/right
  return { dx: (boxW - dw) / 2, dy: (boxH - dh) / 2, dw, dh };
}

// Normalized rect hotspot -> pixel rect (relative to the box top-left).
export function rectToScreen(shape, layout) {
  return {
    x: layout.dx + shape.x * layout.dw,
    y: layout.dy + shape.y * layout.dh,
    w: shape.w * layout.dw,
    h: shape.h * layout.dh,
  };
}

// Pixel point (relative to box top-left) -> normalized image fraction.
// Returns null if the point falls in the letterbox, unless { clamp: true }.
export function screenToNorm(px, py, layout, { clamp = false } = {}) {
  let nx = (px - layout.dx) / layout.dw;
  let ny = (py - layout.dy) / layout.dh;
  if (clamp) {
    nx = Math.min(1, Math.max(0, nx));
    ny = Math.min(1, Math.max(0, ny));
  } else if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    return null;
  }
  return { x: nx, y: ny };
}

export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// Topmost hotspot under a pixel point, or null. (poly shapes: future work.)
export function hitTest(px, py, hotspots, layout) {
  for (let i = hotspots.length - 1; i >= 0; i--) {
    const hs = hotspots[i];
    if (hs.shape && hs.shape.type === 'rect' && pointInRect(px, py, rectToScreen(hs.shape, layout))) {
      return hs;
    }
  }
  return null;
}
