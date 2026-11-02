"""Open a slide record as an OpenSlide-compatible object.

* ``wsi`` → :class:`openslide.OpenSlide` (tested format: Aperio .svs)
* ``field_image`` → :class:`openslide.ImageSlide` (JPEG/PNG; a single-level image, never
  presented as a whole-slide image and never rescaled to pretend to be one)
* ``synthetic_tiles`` → :class:`dermpath.slides.synthetic.SyntheticSlide`
"""

from __future__ import annotations

import openslide
from openslide import AbstractSlide

from ..models import Slide
from ..storage import get_store
from .synthetic import SyntheticSlide


def open_slide_record(slide: Slide) -> AbstractSlide:
    if slide.image_kind == "synthetic_tiles":
        if not slide.synthetic_spec_json:
            raise ValueError("synthetic slide has no generator spec")
        return SyntheticSlide(slide.synthetic_spec_json)
    path = get_store().local_path(slide.object_key)
    if slide.image_kind == "field_image":
        return openslide.ImageSlide(str(path))
    return openslide.OpenSlide(str(path))


def library_versions() -> dict:
    import PIL

    return {
        "openslide": openslide.__library_version__,
        "openslide_python": openslide.__version__,
        "pillow": PIL.__version__,
    }
