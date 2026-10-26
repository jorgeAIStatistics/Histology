# DermPath Research Workbench API and worker image.
#
# UNVERIFIED: written 2026-10-26 without a running Docker daemon; it has never been built.
# Build context is workbench/ (see docker-compose.yml):
#     docker build -f api/Dockerfile -t dermpath-api .
# The same image runs the API (uvicorn) and the worker (python -m dermpath.worker).
#
# OpenSlide comes from the self-contained openslide-bin wheel (no apt packages needed).
# numpy is installed explicitly here; in local development it comes from the system Python
# through a --system-site-packages venv. The ML pass adds torch / scikit-learn for workers.
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WB_VAR_DIR=/var/lib/dermpath

WORKDIR /srv/workbench/api
COPY api/requirements.txt ./requirements.txt
# numpy matches the locally tested version; psycopg for PostgreSQL; boto3 for the S3/MinIO store.
# These extra pins are UNVERIFIED in this image (only numpy 2.4.2 is tested locally).
# requirements.txt already pins numpy, scipy, scikit-learn and torch; the PostgreSQL driver and boto3 are
# needed only for the compose stack (PostgreSQL + S3-compatible storage) and are not used in local development.
RUN pip install --no-cache-dir -r requirements.txt \
        "psycopg[binary]==3.2.3" boto3==1.35.0

COPY api/dermpath ./dermpath
# Only the small CC0 fixture (with its README); large fixtures are fetched separately.
COPY fixtures/CMU-1-Small-Region.svs fixtures/README.md /srv/workbench/fixtures/

RUN useradd --system --uid 10001 dermpath \
    && mkdir -p /var/lib/dermpath && chown -R dermpath /var/lib/dermpath
USER dermpath

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health').status==200 else 1)"
CMD ["uvicorn", "dermpath.main:app", "--host", "0.0.0.0", "--port", "8000"]
