"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { clampToImage, niceScaleBar, normRotation, openRing, rectangleFromScreenCorners, ringOf, round3, type DraftGeom, type Pt } from "@/lib/geometry";
import type { Annotation, Slide, ViewerToken } from "@/lib/types";

/* Minimal structural types for the parts of OpenSeadragon 6 used here. */
type OsdPoint = { x: number; y: number };
type OsdTiledImage = {
  imageToViewerElementCoordinates(p: OsdPoint): OsdPoint;
  viewerElementToImageCoordinates(p: OsdPoint): OsdPoint;
  viewportToImageZoom(z: number): number;
  setOpacity(o: number): void;
  imageToViewportRectangle(x: number, y: number, w: number, h: number): unknown;
};
type OsdViewport = {
  getZoom(current?: boolean): number;
  zoomBy(f: number, refPoint?: OsdPoint, immediately?: boolean): void;
  applyConstraints(immediately?: boolean): void;
  goHome(immediately?: boolean): void;
  getRotation(current?: boolean): number;
  setRotation(deg: number, immediately?: boolean): void;
  pointFromPixel(p: OsdPoint, current?: boolean): OsdPoint;
  panBy(delta: OsdPoint, immediately?: boolean): void;
  getBounds(current?: boolean): { x: number; y: number; width: number; height: number };
  getContainerSize(): OsdPoint;
  fitBounds(rect: unknown, immediately?: boolean): void;
};
type OsdViewer = {
  viewport: OsdViewport;
  world: { getItemAt(i: number): OsdTiledImage | undefined; getItemCount(): number; removeItem(item: OsdTiledImage): void };
  addHandler(name: string, fn: (e: Record<string, unknown>) => void): void;
  addTiledImage(opts: Record<string, unknown>): void;
  destroy(): void;
  drawer?: { canvas?: HTMLCanvasElement };
  canvas?: HTMLElement;
};
type OsdModule = {
  (opts: Record<string, unknown>): OsdViewer;
  Point: new (x: number, y: number) => OsdPoint;
};

export type Tool = "pan" | "rect" | "polygon";

export type DraftMeta = {
  rotation_deg: number;
  viewport_zoom: number;
  image_zoom: number;
  container_px: [number, number];
  tool: Tool;
};

export type ViewerHandle = {
  zoomBy: (f: number) => void;
  home: () => void;
  rotateBy: (deg: number) => void;
  panBy: (dx: number, dy: number) => void;
  rotation: () => number;
  /** A rectangle covering the centre of the current view (keyboard alternative to dragging). */
  centreRectangle: () => { geometry: DraftGeom; meta: DraftMeta } | null;
  cancelDraft: () => void;
  finishPolygon: () => void;
  undoVertex: () => void;
  /** Zoom to a level-0 box (with a margin). */
  fitLevel0Box: (x0: number, y0: number, x1: number, y1: number) => void;
};

export type ViewerMetrics = {
  tokenMs: number | null;
  openMs: number | null;
  firstTileMs: number | null;
  firstTileSinceNavigationMs: number | null;
  tilesLoaded: number;
  tilesFailed: number;
};

type Props = {
  slide: Slide;
  annotations: Annotation[];
  regions: { id: string; ring: Pt[]; label: string }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  tool: Tool;
  pendingDraft: DraftGeom | null;
  onDraft: (g: DraftGeom, meta: DraftMeta) => void;
  maskPngUrl: string | null;
  attention?: { x: number; y: number; w: number; h: number; weight: number }[] | null;
  onMetrics?: (m: ViewerMetrics) => void;
  onStatus?: (s: { zoomPct: number; rotation: number; microns: number | null }) => void;
};

const COLORS: Record<string, string> = {
  region_of_interest: "#2fb3ad",
  artifact: "#f2b84b",
  other: "#c9a7e8",
};

