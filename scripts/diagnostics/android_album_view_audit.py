#!/usr/bin/env python3
import datetime
import json
import os
import sqlite3
import subprocess
import csv
import re
from collections import Counter, defaultdict
from pathlib import Path


def now_stamp() -> str:
    return datetime.datetime.now(datetime.UTC).strftime("%Y%m%d-%H%M%S")


def get_adb_env() -> dict:
    sdk = "/Users/I743956/Documents/Projekte/aurora/.android-sdk"
    env = os.environ.copy()
    env["ANDROID_SDK_ROOT"] = sdk
    env["ANDROID_HOME"] = sdk
    env["PATH"] = f"{sdk}/platform-tools:{env.get('PATH', '')}"
    return env


def run(command: str) -> subprocess.CompletedProcess:
    env = get_adb_env()
    return subprocess.run(command, shell=True, env=env, check=False, capture_output=True, text=True)


def pull_run_as_file(remote_path: str, local_path: Path) -> tuple[bool, str]:
    env = get_adb_env()
    with local_path.open("wb") as output:
        process = subprocess.run(
            [
                "adb", "-d", "exec-out",
                "run-as", "app.pulse.laucher",
                "cat", remote_path,
            ],
            env=env,
            check=False,
            stdout=output,
            stderr=subprocess.PIPE,
        )
    stderr_text = (process.stderr or b"").decode("utf-8", errors="ignore").strip()
    return process.returncode == 0, stderr_text


def ensure_sqlite_file(path: Path) -> tuple[bool, str]:
    if not path.exists() or path.stat().st_size < 32:
        return False, "db_file_missing_or_too_small"
    with path.open("rb") as f:
        header = f.read(16)
    if header == b"SQLite format 3\x00":
        return True, ""
    with path.open("rb") as f:
        preview = f.read(160).decode("utf-8", errors="ignore").strip()
    return False, f"invalid_sqlite_header_preview={preview[:120]}"


def parse_content_query_rows(text: str) -> list[dict]:
    rows = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line.startswith("Row:"):
            continue
        row = {}
        for part in line.split(", "):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            key = key.split(" ", 1)[-1].strip()
            row[key] = value.strip()
        if row:
            rows.append(row)
    return rows


def load_rows_via_mediastore() -> list[tuple[str, str, str, str, str, str]]:
    projection = "_data:title:artist:album:album_artist:album_id"
    result = run(
        f"adb -d shell content query --uri content://media/external/audio/media --projection {projection}"
    )
    if result.returncode != 0:
        raise RuntimeError(f"cannot_query_mediastore:{(result.stderr or '').strip()}")
    media_rows = parse_content_query_rows(result.stdout or "")
    normalized = []
    for row in media_rows:
        path_value = str(row.get("_data") or "").strip()
        folder_path = str(Path(path_value).parent) if path_value else str(row.get("album_id") or "")
        title = str(row.get("title") or "").strip()
        artist = str(row.get("artist") or "").strip()
        album_artist = str(row.get("album_artist") or "").strip()
        album = str(row.get("album") or "").strip()
        artwork_uri = str(row.get("album_id") or "").strip()
        normalized.append((folder_path, title, artist, album_artist, album, artwork_uri))
    return normalized


def compute_collection(folder_rows: list[dict], folder_key_hint: str) -> bool:
    # Sammlung = Ordner enthält Tracks von mehreren (Album-)Künstlern.
    # Wichtig: Nicht durch Track-Features (mehrere Track-Artists in `artist`) treiben lassen.
    folder_hint = str(folder_key_hint or '').lower()
    segments = folder_hint.split('/')
    has_disc_subfolders = any(re.match(r'^(?:cd|disc)\s*0*\d{1,2}$', seg, flags=re.IGNORECASE) for seg in segments)

    album_counts = Counter()
    album_artist_counts = Counter()
    for row in folder_rows:
        album = str(row.get("album") or "").strip().lower()
        if album:
            album_counts[album] += 1
        album_artist = str(row.get("album_artist") or "").strip().lower()
        if album_artist:
            album_artist_counts[album_artist] += 1

    unique_album_count = len(album_counts)
    unique_album_artist_count = len(album_artist_counts)

    dominant_album_artist_count = max(album_artist_counts.values()) if album_artist_counts else 0
    dominant_album_artist_share = (dominant_album_artist_count / len(folder_rows)) if folder_rows else 1.0

    collection_name_hint = (
        'remember' in folder_hint
        or 'audiophile' in folder_hint
        or 'sampler' in folder_hint
        or 'collection' in folder_hint
        or 'mix' in folder_hint
    )

    likely_single_album_album_artist_noise = unique_album_artist_count <= 1 or dominant_album_artist_share >= 0.90
    return (
        (not has_disc_subfolders)
        and (not likely_single_album_album_artist_noise)
        and (
            (collection_name_hint and unique_album_artist_count >= 2)
            or (unique_album_artist_count >= 2 and dominant_album_artist_share < 0.90)
            or (unique_album_count >= 2 and unique_album_artist_count >= 2)
            or (unique_album_count >= 3 and unique_album_artist_count >= 2)
        )
    )


