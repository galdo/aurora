#!/usr/bin/env python3
import argparse
import datetime
import json
import time
from pathlib import Path

import requests


def now_utc():
    return datetime.datetime.now(datetime.UTC)


def now_iso():
    return now_utc().isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_diag(path: Path):
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    host = str(payload.get("host") or "").strip()
    port = int(payload.get("port") or 0)
    token = str(payload.get("token") or "").strip()
    if not host or port <= 0 or not token:
        return {}
    return {"host": host, "port": port, "token": token}


def diag_request(diag, method, endpoint, payload=None):
    if not diag:
        return {"ok": False, "status": 0, "body": {}, "error": "diag_unavailable"}
    url = f"http://{diag['host']}:{diag['port']}{endpoint}"
    headers = {"x-aurora-token": diag["token"]}
    try:
        response = requests.request(method, url, headers=headers, json=payload, timeout=4.0)
        body = {}
        try:
            body = response.json()
        except Exception:
            body = {}
        return {"ok": response.ok, "status": int(response.status_code), "body": body}
    except Exception as error:
        return {"ok": False, "status": 0, "body": {}, "error": str(error)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=int, default=45)
    parser.add_argument("--poll-interval-ms", type=int, default=400)
    args = parser.parse_args()

    root = Path("/Users/I743956/Documents/Projekte/aurora")
    logs_dir = root / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stamp = now_utc().strftime("%Y%m%d-%H%M%S")
    report_json = logs_dir / f"dlna-ui-live-action-audit-{stamp}.json"
    report_md = logs_dir / f"dlna-ui-live-action-audit-{stamp}.md"
    diag_path = Path.home() / "Library/Application Support/Aurora_Pulse/Logs/diag-control.json"
    diag = load_diag(diag_path)

    health = diag_request(diag, "GET", "/diag/health")
    if not health.get("ok"):
        raise RuntimeError("diag_health_failed")
    diag_request(diag, "POST", "/diag/events/clear")

    start_at = now_iso()
    stop_ts = time.time() + max(5, args.duration)
    poll_interval = max(100, args.poll_interval_ms) / 1000
    last_seq = 0
    captured_events = []
    while time.time() < stop_ts:
        response = diag_request(diag, "GET", f"/diag/events?sinceSeq={last_seq}&limit=1500")
        body = response.get("body", {})
        events = body.get("events", [])
        latest_seq = int(body.get("latestSeq", last_seq))
        last_seq = max(last_seq, latest_seq)
        if events:
            captured_events.extend(events)
        time.sleep(poll_interval)

    final_state = diag_request(diag, "GET", "/diag/state").get("body", {}).get("state")
    dlna_log_lines = diag_request(diag, "GET", "/diag/logs?name=dlna&lines=500").get("body", {}).get("lines", [])

    ui_state_events = [event for event in captured_events if event.get("type") == "ui_state"]
    dlna_state_events = [event for event in captured_events if event.get("type") == "dlna_state"]
    playback_states = [
        (event.get("details") or {}).get("snapshot", {}).get("playbackState")
        for event in ui_state_events
    ]
    playback_states = [state for state in playback_states if state]
    progress_values = [
        float((event.get("details") or {}).get("snapshot", {}).get("progress") or 0)
        for event in ui_state_events
    ]
    progress_values = [value for value in progress_values if value >= 0]
    progress_increased = len(progress_values) >= 2 and max(progress_values) > min(progress_values)

    deviations = []
    if "media/playback/playing" not in playback_states:
        deviations.append("ui_state: no playing state observed")
    if not progress_increased:
        deviations.append("ui_state: no progress increase observed")
    if "media/playback/paused" not in playback_states and "media/playback/stopped" not in playback_states:
        deviations.append("ui_state: no paused or stopped state observed")
    playback_flip_count = 0
    for index in range(1, len(ui_state_events)):
        previous_snapshot = (ui_state_events[index - 1].get("details") or {}).get("snapshot", {})
        next_snapshot = (ui_state_events[index].get("details") or {}).get("snapshot", {})
        previous_state = str(previous_snapshot.get("playbackState") or "")
        next_state = str(next_snapshot.get("playbackState") or "")
        previous_progress = float(previous_snapshot.get("progress") or 0)
        next_progress = float(next_snapshot.get("progress") or 0)
        previous_ts = str(ui_state_events[index - 1].get("timestamp") or "")
        next_ts = str(ui_state_events[index].get("timestamp") or "")
        if previous_state == next_state:
            continue
        if not previous_ts or not next_ts:
            continue
        try:
            previous_dt = datetime.datetime.fromisoformat(previous_ts.replace("Z", "+00:00"))
            next_dt = datetime.datetime.fromisoformat(next_ts.replace("Z", "+00:00"))
        except Exception:
            continue
        delta_ms = abs((next_dt - previous_dt).total_seconds() * 1000)
        if delta_ms <= 350 and abs(next_progress - previous_progress) <= 0.1:
            playback_flip_count += 1
    if playback_flip_count > 0:
        deviations.append(f"ui_state: rapid playback state flips observed ({playback_flip_count})")

    remote_mode_flip_count = 0
    for index in range(1, len(dlna_state_events)):
        previous_output_mode = str((dlna_state_events[index - 1].get("details") or {}).get("outputMode") or "")
        next_output_mode = str((dlna_state_events[index].get("details") or {}).get("outputMode") or "")
        if previous_output_mode and next_output_mode and previous_output_mode != next_output_mode:
            remote_mode_flip_count += 1
    if remote_mode_flip_count > 4:
        deviations.append(f"dlna_state: frequent outputMode flips observed ({remote_mode_flip_count})")

    report = {
        "timestamp": now_iso(),
        "startedAt": start_at,
        "durationSeconds": max(5, args.duration),
        "capturedEventCount": len(captured_events),
        "uiStateEventCount": len(ui_state_events),
        "dlnaStateEventCount": len(dlna_state_events),
        "playbackStatesObserved": sorted(set(playback_states)),
        "progressIncreased": progress_increased,
        "playbackFlipCount": playback_flip_count,
        "remoteModeFlipCount": remote_mode_flip_count,
        "finalState": final_state,
        "deviations": deviations,
        "events": captured_events[-2000:],
        "dlnaLogLines": dlna_log_lines,
    }
    report_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        f"# DLNA UI Live Action Audit {stamp}",
        "",
        f"- StartedAt: `{start_at}`",
        f"- Duration: `{max(5, args.duration)}s`",
        f"- Captured events: `{len(captured_events)}`",
        f"- UI state events: `{len(ui_state_events)}`",
        f"- Playback states: `{', '.join(sorted(set(playback_states))) if playback_states else '-'}`",
        f"- Progress increased: `{progress_increased}`",
        f"- Deviations: `{len(deviations)}`",
    ]
    if deviations:
        lines.append("")
        lines.append("## Deviations")
        for deviation in deviations:
            lines.append(f"- {deviation}")
    lines.append("")
    lines.append(f"- JSON: `{report_json}`")
    report_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(report_md)
    print(report_json)


if __name__ == "__main__":
    main()
