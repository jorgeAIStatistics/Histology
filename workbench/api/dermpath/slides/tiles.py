"""DeepZoom tile service with a bounded LRU cache of open slide handles.

Tiles are produced by ``openslide.deepzoom.DeepZoomGenerator`` (tile 254 px + 1 px
overlap = 256 px JPEG tiles, ``limit_bounds=True``). Label and macro associated images are
never exposed by this module.
"""

from __future__ import annotations

import io
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field

from openslide import AbstractSlide
from openslide.deepzoom import DeepZoomGenerator

from ..config import get_settings


@dataclass
class _Entry:
    slide: AbstractSlide
    dz: DeepZoomGenerator
    serialize: bool  # PIL-backed ImageSlide is not safe for concurrent reads
    lock: threading.Lock = field(default_factory=threading.Lock)


class TileService:
    def __init__(self, capacity: int, tile_size: int, overlap: int, quality: int) -> None:
        self.capacity = max(1, capacity)
        self.tile_size = tile_size
        self.overlap = overlap
        self.quality = quality
        self._cache: OrderedDict[str, _Entry] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def _entry(self, slide_id: str, opener: Callable[[], AbstractSlide], serialize: bool) -> _Entry:
        with self._lock:
            entry = self._cache.get(slide_id)
            if entry is not None:
                self._cache.move_to_end(slide_id)
                self.hits += 1
                return entry
        slide = opener()  # open outside the global lock
        dz = DeepZoomGenerator(slide, tile_size=self.tile_size, overlap=self.overlap, limit_bounds=True)
        entry = _Entry(slide=slide, dz=dz, serialize=serialize)
        with self._lock:
            existing = self._cache.get(slide_id)
            if existing is not None:  # another thread won the race
                slide.close()
                self._cache.move_to_end(slide_id)
                self.hits += 1
                return existing
            self.misses += 1
            self._cache[slide_id] = entry
            while len(self._cache) > self.capacity:
                _, old = self._cache.popitem(last=False)
                self.evictions += 1
                try:
                    old.slide.close()
                except Exception:  # pragma: no cover
                    pass
        return entry

    def dzi(self, slide_id: str, opener: Callable[[], AbstractSlide], serialize: bool = False) -> str:
        return self._entry(slide_id, opener, serialize).dz.get_dzi("jpeg")

    def bounds_offset(self, slide_id: str, opener: Callable[[], AbstractSlide], serialize: bool = False) -> list[int]:
        """Level-0 offset of the DeepZoom origin (limit_bounds=True). Zero unless the file
        declares openslide.bounds-x/y. Viewer coordinates + offset = level-0 coordinates."""
        props = self._entry(slide_id, opener, serialize).slide.properties
        return [int(props.get("openslide.bounds-x", 0) or 0), int(props.get("openslide.bounds-y", 0) or 0)]

    def level_info(self, slide_id: str, opener: Callable[[], AbstractSlide], serialize: bool = False) -> dict:
        dz = self._entry(slide_id, opener, serialize).dz
        return {"level_count": dz.level_count, "level_tiles": [list(t) for t in dz.level_tiles]}

    def tile_jpeg(self, slide_id: str, opener: Callable[[], AbstractSlide], level: int, col: int, row: int,
                  serialize: bool = False) -> bytes | None:
        """JPEG bytes, or None when the address is outside the pyramid."""
        entry = self._entry(slide_id, opener, serialize)
        dz = entry.dz
        if level < 0 or level >= dz.level_count:
            return None
        cols, rows = dz.level_tiles[level]
        if col < 0 or row < 0 or col >= cols or row >= rows:
            return None
        if entry.serialize:
            with entry.lock:
                img = dz.get_tile(level, (col, row))
        else:
            img = dz.get_tile(level, (col, row))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=self.quality)
        return buf.getvalue()

    def evict(self, slide_id: str) -> None:
        with self._lock:
            entry = self._cache.pop(slide_id, None)
        if entry is not None:
            try:
                entry.slide.close()
            except Exception:  # pragma: no cover
                pass

    def clear(self) -> None:
        with self._lock:
            entries = list(self._cache.values())
            self._cache.clear()
        for e in entries:
            try:
                e.slide.close()
            except Exception:  # pragma: no cover
                pass

    def stats(self) -> dict:
        with self._lock:
            return {
                "open_slides": len(self._cache),
                "capacity": self.capacity,
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
                "tile_size": self.tile_size,
                "overlap": self.overlap,
                "format": "jpeg",
            }


_service: TileService | None = None
_service_lock = threading.Lock()


def get_tile_service() -> TileService:
    global _service
    if _service is None:
        with _service_lock:
            if _service is None:
                s = get_settings()
                _service = TileService(s.tile_cache_slides, s.tile_size, s.tile_overlap, s.tile_jpeg_quality)
    return _service


def reset_tile_service() -> None:
    global _service
    if _service is not None:
        _service.clear()
    _service = None
