#!/usr/bin/env bash
#
# repair-clair-obscur-tags.sh
# ───────────────────────────
#
# Repairs the corrupted Vorbis-comment TITLE tags inside the FLAC files of the
# "Clair Obscur: Expedition 33" OST on /Volumes/ROMs Master/Music/.
#
# Background
# ──────────
# The original tags were written with broken UTF-8 handling: every
# non-ASCII byte was replaced with `#` (so `Lumière` became `Lumi##re`,
# `à l’Aube` became `## l###Aube`, etc.). The on-disk *file names* were
# written correctly though — they contain proper UTF-8. We use the file
# name (without the `NN - ` prefix and the `.flac` suffix) as the source
# of truth for the corrected TITLE tag.
#
# What this script does
# ─────────────────────
#   • Finds every *.flac under the album folder.
#   • Skips files whose current TITLE no longer contains `##` (idempotent).
#   • Replaces *only* the TITLE tag — every other tag (ARTIST, ALBUM,
#     ALBUMARTIST, TRACKNUMBER, REPLAYGAIN_*, QOBUZ*, …) is left untouched.
#   • Prints a one-line summary for each track and a final count.
#
# Usage
# ─────
#   1. Dry run (recommended first pass — shows what would change without
#      touching any file):
#         ./scripts/repair-clair-obscur-tags.sh --dry-run
#
#   2. Actually rewrite the tags:
#         ./scripts/repair-clair-obscur-tags.sh
#
#   3. Override the album path (e.g. moved drive):
#         ./scripts/repair-clair-obscur-tags.sh --path "/some/other/album"
#
# Requirements
# ────────────
#   • metaflac (Homebrew: `brew install flac`)
#   • bash 4+ (macOS ships 3.2 — the script uses POSIX-compatible idioms,
#     so /bin/bash works fine).
#
# Safety
# ──────
#   • Only the TITLE tag is rewritten. The audio frames are never touched.
#   • The script only runs on files whose current TITLE contains `##`,
#     so it is safe to re-run.
#   • If a file's name doesn't match the expected `NN - <title>.flac`
#     pattern, it is reported and skipped (not silently ignored).

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────
DEFAULT_ALBUM_PATH="/Volumes/ROMs Master/Music/Lorien Testard - Clair Obscur： Expedition 33 (Original Soundtrack) (2025)"
ALBUM_PATH="$DEFAULT_ALBUM_PATH"
DRY_RUN=0

# ── Argument parsing ────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=1
      shift
      ;;
    --path|-p)
      ALBUM_PATH="${2:-}"
      if [ -z "$ALBUM_PATH" ]; then
        echo "error: --path requires an argument" >&2
        exit 64
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '2,46p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1' (try --help)" >&2
      exit 64
      ;;
  esac
done

# ── Sanity checks ───────────────────────────────────────────────────────
if ! command -v metaflac >/dev/null 2>&1; then
  echo "error: 'metaflac' not found in PATH. Install it with: brew install flac" >&2
  exit 127
fi

if [ ! -d "$ALBUM_PATH" ]; then
  echo "error: album path does not exist: $ALBUM_PATH" >&2
  exit 66
fi

echo "📀 Album:     $ALBUM_PATH"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "🛡  Mode:      DRY-RUN (no files will be modified)"
else
  echo "✏️  Mode:      WRITE"
fi
echo

# ── Counters ────────────────────────────────────────────────────────────
total=0
fixed=0
skipped_clean=0
skipped_unmatched=0
errors=0

# ── Process every FLAC under the album folder ───────────────────────────
# We walk via `find -print0` to handle spaces, U+FF1A (full-width colon used
# in the directory name on macOS), and combining characters safely.
while IFS= read -r -d '' flac; do
  base="$(basename "$flac")"

  # macOS AppleDouble metadata files (`._<name>`) appear next to every real
  # file on FAT/exFAT volumes — they're not actual FLAC streams. Skip them
  # silently so the report stays focused on real tracks.
  if [[ "$base" == ._* ]]; then
    continue
  fi

  total=$((total + 1))

  # Filename without extension
  name_noext="${base%.flac}"
  # Strip the leading "NN - " (track number prefix)
  if [[ "$name_noext" =~ ^[0-9]+\ -\ (.+)$ ]]; then
    new_title="${BASH_REMATCH[1]}"
  else
    echo "⚠️  unmatched filename pattern (skipping): $flac"
    skipped_unmatched=$((skipped_unmatched + 1))
    continue
  fi

  # Read the current TITLE so we can decide whether to skip
  current_title="$(metaflac --show-tag=TITLE "$flac" 2>/dev/null | sed -e 's/^TITLE=//' || true)"

  # Idempotency: only touch files where TITLE still contains '##'
  if [[ "$current_title" != *"##"* ]]; then
    skipped_clean=$((skipped_clean + 1))
    continue
  fi

  printf '🎵 %s\n' "$base"
  printf '   old TITLE: %s\n' "$current_title"
  printf '   new TITLE: %s\n' "$new_title"

  if [ "$DRY_RUN" -eq 0 ]; then
    # Replace TITLE: remove all existing TITLE entries, then add the corrected one.
    # `--remove-tag=TITLE` works even if no TITLE is present.
    if metaflac --remove-tag=TITLE "$flac" \
        && metaflac --set-tag="TITLE=$new_title" "$flac"; then
      fixed=$((fixed + 1))
    else
      echo "   ❌ metaflac error while updating $flac"
      errors=$((errors + 1))
    fi
  else
    # In dry-run mode we still count "would-fix" as fixed for the summary
    fixed=$((fixed + 1))
  fi
done < <(find "$ALBUM_PATH" -type f -name '*.flac' -print0)

# ── Summary ─────────────────────────────────────────────────────────────
echo
echo "── Summary ──────────────────────────────────"
printf '   total flac files scanned: %d\n' "$total"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '   would fix:                %d\n' "$fixed"
else
  printf '   fixed:                    %d\n' "$fixed"
fi
printf '   already clean:            %d\n' "$skipped_clean"
printf '   filename pattern skip:    %d\n' "$skipped_unmatched"
printf '   errors:                   %d\n' "$errors"

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0