/**
 * 2-D hit-testing primitives for vector strokes. Used by the
 * object-eraser tool (tap a stroke to remove it) and the lasso
 * tool (drag-loop to select every stroke inside).
 *
 * The functions are pure geometry — they operate on `{x, y}` points,
 * not Stroke objects — so the sketch modal can pass slimmed views in
 * and call out to these without dragging the renderer along.
 */

export type Point2D = { x: number; y: number };

/** Squared distance from a point to a line segment, in CSS px². */
function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/** Distance from a point to a polyline (the closest segment wins). */
export function distanceToPolyline(px: number, py: number, points: Point2D[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) {
    return Math.hypot(points[0].x - px, points[0].y - py);
  }
  let min = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d2 = distSqToSegment(px, py, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
    if (d2 < min) min = d2;
  }
  return Math.sqrt(min);
}

/** Ray-cast point-in-polygon. The polygon need not be closed — the
 *  last vertex is implicitly connected to the first. */
export function pointInPolygon(px: number, py: number, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = (yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Axis-aligned bounding box of a polyline. Used by lasso "selection
 *  bbox" to detect drag-to-move starts. Returns null for an empty
 *  point list. */
export function polylineBBox(points: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) return null;
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}
