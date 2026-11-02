#!/usr/bin/env bash
# Fetch the larger CC0 OpenSlide test slide (CMU-1.svs, about 169 MB) for multi-level tiling
# and latency tests, with a SHA-256 check. Not needed for the default test suite.
#
# Source: OpenSlide test data, Carnegie Mellon University (CC0, as listed on the source page)
#   https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/
#
# Checksum policy:
#   * The small committed fixture is verified against its recorded SHA-256.
#   * For CMU-1.svs, set EXPECTED_SHA256 to a value you obtained independently to verify the
#     download. Otherwise the first successful download is recorded in
#     fixtures/large/CMU-1.svs.sha256 (trust on first use) and every later run verifies against it.
#
# Usage: workbench/scripts/fetch-fixtures.sh            (downloads into workbench/fixtures/large/)
#        workbench/scripts/fetch-fixtures.sh --verify   (only verifies what is present)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/../fixtures"
LARGE="$FIXTURES/large"
SMALL="$FIXTURES/CMU-1-Small-Region.svs"
SMALL_SHA256="ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7"
URL="https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/CMU-1.svs"
DEST="$LARGE/CMU-1.svs"
RECORD="$DEST.sha256"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

echo "Verifying the committed small fixture..."
actual="$(sha256_of "$SMALL")"
if [[ "$actual" != "$SMALL_SHA256" ]]; then
  echo "ERROR: $SMALL has sha256 $actual, expected $SMALL_SHA256" >&2
  exit 1
fi
echo "  OK $SMALL_SHA256"

verify_large() {
  local got expected
  got="$(sha256_of "$DEST")"
  expected="${EXPECTED_SHA256:-}"
  if [[ -z "$expected" && -f "$RECORD" ]]; then expected="$(cat "$RECORD")"; fi
  if [[ -z "$expected" ]]; then
    echo "$got" > "$RECORD"
    echo "  recorded sha256 $got (trust on first use; set EXPECTED_SHA256 to verify independently)"
  elif [[ "$got" == "$expected" ]]; then
    echo "  OK $got"
  else
    echo "ERROR: $DEST has sha256 $got, expected $expected" >&2
    return 1
  fi
}

if [[ "${1:-}" == "--verify" ]]; then
  [[ -f "$DEST" ]] && verify_large || echo "  $DEST not present"
  exit 0
fi

mkdir -p "$LARGE"
if [[ -f "$DEST" ]]; then
  echo "$DEST already present; verifying..."
  verify_large
  exit $?
fi
echo "Downloading $URL (about 169 MB) into $LARGE ..."
curl --fail --location --proto '=https' --tlsv1.2 --output "$DEST.part" "$URL"
mv "$DEST.part" "$DEST"
verify_large
echo "Done. Large fixtures are gitignored (workbench/fixtures/large/)."
