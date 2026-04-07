#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-arm64}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${ROOT_DIR}/assets/bin/mpv/darwin-${ARCH}"
TARGET_APP_DIR="${TARGET_DIR}/mpv.app"
SOURCE_APP_DIR="/Applications/mpv.app"

if [ ! -d "${SOURCE_APP_DIR}" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew fehlt. Installiere Homebrew oder lege ${SOURCE_APP_DIR} bereit."
    exit 1
  fi
  HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask mpv
fi

mkdir -p "${TARGET_DIR}"
rm -rf "${TARGET_APP_DIR}"
cp -R "${SOURCE_APP_DIR}" "${TARGET_APP_DIR}"
chmod +x "${TARGET_APP_DIR}/Contents/MacOS/mpv" || true

echo "Bundled mpv prepared at ${TARGET_APP_DIR}"
