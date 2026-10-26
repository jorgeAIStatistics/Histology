"""Runtime configuration, read from environment variables (prefix ``WB_``).

Modes
-----
``WB_MODE=demo`` (default) runs with seeded fictional users and a demo role switch.
``WB_MODE=secured`` is NOT implemented (it needs an OIDC identity provider). Any mode
other than ``demo`` fails closed: every route except ``GET /api/v1/health`` refuses
with HTTP 503 ``mode_not_implemented``.

Paths
-----
All runtime data lives under ``WB_VAR_DIR`` (default ``workbench/var``), which is
gitignored and never under a web root: the SQLite database, the private object
store, upload staging, caches and the generated demo secret.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, replace
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent  # workbench/api
WORKBENCH_DIR = API_DIR.parent  # workbench/
DEFAULT_VAR_DIR = WORKBENCH_DIR / "var"
FIXTURES_DIR = WORKBENCH_DIR / "fixtures"

SUPPORTED_MODES = ("demo",)  # "secured" is recognised but not implemented: fails closed.
KNOWN_MODES = ("demo", "secured")

# Whole-slide formats are advertised only after a compatibility test exists.
# Tested: Aperio .svs (tests/test_slides_openslide.py, CMU-1-Small-Region.svs).
WSI_EXTENSIONS_TESTED = (".svs",)
FIELD_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return tuple(p.strip() for p in raw.split(",") if p.strip())


@dataclass(frozen=True)
class Settings:
    mode: str = "demo"
    var_dir: Path = DEFAULT_VAR_DIR
    database_url: str = ""  # empty → sqlite:///<var_dir>/workbench.db
    secret: str | None = None  # WB_SECRET; generated into var/ on first demo run if unset
    object_store: str = "local"  # local | s3
    s3_endpoint: str | None = None
    s3_bucket: str | None = None
    s3_region: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    max_upload_bytes: int = 4 * 1024**3  # 4 GiB
    upload_chunk_bytes: int = 8 * 1024**2  # 8 MiB
    allowed_extensions: tuple[str, ...] = WSI_EXTENSIONS_TESTED + FIELD_IMAGE_EXTENSIONS
    allow_real_data: bool = False  # real_authorized uploads are refused unless set
    max_field_image_pixels: int = 60_000_000  # decompression-bomb guard for JPEG/PNG
    access_token_ttl_seconds: int = 600  # signed tile/thumbnail tokens: 10 minutes
    session_ttl_seconds: int = 12 * 3600
    tile_cache_slides: int = 8  # bounded LRU of open slide handles
    tile_size: int = 254
    tile_overlap: int = 1
    tile_jpeg_quality: int = 75
    job_lease_seconds: int = 60
    job_max_attempts: int = 3
    job_backoff_base_seconds: float = 2.0
    job_backoff_max_seconds: float = 300.0
    worker_poll_seconds: float = 1.0
    worker_stale_seconds: int = 120
    qc_low_tissue_fraction: float = 0.05
    qc_blur_variance_threshold: float = 60.0
    cors_origins: tuple[str, ...] = (
        "http://localhost:3600",  # the workbench web app (workbench/web, next dev/start -p 3600)
        "http://127.0.0.1:3600",
    )
    auto_seed: bool = True
    extra_handler_modules: tuple[str, ...] = ()
    cookie_secure: bool = False  # set WB_COOKIE_SECURE=1 behind HTTPS

    # ---- derived paths -------------------------------------------------
    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.var_dir / 'workbench.db'}"

    @property
    def objects_dir(self) -> Path:
        return self.var_dir / "objects"

    @property
    def uploads_dir(self) -> Path:
        return self.var_dir / "uploads"

    @property
    def cache_dir(self) -> Path:
        return self.var_dir / "cache"

    @property
    def secret_file(self) -> Path:
        return self.var_dir / "secret.key"

    @property
    def mode_supported(self) -> bool:
        return self.mode in SUPPORTED_MODES

    def with_overrides(self, **kwargs) -> "Settings":
        return replace(self, **kwargs)

    @classmethod
    def from_env(cls) -> "Settings":
        var_dir = Path(os.environ.get("WB_VAR_DIR") or DEFAULT_VAR_DIR).resolve()
        exts = _env_list("WB_ALLOWED_EXTENSIONS", WSI_EXTENSIONS_TESTED + FIELD_IMAGE_EXTENSIONS)
        exts = tuple(e.lower() if e.startswith(".") else "." + e.lower() for e in exts)
        return cls(
            mode=(os.environ.get("WB_MODE") or "demo").strip().lower(),
            var_dir=var_dir,
            database_url=os.environ.get("WB_DATABASE_URL", ""),
            secret=os.environ.get("WB_SECRET") or None,
            object_store=(os.environ.get("WB_OBJECT_STORE") or "local").lower(),
            s3_endpoint=os.environ.get("WB_S3_ENDPOINT") or None,
            s3_bucket=os.environ.get("WB_S3_BUCKET") or None,
            s3_region=os.environ.get("WB_S3_REGION") or None,
            s3_access_key=os.environ.get("WB_S3_ACCESS_KEY") or None,
            s3_secret_key=os.environ.get("WB_S3_SECRET_KEY") or None,
            max_upload_bytes=_env_int("WB_MAX_UPLOAD_BYTES", cls.max_upload_bytes),
            upload_chunk_bytes=_env_int("WB_UPLOAD_CHUNK_BYTES", cls.upload_chunk_bytes),
            allowed_extensions=exts,
            allow_real_data=_env_bool("WB_ALLOW_REAL_DATA", False),
            max_field_image_pixels=_env_int("WB_MAX_FIELD_IMAGE_PIXELS", cls.max_field_image_pixels),
            access_token_ttl_seconds=_env_int("WB_ACCESS_TOKEN_TTL", cls.access_token_ttl_seconds),
            session_ttl_seconds=_env_int("WB_SESSION_TTL", cls.session_ttl_seconds),
            tile_cache_slides=_env_int("WB_TILE_CACHE_SLIDES", cls.tile_cache_slides),
            job_lease_seconds=_env_int("WB_JOB_LEASE_SECONDS", cls.job_lease_seconds),
            job_max_attempts=_env_int("WB_JOB_MAX_ATTEMPTS", cls.job_max_attempts),
            job_backoff_base_seconds=_env_float("WB_JOB_BACKOFF_BASE", cls.job_backoff_base_seconds),
            worker_poll_seconds=_env_float("WB_WORKER_POLL_SECONDS", cls.worker_poll_seconds),
            worker_stale_seconds=_env_int("WB_WORKER_STALE_SECONDS", cls.worker_stale_seconds),
            qc_low_tissue_fraction=_env_float("WB_QC_LOW_TISSUE_FRACTION", cls.qc_low_tissue_fraction),
            qc_blur_variance_threshold=_env_float("WB_QC_BLUR_THRESHOLD", cls.qc_blur_variance_threshold),
            cors_origins=_env_list("WB_CORS_ORIGINS", cls.cors_origins),
            auto_seed=_env_bool("WB_AUTO_SEED", True),
            extra_handler_modules=_env_list("WB_EXTRA_HANDLER_MODULES", ()),
            cookie_secure=_env_bool("WB_COOKIE_SECURE", False),
        )


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings


def set_settings(settings: Settings | None) -> None:
    """Replace the process-wide settings (used by tests and the app factory)."""
    global _settings
    _settings = settings
    # Derived singletons depend on settings; reset them.
    from . import db, storage  # local import to avoid cycles

    db.reset_engine()
    storage.reset_store()
    try:
        from .slides import tiles

        tiles.reset_tile_service()
    except Exception:  # pragma: no cover - tiles import failure is reported by /health
        pass


def ensure_var_dirs(settings: Settings) -> None:
    for d in (settings.var_dir, settings.objects_dir, settings.uploads_dir, settings.cache_dir):
        d.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass


def resolve_secret(settings: Settings) -> bytes:
    """Return the HMAC master secret.

    ``WB_SECRET`` wins. In demo mode, when it is unset, a random secret is generated
    once into ``var/secret.key`` (mode 0600). Outside demo mode an unset secret is an
    error (fail closed).
    """
    if settings.secret:
        if len(settings.secret) < 32:
            raise RuntimeError("WB_SECRET must be at least 32 characters")
        return settings.secret.encode()
    if settings.mode != "demo":
        raise RuntimeError("WB_SECRET is required outside demo mode")
    ensure_var_dirs(settings)
    path = settings.secret_file
    if path.exists():
        value = path.read_text().strip()
        if len(value) >= 32:
            return value.encode()
    value = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(value)
    return value.encode()
