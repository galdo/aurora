#!/usr/bin/env bash
#
# embed-folder-covers-flac.sh
# ───────────────────────────
#
# Embeds a loose cover image file (cover.jpg / folder.jpg / front.jpg / …)
# into the PICTURE block of every FLAC file in an album folder.
#
# Why?
# ────
# Aurora reads only the *embedded* picture in a FLAC's metadata (via the
# `music-metadata` library). A `cover.jpg` next to the FLACs is invisible
# to Aurora's library sync. This script bridges the gap by writing the
# folder cover into each track once — after that a Library Sync will pick
# the cover up like any other album.
#
# What it does
# ────────────
#   • Walks the given album folder (and its sub-folders, e.g. "CD 01/").
#   • Picks the first matching cover image at each FLAC's level OR at the
#     album root (configurable preference order: cover, folder, front,
#     albumart, album, artwork).
#   • Skips FLACs that already carry a PICTURE block of type 3 (front cover)
#     unless `--force` is given.
#   • Verifies the FLAC stream is intact afterwards (`metaflac --list`
#     sanity check) — does NOT re-encode audio.
#
# Usage
# ─────
#   # Single album, dry run:
#   ./scripts/embed-folder-covers-flac.sh --dry-run \
#       "/Volumes/ROMS Master/Music/Daft Punk - Random Access Memories (2013)"
#
#   # Single album, write:
#   ./scripts/embed-folder-covers-flac.sh \
#       "/Volumes/ROMS Master/Music/Daft Punk - Random Access Memories (2013)"
#
#   # Multiple albums in one go:
#   ./scripts/embed-folder-covers-flac.sh \
#       "/path/Album A" "/path/Album B" "/path/Album C"
#
#   # Force re-embed even for files that already have a PICTURE block:
#   ./scripts/embed-folder-covers-flac.sh --force "/path/album"
#
#   # Use an explicit cover file (overrides auto-detection):
#   ./scripts/embed-folder-covers-flac.sh --cover "/path/scan.jpg" \
#       "/path/album"
#
# Safety
# ──────
#   • Audio frames are NEVER touched — only the FLAC PICTURE metadata
#     block is added. metaflac rewrites in-place but rolls back atomically
#     on errors.
#   • Operates per-file, so a half-finished run can be resumed simply by
#     re-running the script: already-tagged files are skipped automatically.
#   • Optional `--backup` flag copies each FLAC to `<file>.bak` before
#     touching it (only needed for paranoid runs).
#
# Requirements
# ────────────
#   • metaflac (Homebrew: `brew install flac`)
#   • bash 3.2+ (macOS default works)
#   • file (BSD/GNU `file`, used to detect cover MIME type)

set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────────
DRY_RUN=0
FORCE=0
BACKUP=0
EXPLICIT_COVER=""
COVER_NAMES=("cover" "folder" "front" "albumart" "album" "artwork")
COVER_EXTS=("jpg" "jpeg" "png" "webp")
TARGETS=()

usage() {
  sed -n '2,52p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    -f|--force)   FORCE=1; shift ;;
    -b|--backup)  BACKUP=1; shift ;;
    -c|--cover)
      EXPLICIT_COVER="${2:-}"
      [ -z "$EXPLICIT_COVER" ] && { echo "error: --cover needs a path" >&2; exit 64; }
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do TARGETS+=("$1"); shift; done ;;
    -*) echo "error: unknown option '$1' (try --help)" >&2; exit 64 ;;
    *)  TARGETS+=("$1"); shift ;;
  esac
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "error: at least one album folder must be specified (try --help)" >&2
  exit 64
fi

# ── Sanity checks ───────────────────────────────────────────────────────
if ! command -v metaflac >/dev/null 2>&1; then
  echo "error: 'metaflac' not found. Install with: brew install flac" >&2
  exit 127
fi
if ! command -v file >/dev/null 2>&1; then
  echo "error: 'file' utility missing — required to detect MIME type" >&2
  exit 127
fi

# ── Helpers ─────────────────────────────────────────────────────────────

