#!/usr/bin/env bash
# Prefer LibreOffice for DOCX→PDF; if soffice is killed (e.g. Killed: 9), fall back to Node/pdfkit.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCX="$ROOT/out/michael_samuel_cv.docx"
OUT="$ROOT/out"
PDF="$OUT/michael_samuel_cv.pdf"

try_soffice() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  rm -f "$PDF"
  # shellcheck disable=SC2090
  "$bin" --headless --norestore --nolockcheck --nologo --nofirststartwizard \
    --convert-to "pdf:writer_pdf_Export" \
    --outdir "$OUT" "$DOCX"
  [[ -f "$PDF" ]]
}

if [[ ! -f "$DOCX" ]]; then
  echo "Missing $DOCX — run npm run build:docx (or npm run build) first." >&2
  exit 1
fi

CANDIDATES=()
if [[ -n "${SOFFICE_PATH:-}" ]]; then
  CANDIDATES+=("$SOFFICE_PATH")
fi
CANDIDATES+=(
  "/Applications/LibreOffice.app/Contents/MacOS/soffice"
  "/opt/homebrew/opt/libreoffice/libexec/program/soffice"
  "/usr/local/opt/libreoffice/libexec/program/soffice"
)

for SOFFICE in "${CANDIDATES[@]}"; do
  [[ -n "$SOFFICE" ]] || continue
  if try_soffice "$SOFFICE"; then
    echo "Wrote $PDF (LibreOffice: $SOFFICE)"
    exit 0
  fi
done

echo "" >&2
echo "LibreOffice did not produce a PDF (often: macOS sent signal 9 / SIGKILL)." >&2
echo "Trying Node + pdfkit fallback (plain layout from data/resume.txt)…" >&2
echo "For LibreOffice PDFs on Apple Silicon (M1/M2/M3): install the Apple Silicon build, e.g." >&2
echo "  brew install --cask libreoffice   (uses arm64 on /opt/homebrew Macs)" >&2
echo "  or https://www.libreoffice.org/download/download/ → macOS → AArch64 / Apple Silicon." >&2
echo "Do not install the Intel (x86_64) DMG on an M2. Open LibreOffice once from Finder; check Activity Monitor if soffice is killed." >&2
echo "" >&2

exec node "$ROOT/scripts/cv-pdf-fallback.mjs"
