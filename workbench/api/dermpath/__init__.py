"""DermPath Research Workbench backend (research use only, not for diagnosis).

Working name, provisional. This package is a research prototype: it organises
slides, quality review, expert labels and datasets. It makes no diagnostic claim.
"""

__version__ = "0.1.0"

#: Version string recorded on every slide the ingest pipeline processes. Bump it when
#: ingest behaviour changes so derived artefacts can be traced to the code that made them.
PROCESSING_VERSION = "ingest-1.0"

#: Shown by /health, /auth/me and exports.
RESEARCH_USE_NOTICE = (
    "Research use only. Not a medical device. Not for diagnosis, treatment or "
    "clinical decision-making."
)