# Find the best loose cover image for a given directory. Search order:
#   1. Exact-name match (cover.jpg → folder.jpg → front.jpg → …)
#   2. Falls back to the parent directory if track lives in a CD\d+ subdir
# Returns the absolute path on stdout or empty string.
find_cover_for_dir() {
  local dir="$1"
  local name ext candidate
  for name in "${COVER_NAMES[@]}"; do
    for ext in "${COVER_EXTS[@]}"; do
      candidate="$dir/$name.$ext"
      if [ -f "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
      fi
    done
  done

  # Multi-disc heuristic: if dir is "…/CD 01" (or "Disc 2", etc.), look one level up.
  local base
  base="$(basename "$dir")"
  if [[ "$base" =~ ^([Cc][Dd]|[Dd]isc|[Dd]isk)[[:space:]]*[0-9]+$ ]]; then
    local parent
    parent="$(dirname "$dir")"
    for name in "${COVER_NAMES[@]}"; do
      for ext in "${COVER_EXTS[@]}"; do
        candidate="$parent/$name.$ext"
        if [ -f "$candidate" ]; then
          printf '%s' "$candidate"
          return 0
        fi
      done
    done
  fi
  printf ''
}

# Detects the MIME type of a cover image. metaflac picks it up automatically
# from the file extension, so we only use this for the human-readable log.
detect_mime() {
  file --mime-type -b "$1" 2>/dev/null || echo "image/unknown"
}

# Counts existing front-cover (type 3) PICTURE blocks in a FLAC file.
has_front_cover() {
  local flac="$1"
  # `metaflac --list --block-type=PICTURE` prints `type: 3 (Cover (front))`
  # for every front-cover picture; if the count is > 0 we have one.
  metaflac --list --block-type=PICTURE "$flac" 2>/dev/null \
    | grep -c '^[[:space:]]*type:[[:space:]]*3' || true
}

# Embeds the cover image into the FLAC. Picture spec for --import-picture-from:
#   TYPE|MIME-TYPE|DESCRIPTION|WIDTHxHEIGHTxDEPTH/COLORS|FILE
# Empty width/height/depth is fine — metaflac fills them in by inspecting
# the image. Type 3 = "Cover (front)".
embed_cover() {
  local flac="$1"
  local cover="$2"
  metaflac --import-picture-from="3||||$cover" "$flac"
}

# ── Counters ────────────────────────────────────────────────────────────
total_albums=0
total_flacs=0
embedded=0
skipped_already=0
skipped_no_cover=0
errors=0

# ── Per-album processing ────────────────────────────────────────────────
process_album() {
  local album_dir="$1"
  total_albums=$((total_albums + 1))

  if [ ! -d "$album_dir" ]; then
    echo "❌ not a directory: $album_dir"
    errors=$((errors + 1))
    return
  fi

  echo "📀 Album: $album_dir"

  # Walk all FLACs (skip macOS resource forks ._*)
  local flac
  while IFS= read -r -d '' flac; do
    local base
    base="$(basename "$flac")"
    if [[ "$base" == ._* ]]; then
      continue
    fi
    total_flacs=$((total_flacs + 1))

    # Pick the cover for *this* track's directory (with parent fallback for
    # multi-disc layouts). An explicit --cover always wins.
    local track_dir cover_path
    track_dir="$(dirname "$flac")"
    if [ -n "$EXPLICIT_COVER" ]; then
      cover_path="$EXPLICIT_COVER"
    else
      cover_path="$(find_cover_for_dir "$track_dir")"
      if [ -z "$cover_path" ]; then
        cover_path="$(find_cover_for_dir "$album_dir")"
      fi
    fi

    if [ -z "$cover_path" ] || [ ! -f "$cover_path" ]; then
      echo "   ⚠️  no cover image found for: $base"
      skipped_no_cover=$((skipped_no_cover + 1))
      continue
    fi

    # Idempotency: skip if already has front cover (unless --force)
    local existing
    existing="$(has_front_cover "$flac")"
    if [ "$existing" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
      skipped_already=$((skipped_already + 1))
      continue
    fi

    local mime
    mime="$(detect_mime "$cover_path")"
    echo "   🎵 $base"
    echo "      cover:  $cover_path  ($mime)"

    if [ "$DRY_RUN" -eq 1 ]; then
      embedded=$((embedded + 1))
      continue
    fi

    # Optional backup
    if [ "$BACKUP" -eq 1 ] && [ ! -f "$flac.bak" ]; then
      cp -p "$flac" "$flac.bak"
    fi

    # If --force and a front cover exists, remove existing front covers first
    # so we don't accumulate duplicates.
    if [ "$FORCE" -eq 1 ] && [ "$existing" -gt 0 ]; then
      metaflac --remove --block-type=PICTURE "$flac" || true
    fi

    if embed_cover "$flac" "$cover_path"; then
      # Sanity check — make sure the file is still readable
      if metaflac --list "$flac" >/dev/null 2>&1; then
        embedded=$((embedded + 1))
      else
        echo "      ❌ FLAC integrity check failed after embed"
        errors=$((errors + 1))
      fi
    else
      echo "      ❌ metaflac --import-picture-from failed"
      errors=$((errors + 1))
    fi
  done < <(find "$album_dir" -type f -iname '*.flac' -print0)
  echo
}

# ── Banner ──────────────────────────────────────────────────────────────
echo "🖼  Embed folder covers into FLACs"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "🛡  Mode: DRY-RUN (no files modified)"
else
  echo "✏️  Mode: WRITE"
fi
[ "$FORCE" -eq 1 ] && echo "⚠️  --force: existing front-cover blocks will be replaced"
[ "$BACKUP" -eq 1 ] && echo "💾  --backup: each FLAC will be copied to <file>.bak first"
echo

# ── Run ─────────────────────────────────────────────────────────────────
for target in "${TARGETS[@]}"; do
  process_album "$target"
done

# ── Summary ─────────────────────────────────────────────────────────────
echo "── Summary ──────────────────────────────────"
printf '   albums processed:           %d\n' "$total_albums"
printf '   total flac files scanned:   %d\n' "$total_flacs"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '   would embed:                %d\n' "$embedded"
else
  printf '   embedded:                   %d\n' "$embedded"
fi
printf '   already had front cover:    %d\n' "$skipped_already"
printf '   no cover image available:   %d\n' "$skipped_no_cover"
printf '   errors:                     %d\n' "$errors"

[ "$errors" -gt 0 ] && exit 1
exit 0
