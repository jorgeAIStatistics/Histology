// Pure geometry helpers for annotations. Stored coordinates are LEVEL-0 PIXELS
// (x right, y down, origin top-left of level 0). The viewer converts screen points with
// OpenSeadragon's TiledImage.viewerElementToImageCoordinates and adds the DZI bounds offset.

export type Pt = { x: number; y: number };
export type RectGeom = { type: "rectangle"; x: number; y: number; width: number; height: number };
export type PolyGeom = { type: "polygon"; points: [number, number][] };
export type DraftGeom = RectGeom | PolyGeom;

export function clampToImage(p: Pt, width: number, height: number): Pt {
  return { x: Math.min(Math.max(p.x, 0), width), y: Math.min(Math.max(p.y, 0), height) };
}

/** Rotation normalised to [0, 360). */
export function normRotation(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * A rectangle dragged on screen. On a view rotated by a multiple of 90° the four corners are still an
 * axis-aligned rectangle in level 0, so it is stored as a rectangle; on any other rotation the API
 * contract says it must be a polygon.
 */
export function rectangleFromScreenCorners(corners: Pt[], rotationDeg: number): DraftGeom {
  if (corners.length !== 4) throw new Error("need four corners");
  const r = normRotation(rotationDeg);
  if (Math.abs(r % 90) < 1e-9) {
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { type: "rectangle", x: round3(x), y: round3(y), width: round3(Math.max(...xs) - x), height: round3(Math.max(...ys) - y) };
  }
  return { type: "polygon", points: corners.map((c) => [round3(c.x), round3(c.y)] as [number, number]) };
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The exterior ring of a stored annotation (closed: last point equals the first). */
export function ringOf(geometry: { coordinates: number[][][] }): Pt[] {
  const ring = geometry.coordinates?.[0] ?? [];
  return ring.map(([x, y]) => ({ x, y }));
}

/** Ring without the closing point. */
export function openRing(ring: Pt[]): Pt[] {
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a.x === b.x && a.y === b.y) return ring.slice(0, -1);
  }
  return ring;
}

export function polygonArea(points: Pt[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function distinctCount(points: Pt[]): number {
  return new Set(points.map((p) => `${p.x},${p.y}`)).size;
}

/** A "nice" scale-bar length (1, 2 or 5 × 10^n µm) that renders between minPx and maxPx. */
export function niceScaleBar(micronsPerScreenPixel: number, targetPx = 120): { microns: number; px: number; label: string } | null {
  if (!Number.isFinite(micronsPerScreenPixel) || micronsPerScreenPixel <= 0) return null;
  const raw = micronsPerScreenPixel * targetPx;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const nice = base >= 5 ? 5 : base >= 2 ? 2 : 1;
  const microns = nice * 10 ** exp;
  const px = microns / micronsPerScreenPixel;
  const label = microns >= 1000 ? `${microns / 1000} mm` : microns >= 1 ? `${microns} µm` : `${microns.toPrecision(1)} µm`;
  return { microns, px, label };
}