export const SlideViewer = forwardRef<ViewerHandle, Props>(function SlideViewer(
  { slide, annotations, regions, selectedId, onSelect, tool, pendingDraft, onDraft, maskPngUrl, attention, onMetrics, onStatus },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OsdViewer | null>(null);
  const osdRef = useRef<OsdModule | null>(null);
  const tokenRef = useRef<string | null>(null);
  const offsetRef = useRef<[number, number]>([0, 0]);
  const maskItemRef = useRef<OsdTiledImage | null>(null);
  const [frame, setFrame] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [drag, setDrag] = useState<{ a: Pt; b: Pt } | null>(null); // screen points while dragging a rectangle
  const [poly, setPoly] = useState<Pt[]>([]); // image (level-0) points while drawing a polygon
  const [hover, setHover] = useState<Pt | null>(null);
  const metrics = useRef<ViewerMetrics>({ tokenMs: null, openMs: null, firstTileMs: null, firstTileSinceNavigationMs: null, tilesLoaded: 0, tilesFailed: 0 });
  // Signed tile tokens are bound to the demo user: after a role switch the old token is refused (403), so the
  // viewer is rebuilt with a token for the new user instead of showing upsampled tiles until the timed refresh.
  const userId = useSession().me?.user.id ?? null;
  const W = slide.width ?? 0;
  const H = slide.height ?? 0;

  const item = useCallback(() => viewerRef.current?.world.getItemAt(0) ?? null, []);

  /** level-0 → viewer-element pixels */
  const toScreen = useCallback(
    (p: Pt): Pt | null => {
      const ti = item();
      const OSD = osdRef.current;
      if (!ti || !OSD) return null;
      const s = ti.imageToViewerElementCoordinates(new OSD.Point(p.x - offsetRef.current[0], p.y - offsetRef.current[1]));
      return { x: s.x, y: s.y };
    },
    [item],
  );

  /** viewer-element pixels → level-0 */
  const toLevel0 = useCallback(
    (p: Pt): Pt | null => {
      const ti = item();
      const OSD = osdRef.current;
      if (!ti || !OSD) return null;
      const i = ti.viewerElementToImageCoordinates(new OSD.Point(p.x, p.y));
      return { x: i.x + offsetRef.current[0], y: i.y + offsetRef.current[1] };
    },
    [item],
  );

  const currentMeta = useCallback((t: Tool): DraftMeta => {
    const v = viewerRef.current!;
    const ti = item();
    const z = v.viewport.getZoom(true);
    const cs = v.viewport.getContainerSize();
    return {
      rotation_deg: normRotation(v.viewport.getRotation(true)),
      viewport_zoom: z,
      image_zoom: ti ? ti.viewportToImageZoom(z) : 0,
      container_px: [Math.round(cs.x), Math.round(cs.y)],
      tool: t,
    };
  }, [item]);

  // ------------------------------------------------------------------ viewer lifecycle
  useEffect(() => {
    let disposed = false;
    let refresh: number | undefined;
    const t0 = performance.now();
    metrics.current = { tokenMs: null, openMs: null, firstTileMs: null, firstTileSinceNavigationMs: null, tilesLoaded: 0, tilesFailed: 0 };
    setReady(false);
    setError(null);
    (async () => {
      try {
        const tok = await api<ViewerToken>(`/slides/${slide.id}/viewer-token`);
        if (disposed) return;
        metrics.current.tokenMs = Math.round(performance.now() - t0);
        tokenRef.current = tok.token;
        offsetRef.current = tok.bounds_offset_level0 ?? [0, 0];
        const xml = await fetch(tok.dzi_url, { credentials: "same-origin" }).then((r) => {
          if (!r.ok) throw new Error(`The tile service refused the slide descriptor (HTTP ${r.status})`);
          return r.text();
        });
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        const img = doc.getElementsByTagName("Image")[0];
        const size = doc.getElementsByTagName("Size")[0];
        const tileSize = Number(img.getAttribute("TileSize"));
        const overlap = Number(img.getAttribute("Overlap"));
        const format = img.getAttribute("Format") ?? "jpeg";
        const width = Number(size.getAttribute("Width"));
        const height = Number(size.getAttribute("Height"));
        const mod = await import("openseadragon");
        if (disposed || !hostRef.current) return;
        const OSD = (mod.default ?? mod) as unknown as OsdModule;
        osdRef.current = OSD;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const viewer = OSD({
          element: hostRef.current,
          drawer: "canvas",
          showNavigationControl: false,
          showNavigator: true,
          navigatorPosition: "BOTTOM_RIGHT",
          navigatorSizeRatio: 0.16,
          navigatorAutoFade: false,
          keyboardNavEnabled: false,
          animationTime: reduce ? 0 : 0.9,
          springStiffness: reduce ? 100 : 6.5,
          blendTime: 0,
          immediateRender: false,
          maxZoomPixelRatio: 2,
          minZoomImageRatio: 0.6,
          visibilityRatio: 0.4,
          crossOriginPolicy: false,
          loadTilesWithAjax: false,
          gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, scrollToZoom: true },
          tileSources: {
            width,
            height,
            tileSize,
            tileOverlap: overlap,
            minLevel: 0,
            getTileUrl: (level: number, x: number, y: number) => `/api/v1/tiles/${tokenRef.current}/slide_files/${level}/${x}_${y}.${format}`,
          },
        });
        viewerRef.current = viewer;
        let raf = 0;
        const bump = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            setFrame((f) => f + 1);
          });
        };
        viewer.addHandler("open", () => {
          metrics.current.openMs = Math.round(performance.now() - t0);
          setReady(true);
          bump();
        });
        viewer.addHandler("open-failed", (e) => setError(`The viewer could not open the slide: ${String(e.message ?? "unknown error")}`));
        viewer.addHandler("tile-loaded", () => {
          metrics.current.tilesLoaded += 1;
        });
        viewer.addHandler("tile-load-failed", () => {
          metrics.current.tilesFailed += 1;
        });
        viewer.addHandler("tile-drawn", () => {
          if (metrics.current.firstTileMs === null) {
            metrics.current.firstTileMs = Math.round(performance.now() - t0);
            metrics.current.firstTileSinceNavigationMs = Math.round(performance.now());
            onMetrics?.({ ...metrics.current });
            (window as unknown as { __wbMetrics?: unknown }).__wbMetrics = { ...metrics.current, slideId: slide.id };
          }
        });
        viewer.addHandler("update-viewport", bump);
        viewer.addHandler("resize", bump);
        // Test and debugging hook: OpenSeadragon's own conversions, nothing else.
        (window as unknown as { __wbViewer?: unknown }).__wbViewer = {
          slideId: slide.id,
          toLevel0: (x: number, y: number) => toLevel0({ x, y }),
          toScreen: (x: number, y: number) => toScreen({ x, y }),
          rotation: () => normRotation(viewer.viewport.getRotation(true)),
          zoom: () => viewer.viewport.getZoom(true),
          metrics: () => ({ ...metrics.current }),
        };
        // Signed tile tokens last ttl_seconds; refresh before they expire so long sessions keep loading tiles.
        const every = Math.max(30, (tok.ttl_seconds ?? 600) - 90) * 1000;
        refresh = window.setInterval(async () => {
          try {
            const t = await api<ViewerToken>(`/slides/${slide.id}/viewer-token`);
            tokenRef.current = t.token;
          } catch {
            /* the next refresh retries; existing tiles stay visible */
          }
        }, every);
      } catch (err) {
        if (!disposed) setError(errorText(err));
      }
    })();
    return () => {
      disposed = true;
      if (refresh) window.clearInterval(refresh);
      viewerRef.current?.destroy();
      viewerRef.current = null;
      maskItemRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide.id, userId]);

  // ------------------------------------------------------------------ tissue mask layer
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !ready) return;
    if (maskItemRef.current) {
      v.world.removeItem(maskItemRef.current);
      maskItemRef.current = null;
    }
    if (!maskPngUrl) return;
    let live = true;
    (async () => {
      // Recolour the binary mask (white = tissue) to translucent teal so the tissue stays visible underneath.
      const imgEl = new Image();
      imgEl.src = maskPngUrl;
      await imgEl.decode();
      if (!live) return;
      const c = document.createElement("canvas");
      c.width = imgEl.naturalWidth;
      c.height = imgEl.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(imgEl, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < data.data.length; i += 4) {
        const on = data.data[i] > 127;
        data.data[i] = 47;
        data.data[i + 1] = 179;
        data.data[i + 2] = 173;
        data.data[i + 3] = on ? 92 : 0;
      }
      ctx.putImageData(data, 0, 0);
      const url = c.toDataURL("image/png");
      v.addTiledImage({
        tileSource: { type: "image", url },
        x: 0,
        y: 0,
        width: 1,
        opacity: 1,
        success: (e: { item: OsdTiledImage }) => {
          if (live) maskItemRef.current = e.item;
          else v.world.removeItem(e.item);
        },
      });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [maskPngUrl, ready]);

  // ------------------------------------------------------------------ status readout
  const rotation = viewerRef.current ? normRotation(viewerRef.current.viewport.getRotation(true)) : 0;
  const imageZoom = (() => {
    const v = viewerRef.current;
    const ti = item();
    if (!v || !ti) return null;
    return ti.viewportToImageZoom(v.viewport.getZoom(true));
  })();
  const micronsPerScreenPx = (() => {
    if (!slide.scale_bar_allowed || !imageZoom) return null;
    const mpp = rotation === 90 || rotation === 270 ? slide.mpp_y : slide.mpp_x;
    return mpp ? mpp / imageZoom : null;
  })();
  const scale = micronsPerScreenPx ? niceScaleBar(micronsPerScreenPx) : null;

  useEffect(() => {
    if (!ready) return;
    onStatus?.({ zoomPct: imageZoom ? imageZoom * 100 : 0, rotation, microns: micronsPerScreenPx });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, ready]);

  // ------------------------------------------------------------------ imperative API
  const finishPolygon = useCallback(() => {
    if (poly.length < 3 || !viewerRef.current) return;
    const pts = poly.map((p) => [round3(p.x), round3(p.y)] as [number, number]);
    onDraft({ type: "polygon", points: pts }, currentMeta("polygon"));
    setPoly([]);
  }, [poly, onDraft, currentMeta]);

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (f) => {
        const v = viewerRef.current;
        if (!v) return;
        v.viewport.zoomBy(f);
        v.viewport.applyConstraints();
      },
      home: () => viewerRef.current?.viewport.goHome(),
      rotateBy: (deg) => {
        const v = viewerRef.current;
        if (!v) return;
        v.viewport.setRotation(normRotation(v.viewport.getRotation() + deg));
      },
      panBy: (dx, dy) => {
        const v = viewerRef.current;
        if (!v) return;
        const b = v.viewport.getBounds();
        v.viewport.panBy({ x: b.width * dx, y: b.height * dy } as OsdPoint);
      },
      rotation: () => (viewerRef.current ? normRotation(viewerRef.current.viewport.getRotation(true)) : 0),
      centreRectangle: () => {
        const v = viewerRef.current;
        if (!v) return null;
        const cs = v.viewport.getContainerSize();
        const corners = [
          { x: cs.x * 0.35, y: cs.y * 0.35 },
          { x: cs.x * 0.65, y: cs.y * 0.35 },
          { x: cs.x * 0.65, y: cs.y * 0.65 },
          { x: cs.x * 0.35, y: cs.y * 0.65 },
        ]
          .map((p) => toLevel0(p))
          .filter((p): p is Pt => Boolean(p))
          .map((p) => clampToImage(p, W, H));
        if (corners.length !== 4) return null;
        return { geometry: rectangleFromScreenCorners(corners, v.viewport.getRotation(true)), meta: currentMeta("rect") };
      },
      cancelDraft: () => {
        setPoly([]);
        setDrag(null);
      },
      finishPolygon,
      undoVertex: () => setPoly((p) => p.slice(0, -1)),
      fitLevel0Box: (x0, y0, x1, y1) => {
        const v = viewerRef.current;
        const ti = item();
        if (!v || !ti) return;
        const mx = (x1 - x0) * 0.25;
        const my = (y1 - y0) * 0.25;
        const [ox, oy] = offsetRef.current;
        v.viewport.fitBounds(ti.imageToViewportRectangle(x0 - mx - ox, y0 - my - oy, x1 - x0 + 2 * mx, y1 - y0 + 2 * my));
      },
    }),
    [toLevel0, currentMeta, finishPolygon, W, H, item],
  );

  useEffect(() => {
    setPoly([]);
    setDrag(null);
  }, [tool]);

  // ------------------------------------------------------------------ pointer handling for drawing
  const localPoint = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent): Pt => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "pan" || !ready) return;
    e.preventDefault();
    const p = localPoint(e);
    if (tool === "rect") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ a: p, b: p });
    } else if (tool === "polygon") {
      const l0 = toLevel0(p);
      if (!l0) return;
      const pt = clampToImage(l0, W, H);
      if (poly.length >= 3) {
        const first = toScreen(poly[0]);
        if (first && Math.hypot(first.x - p.x, first.y - p.y) < 10) {
          finishPolygon();
          return;
        }
      }
      setPoly((prev) => [...prev, pt]);
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "pan") return;
    const p = localPoint(e);
    if (drag) setDrag({ a: drag.a, b: p });
    if (tool === "polygon") setHover(p);
  };
  const onPointerUp = () => {
    if (tool !== "rect" || !drag) return;
    const { a, b } = drag;
    setDrag(null);
    if (Math.abs(a.x - b.x) < 4 || Math.abs(a.y - b.y) < 4) return;
    const corners = [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ]
      .map((p) => toLevel0(p))
      .filter((p): p is Pt => Boolean(p))
      .map((p) => clampToImage(p, W, H));
    if (corners.length !== 4) return;
    const geom = rectangleFromScreenCorners(corners, viewerRef.current!.viewport.getRotation(true));
    onDraft(geom, currentMeta("rect"));
  };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (tool === "pan") return;
    const v = viewerRef.current;
    if (!v) return;
    const p = localPoint(e);
    const ref = v.viewport.pointFromPixel({ x: p.x, y: p.y } as OsdPoint, true);
    v.viewport.zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, ref);
    v.viewport.applyConstraints();
  };

  // ------------------------------------------------------------------ render shapes (recomputed every frame)
  const shapes = useMemo(() => {
    if (!ready) return [];
    return annotations.map((a) => {
      const ring = openRing(ringOf(a.geometry));
      const pts = ring.map((p) => toScreen(p)).filter((p): p is Pt => Boolean(p));
      return { a, pts };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, frame, ready, toScreen]);

  const regionShapes = useMemo(() => {
    if (!ready) return [];
    return regions.map((r) => ({ ...r, pts: openRing(r.ring).map((p) => toScreen(p)).filter((p): p is Pt => Boolean(p)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, frame, ready, toScreen]);

  const draftPts = useMemo(() => {
    if (!ready || !pendingDraft) return null;
    const ring: Pt[] =
      pendingDraft.type === "rectangle"
        ? [
            { x: pendingDraft.x, y: pendingDraft.y },
            { x: pendingDraft.x + pendingDraft.width, y: pendingDraft.y },
            { x: pendingDraft.x + pendingDraft.width, y: pendingDraft.y + pendingDraft.height },
            { x: pendingDraft.x, y: pendingDraft.y + pendingDraft.height },
          ]
        : pendingDraft.points.map(([x, y]) => ({ x, y }));
    return ring.map((p) => toScreen(p)).filter((p): p is Pt => Boolean(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft, frame, ready, toScreen]);

  const attentionBoxes = useMemo(() => {
    if (!ready || !attention?.length) return [];
    const max = Math.max(...attention.map((a) => a.weight)) || 1;
    return attention.map((b) => {
      const corners = [
        { x: b.x, y: b.y },
        { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h },
        { x: b.x, y: b.y + b.h },
      ].map((p) => toScreen(p));
      return { pts: corners.filter((p): p is Pt => Boolean(p)), w: b.weight / max };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention, frame, ready, toScreen]);

  const polyScreen = poly.map((p) => toScreen(p)).filter((p): p is Pt => Boolean(p));
  const ptsAttr = (pts: Pt[]) => pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

  return (
    <div className="stage wb-viewer relative h-full w-full overflow-hidden bg-stage" data-testid="viewer-stage">
      <div ref={hostRef} className="absolute inset-0" data-testid="osd-host" />
      <svg
        className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: tool === "pan" ? "none" : "auto", cursor: tool === "pan" ? "default" : "crosshair", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(e) => {
          if (tool === "polygon") {
            e.preventDefault();
            finishPolygon();
          }
        }}
        onWheel={onWheel}
        data-testid="annotation-overlay"
        aria-hidden
      >
        {attentionBoxes.map((b, i) => (
          <polygon key={`att-${i}`} points={ptsAttr(b.pts)} fill={`rgba(242, 184, 75, ${0.12 + 0.55 * b.w})`} stroke="none" />
        ))}
        {regionShapes.map((r) => (
          <g key={r.id}>
            <polygon points={ptsAttr(r.pts)} fill="rgba(242,184,75,0.10)" stroke="#f2b84b" strokeWidth={2} strokeDasharray="8 5" />
            {r.pts.length ? (
              // Below the region, so it never collides with an outline's own label above it.
              <text
                x={Math.min(...r.pts.map((p) => p.x)) + 4}
                y={Math.max(...r.pts.map((p) => p.y)) + 16}
                fill="#f7d79a"
                fontSize={12}
                fontWeight={700}
                style={{ paintOrder: "stroke" }}
                stroke="#26292b"
                strokeWidth={3}
              >
                {r.label}
              </text>
            ) : null}
          </g>
        ))}
        {shapes.map(({ a, pts }) => {
          const color = COLORS[a.label ?? ""] ?? COLORS.other;
          const sel = a.annotation_id === selectedId;
          return (
            <g key={a.annotation_id} data-annotation-id={a.annotation_id}>
              <polygon
                points={ptsAttr(pts)}
                data-testid="annotation-shape"
                data-annotation-id={a.annotation_id}
                fill={sel ? "rgba(47,179,173,0.16)" : "rgba(47,179,173,0.05)"}
                stroke={color}
                strokeWidth={sel ? 3.5 : 2}
                style={{ pointerEvents: tool === "pan" ? "visibleStroke" : "none", cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(sel ? null : a.annotation_id);
                }}
              />
              {pts[0] ? (
                <text x={pts[0].x + 4} y={pts[0].y - 6} fill="#e8e6e1" fontSize={12} fontWeight={700} style={{ paintOrder: "stroke" }} stroke="#26292b" strokeWidth={3}>
                  {(a.label ?? "annotation").replace(/_/g, " ")} · v{a.version}
                </text>
              ) : null}
            </g>
          );
        })}
        {draftPts && draftPts.length > 1 ? <polygon points={ptsAttr(draftPts)} fill="rgba(127,211,207,0.18)" stroke="#7fd3cf" strokeWidth={2.5} strokeDasharray="6 4" data-testid="draft-shape" /> : null}
        {drag ? (
          <rect
            x={Math.min(drag.a.x, drag.b.x)}
            y={Math.min(drag.a.y, drag.b.y)}
            width={Math.abs(drag.b.x - drag.a.x)}
            height={Math.abs(drag.b.y - drag.a.y)}
            fill="rgba(127,211,207,0.15)"
            stroke="#7fd3cf"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        ) : null}
        {polyScreen.length > 0 ? (
          <g>
            <polyline points={ptsAttr(hover ? [...polyScreen, hover] : polyScreen)} fill="none" stroke="#7fd3cf" strokeWidth={2} strokeDasharray="6 4" />
            {polyScreen.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={i === 0 && polyScreen.length >= 3 ? 7 : 4} fill={i === 0 ? "#7fd3cf" : "#e8e6e1"} stroke="#26292b" strokeWidth={1.5} />
            ))}
          </g>
        ) : null}
      </svg>

      {/* Scale bar ONLY when microns-per-pixel is known. */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1.5" aria-live="polite">
        {slide.scale_bar_allowed ? (
          scale ? (
            <div className="rounded bg-stage/85 px-2 py-1.5 text-micro font-semibold text-stage-ink" data-testid="scale-bar">
              <div className="h-1.5 border-x-2 border-b-2 border-stage-ink" style={{ width: `${scale.px}px` }} />
              <span className="mt-0.5 block">{scale.label}</span>
            </div>
          ) : null
        ) : (
          <p className="rounded bg-stage/85 px-2 py-1 text-micro text-stage-ink" data-testid="no-scale-bar">
            No scale bar: microns per pixel unknown
          </p>
        )}
        <p className="rounded bg-stage/85 px-2 py-1 font-mono text-micro text-stage-ink tabular">
          {imageZoom ? `${(imageZoom * 100).toFixed(imageZoom < 0.1 ? 1 : 0)}% of full resolution` : "…"} · rotated {rotation}°
        </p>
      </div>

      {error ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-md rounded-[var(--radius-panel)] border border-rust/60 bg-surface p-4 text-small text-ink" role="alert">
            <p className="font-bold">The slide cannot be displayed</p>
            <p className="mt-1 text-graphite">{error}</p>
          </div>
        </div>
      ) : !ready ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-small text-stage-ink" role="status">
          Loading tiles…
        </div>
      ) : null}
    </div>
  );
});