def classify_folder(folder_rows: list[dict], folder_key_hint: str) -> dict:
    artists = [str(row["artist"]).strip() for row in folder_rows if str(row["artist"]).strip()]
    album_artists = [str(row["album_artist"]).strip() for row in folder_rows if str(row["album_artist"]).strip()]
    albums = [str(row["album"]).strip() for row in folder_rows if str(row["album"]).strip()]
    artworks = [str(row["artwork_uri"]).strip() for row in folder_rows if str(row["artwork_uri"]).strip()]
    artist_counts = Counter(artists)
    album_artist_counts = Counter(album_artists)
    album_counts = Counter([album.lower() for album in albums if album])
    best_artist = artist_counts.most_common(1)[0][0] if artist_counts else "Unbekannter Interpret"
    best_album_artist = album_artist_counts.most_common(1)[0][0] if album_artist_counts else ""
    unique_album_count = len(album_counts)
    dominant_album_count = max(album_counts.values()) if album_counts else 0
    dominant_share = (dominant_album_count / len(folder_rows)) if folder_rows else 1.0
    dominant_artist_share = (artist_counts.most_common(1)[0][1] / len(folder_rows)) if artist_counts and folder_rows else 1.0
    is_collection = compute_collection(folder_rows, folder_key_hint)
    normalized_best_album_artist = best_album_artist.strip().lower()
    album_artist_is_va = normalized_best_album_artist == "various artists"

    # Subtitle wie in der App (TS): 
    # - Sammlung => Immer Various Artists
    # - AlbumArtist = Various Artists => Various Artists
    # - Sonst bestAlbumArtist, sonst bestArtist
    if is_collection or album_artist_is_va:
        display_subtitle = "Various Artists"
    elif best_album_artist:
        display_subtitle = best_album_artist
    else:
        display_subtitle = best_artist
    display_cover_mode = "mosaic" if is_collection else ("single" if artworks else "missing")

    if is_collection:
        folder_type = "sammlung"
    elif album_artist_is_va:
        folder_type = "compilation"
    else:
        folder_type = "album"

    return {
        "folderType": folder_type,
        "displaySubtitle": display_subtitle,
        "displayCoverMode": display_cover_mode,
        "trackCount": len(folder_rows),
        "artistsCount": len(set([a.lower() for a in artists])),
        "albumArtistsCount": len(set([a.lower() for a in album_artists])),
        "albumsCount": unique_album_count,
        "dominantAlbumShare": round(dominant_share, 4),
        "dominantArtistShare": round(dominant_artist_share, 4),
        "dominantArtist": best_artist,
        "dominantAlbumArtist": best_album_artist,
        "distinctArtworkCount": len(set(artworks)),
        "exampleAlbum": albums[0] if albums else "",
    }


def main() -> None:
    root = Path("/Users/I743956/Documents/Projekte/aurora")
    out_dir = root / "logs" / "android-album-audit"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = now_stamp()
    db_local_path = out_dir / f"library_index_{stamp}.db"
    report_json = out_dir / f"album-view-audit-{stamp}.json"
    report_md = out_dir / f"album-view-audit-{stamp}.md"
    table_md = out_dir / f"album-view-audit-table-{stamp}.md"
    table_csv = out_dir / f"album-view-audit-table-{stamp}.csv"

    devices = run("adb devices").stdout
    if "\tdevice" not in devices:
        raise RuntimeError("no_adb_device")

    source_mode = "sqlite"
    pulled, stderr_text = pull_run_as_file("databases/library_index.db", db_local_path)
    rows: list[tuple[str, str, str, str, str, str]] = []
    if pulled:
        sqlite_ok, sqlite_error = ensure_sqlite_file(db_local_path)
        if sqlite_ok:
            connection = sqlite3.connect(str(db_local_path))
            cursor = connection.cursor()
            cursor.execute(
                "SELECT folder_path, title, artist, album_artist, album, artwork_uri FROM tracks ORDER BY folder_path"
            )
            rows = cursor.fetchall()
            connection.close()
        else:
            source_mode = f"mediastore_fallback:{sqlite_error}"
            rows = load_rows_via_mediastore()
    else:
        source_mode = f"mediastore_fallback:{stderr_text or 'run_as_failed'}"
        rows = load_rows_via_mediastore()

    folders = defaultdict(list)
    for folder_path, title, artist, album_artist, album, artwork_uri in rows:
        folders[str(folder_path or "")].append({
            "title": str(title or ""),
            "artist": str(artist or ""),
            "album_artist": str(album_artist or ""),
            "album": str(album or ""),
            "artwork_uri": str(artwork_uri or ""),
        })

    compilation_issues = []
    collection_issues = []
    folder_table_rows = []
    for folder_path, folder_rows in folders.items():
        folder_meta = classify_folder(folder_rows, folder_path)
        folder_table_rows.append({
            "folderPath": folder_path,
            **folder_meta,
        })
        if folder_meta["folderType"] == "sammlung" and folder_meta["distinctArtworkCount"] < 2:
            collection_issues.append({
                "folderPath": folder_path,
                "trackCount": folder_meta["trackCount"],
                "distinctArtworkCount": folder_meta["distinctArtworkCount"],
                "artistsCount": folder_meta["artistsCount"],
                "albumsCount": folder_meta["albumsCount"],
            })
        if folder_meta["folderType"] == "compilation" and folder_meta["displaySubtitle"] != "Various Artists":
            compilation_issues.append({
                "folderPath": folder_path,
                "trackCount": folder_meta["trackCount"],
                "artistsCount": folder_meta["artistsCount"],
                "albumsCount": folder_meta["albumsCount"],
                "dominantAlbumArtist": folder_meta["dominantAlbumArtist"],
            })
    folder_table_rows.sort(key=lambda row: (str(row["folderPath"]).lower(), str(row["exampleAlbum"]).lower()))

    with table_csv.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file, delimiter=";")
        writer.writerow([
            "folderPath",
            "folderType",
            "displaySubtitle",
            "displayCoverMode",
            "trackCount",
            "artistsCount",
            "albumArtistsCount",
            "albumsCount",
            "dominantAlbumShare",
            "dominantArtistShare",
            "dominantArtist",
            "dominantAlbumArtist",
            "distinctArtworkCount",
            "exampleAlbum",
        ])
        for row in folder_table_rows:
            writer.writerow([
                row["folderPath"],
                row["folderType"],
                row["displaySubtitle"],
                row["displayCoverMode"],
                row["trackCount"],
                row["artistsCount"],
                row["albumArtistsCount"],
                row["albumsCount"],
                row["dominantAlbumShare"],
                row["dominantArtistShare"],
                row["dominantArtist"],
                row["dominantAlbumArtist"],
                row["distinctArtworkCount"],
                row["exampleAlbum"],
            ])

    table_lines = [
        f"# Android Album View Tabelle {stamp}",
        "",
        "| folderPath | type | subtitle | coverMode | tracks | artists | albumArtists | albums | artCount | dominantArtist | dominantAlbumArtist |",
        "|---|---:|---|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for row in folder_table_rows:
        table_lines.append(
            f"| {row['folderPath']} | {row['folderType']} | {row['displaySubtitle']} | {row['displayCoverMode']} | {row['trackCount']} | {row['artistsCount']} | {row['albumArtistsCount']} | {row['albumsCount']} | {row['distinctArtworkCount']} | {row['dominantArtist']} | {row['dominantAlbumArtist']} |"
        )
    table_md.write_text("\n".join(table_lines) + "\n", encoding="utf-8")

    payload = {
        "timestamp": stamp,
        "sourceMode": source_mode,
        "trackCount": len(rows),
        "folderCount": len(folders),
        "folderTablePath": str(table_md),
        "folderCsvPath": str(table_csv),
        "collectionIssues": collection_issues,
        "compilationIssues": compilation_issues,
        "folders": folder_table_rows,
        "sourceDb": str(db_local_path),
    }
    report_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        f"# Android Album View Audit {stamp}",
        "",
        f"- Source: `{source_mode}`",
        f"- Tracks: `{len(rows)}`",
        f"- Folders: `{len(folders)}`",
        f"- Collection mosaic issues: `{len(collection_issues)}`",
        f"- Compilation artist issues: `{len(compilation_issues)}`",
    ]
    if collection_issues:
        lines.extend(["", "## Collection Mosaic Issues"])
        for issue in collection_issues[:30]:
            lines.append(f"- {issue['folderPath']} | tracks={issue['trackCount']} artworks={issue['distinctArtworkCount']} artists={issue['artistsCount']} albums={issue['albumsCount']}")
    if compilation_issues:
        lines.extend(["", "## Compilation Artist Issues"])
        for issue in compilation_issues[:30]:
            lines.append(f"- {issue['folderPath']} | tracks={issue['trackCount']} artists={issue['artistsCount']} dominantAlbumArtist={issue['dominantAlbumArtist'] or '-'}")
    lines.extend([
        "",
        f"- Folder-Tabelle (Markdown): `{table_md}`",
        f"- Folder-Tabelle (CSV): `{table_csv}`",
        f"- JSON: `{report_json}`",
        f"- DB copy: `{db_local_path}`",
    ])
    report_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(report_md)
    print(report_json)


if __name__ == "__main__":
    main()
