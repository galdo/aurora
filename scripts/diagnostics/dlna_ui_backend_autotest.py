#!/usr/bin/env python3
import argparse
import datetime
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests


SERVICE_AVT = "urn:schemas-upnp-org:service:AVTransport:1"
SSDP_ADDR = ("239.255.255.250", 1900)


def now_iso() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def discover_renderer(wait_seconds: float) -> str:
    msg = "\r\n".join([
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        "MAN: \"ssdp:discover\"",
        "MX: 2",
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
        "",
        "",
    ]).encode("utf-8")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(0.6)
    for _ in range(3):
        sock.sendto(msg, SSDP_ADDR)
        time.sleep(0.2)
    stop_at = time.time() + wait_seconds
    while time.time() < stop_at:
        try:
            data, _addr = sock.recvfrom(65535)
        except Exception:
            continue
        text = data.decode(errors="ignore")
        location_match = re.search(r"(?im)^location:\s*(\S+)\s*$", text)
        if not location_match:
            continue
        location = location_match.group(1).strip()
        try:
            description_xml = requests.get(location, timeout=2.5).text
        except Exception:
            continue
        if "Aurora Pulse Launcher" in description_xml:
            return location.rsplit("/", 1)[0]
    raise RuntimeError("Renderer nicht gefunden")


def soap(base: str, action: str, inner_xml: str, timeout: float = 7.0) -> dict:
    envelope = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
        "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
        "<s:Body>"
        f"<u:{action} xmlns:u=\"{SERVICE_AVT}\">{inner_xml}</u:{action}>"
        "</s:Body>"
        "</s:Envelope>"
    )
    started = time.time()
    response = requests.post(
        f"{base}/upnp/control/avtransport",
        data=envelope.encode("utf-8"),
        headers={
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPACTION": f"\"{SERVICE_AVT}#{action}\"",
        },
        timeout=timeout,
    )
    duration_ms = int((time.time() - started) * 1000)
    body = response.text or ""
    state = re.search(r"<CurrentTransportState>([^<]+)", body)
    rel = re.search(r"<RelTime>([^<]+)", body)
    idx = re.search(r"<X_PlaylistIndex>([^<]+)", body)
    uri = re.search(r"<TrackURI>([^<]+)", body)
    return {
        "timestamp": now_iso(),
        "action": action,
        "status": int(response.status_code),
        "ok": bool(response.ok),
        "durationMs": duration_ms,
        "transportState": state.group(1) if state else "",
        "relTime": rel.group(1) if rel else "",
        "playlistIndex": int(idx.group(1)) if idx else None,
        "trackUri": uri.group(1) if uri else "",
        "bodySnippet": body[:300].replace("\n", " "),
    }


def parse_hms_seconds(value: str) -> int:
    if not value or ":" not in value:
        return 0
    parts = value.split(":")
    if len(parts) != 3:
        return 0
    try:
        hours, minutes, seconds = [int(x) for x in parts]
        return (hours * 3600) + (minutes * 60) + seconds
    except Exception:
        return 0


def read_json_lines(path: Path, offset_lines: int) -> list:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    subset = lines[offset_lines:]
    parsed = []
    for line in subset:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed.append(json.loads(line))
        except Exception:
            continue
    return parsed


def load_diag_control(path: Path) -> dict:
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


def diag_request(diag: dict, method: str, endpoint: str, payload: dict | None = None) -> dict:
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


def wait_for_diag_control(diag_config_path: Path, wait_seconds: float = 8.0) -> dict:
    stop_at = time.time() + max(0.5, wait_seconds)
    last_diag = {}
    while time.time() < stop_at:
        last_diag = load_diag_control(diag_config_path)
        if not last_diag:
            time.sleep(0.25)
            continue
        probe = diag_request(last_diag, "GET", "/diag/health")
        if probe.get("ok"):
            return last_diag
        time.sleep(0.25)
    return last_diag


def diag_request_with_refresh(diag: dict, diag_config_path: Path, method: str, endpoint: str, payload: dict | None = None) -> tuple[dict, dict]:
    result = diag_request(diag, method, endpoint, payload)
    if result.get("ok"):
        return result, diag
    refreshed_diag = wait_for_diag_control(diag_config_path, wait_seconds=4.0)
    if not refreshed_diag:
        return result, diag
    retried = diag_request(refreshed_diag, method, endpoint, payload)
    if retried.get("ok"):
        return retried, refreshed_diag
    return result, refreshed_diag


def run_adb_filtered(output_path: Path) -> None:
    env = os.environ.copy()
    sdk = "/Users/I743956/Documents/Projekte/aurora/.android-sdk"
    env["ANDROID_SDK_ROOT"] = sdk
    env["ANDROID_HOME"] = sdk
    env["PATH"] = f"{sdk}/platform-tools:{env.get('PATH','')}"
    subprocess.run(["adb", "-d", "logcat", "-d", "-v", "time"], check=False, env=env, capture_output=True, text=True)
    proc = subprocess.run(
        "adb -d logcat -d -v time | egrep \"PulseDLNAQueue|DLNA_|PlaybackState updated|QueueContext applied|SetAVTransportURI|GetPositionInfo|GetTransportInfo\" | tail -n 320",
        check=False,
        env=env,
        shell=True,
        capture_output=True,
        text=True,
    )
    output_path.write_text(proc.stdout or "", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait-discovery", type=float, default=5.0)
    parser.add_argument("--report-dir", default="/Users/I743956/Documents/Projekte/aurora/logs")
    parser.add_argument("--dlna-log", default=os.path.expanduser("~/Library/Application Support/Aurora_Pulse/Logs/dlna.log"))
    parser.add_argument("--diag-config", default=os.path.expanduser("~/Library/Application Support/Aurora_Pulse/Logs/diag-control.json"))
    args = parser.parse_args()

    report_dir = Path(args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    dlna_log = Path(args.dlna_log)
    diag_config_path = Path(args.diag_config)
    offset_lines = 0
    if dlna_log.exists():
        offset_lines = len(dlna_log.read_text(encoding="utf-8", errors="ignore").splitlines())

    base = discover_renderer(args.wait_discovery)
    diag = wait_for_diag_control(diag_config_path, wait_seconds=8.0)

    queue_payload = {
        "contextId": f"auto-e2e-{int(time.time())}",
        "reset": True,
        "tracks": [
            {"uri": "http://example.com/a1.mp3", "title": "Track One", "artist": "A"},
            {"uri": "http://example.com/a2.mp3", "title": "Track Two", "artist": "B"},
            {"uri": "http://example.com/a3.mp3", "title": "Track Three", "artist": "C"},
        ],
        "currentUri": "http://example.com/a1.mp3",
    }
    requests.post(f"{base}/aurora/queue", json=queue_payload, timeout=5)

    steps = []
    ui_trace = []
    steps.append(soap(base, "SetAVTransportURI", "<InstanceID>0</InstanceID><CurrentURI>http://example.com/a1.mp3</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>"))
    steps.append(soap(base, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>"))
    time.sleep(1.2)
    steps.append(soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>"))
    steps.append(soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>"))
    baseline_index = steps[-1].get("playlistIndex")
    time.sleep(0.8)
    if diag:
        remote_on_result, diag = diag_request_with_refresh(diag, diag_config_path, "POST", "/diag/action", {"action": "remote_on"})
        remote_state, diag = diag_request_with_refresh(diag, diag_config_path, "GET", "/diag/state")
        remote_on_result_payload = remote_on_result.get("body", {}).get("result")
        remote_on_ok = bool((remote_on_result_payload or {}).get("ok")) if isinstance(remote_on_result_payload, dict) else bool(remote_on_result_payload)
        ui_trace.append({
            "timestamp": now_iso(),
            "action": "remote_on",
            "actionResult": remote_on_result,
            "actionResultOk": remote_on_ok,
            "uiState": remote_state.get("body", {}).get("state"),
            "transportStateAfterAction": "",
            "positionAfterAction": "",
        })
        time.sleep(1.0)
        for action, wait_seconds in [("pause", 0.9), ("play", 1.0), ("stop", 0.8), ("next", 0.6), ("previous", 0.6)]:
            action_result, diag = diag_request_with_refresh(diag, diag_config_path, "POST", "/diag/action", {"action": action})
            ui_state, diag = diag_request_with_refresh(diag, diag_config_path, "GET", "/diag/state")
            action_result_payload = action_result.get("body", {}).get("result")
            action_result_ok = bool(action_result_payload) if isinstance(action_result_payload, bool) else bool((action_result_payload or {}).get("ok"))
            time.sleep(wait_seconds)
            transport = soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>")
            position = soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>")
            ui_trace.append({
                "timestamp": now_iso(),
                "action": action,
                "actionResult": action_result,
                "actionResultOk": action_result_ok,
                "uiState": ui_state.get("body", {}).get("state"),
                "transportStateAfterAction": transport.get("transportState"),
                "positionAfterAction": position.get("relTime"),
                "playlistIndexAfterAction": position.get("playlistIndex"),
            })
            steps.append(transport)
            steps.append(position)
    else:
        steps.append(soap(base, "Pause", "<InstanceID>0</InstanceID>"))
        time.sleep(0.6)
        steps.append(soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "Seek", "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>00:00:10</Target>"))
        steps.append(soap(base, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>"))
        steps.append(soap(base, "Next", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "Previous", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "Stop", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>"))
        steps.append(soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>"))

    time.sleep(3.5)
    dlna_events = read_json_lines(dlna_log, offset_lines)
    adb_log_path = report_dir / f"android-dlna-autotest-{int(time.time())}.log"
    run_adb_filtered(adb_log_path)

    all_ok = all(step["status"] == 200 for step in steps)
    play_state_ok = any(step["action"] == "GetTransportInfo" and step["transportState"] == "PLAYING" for step in steps)
    stop_state_ok = any(step["action"] == "GetTransportInfo" and step["transportState"] == "STOPPED" for step in steps)
    rel_times = [parse_hms_seconds(step["relTime"]) for step in steps if step["action"] == "GetPositionInfo" and step["relTime"]]
    position_progress_ok = len(rel_times) >= 2 and max(rel_times) > min(rel_times)
    next_prev_ok = False
    next_trace = next((row for row in ui_trace if row.get("action") == "next"), None)
    previous_trace = next((row for row in ui_trace if row.get("action") == "previous"), None)
    if next_trace and previous_trace and baseline_index is not None:
        next_index = next_trace.get("playlistIndexAfterAction")
        previous_index = previous_trace.get("playlistIndexAfterAction")
        if isinstance(next_index, int) and isinstance(previous_index, int):
            next_prev_ok = next_index > int(baseline_index) and previous_index < next_index
    elif not ui_trace:
        next_indices = [step["playlistIndex"] for step in steps if step["action"] == "GetPositionInfo" and step["playlistIndex"] is not None]
        if len(next_indices) >= 3:
            next_prev_ok = 1 in next_indices and 0 in next_indices

    snapshot_events = [
        event for event in dlna_events
        if event.get("event") in {
            "snapshot_state",
            "resume_requested",
            "queue_context_publish_requested",
            "queue_context_publish_ack",
            "playback_start_verification_timeout",
            "playback_start_unverified_soft_success",
        } or str(event.get("event") or "").startswith("controller_")
    ]
    report = {
        "timestamp": now_iso(),
        "rendererBase": base,
        "checks": {
            "allSoap200": all_ok,
            "playStateObserved": play_state_ok,
            "stopStateObserved": stop_state_ok,
            "positionProgressObserved": position_progress_ok,
            "nextPreviousObserved": next_prev_ok,
            "controllerEventsCaptured": len(snapshot_events) > 0,
        },
        "steps": steps,
        "controllerEventCount": len(snapshot_events),
        "controllerEvents": snapshot_events[-80:],
        "uiTrace": ui_trace,
        "diagControlConfigPath": str(diag_config_path),
        "diagControlAvailable": bool(diag),
        "androidLogPath": str(adb_log_path),
        "dlnaLogPath": str(dlna_log),
    }

    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d-%H%M%S")
    json_report = report_dir / f"dlna-ui-backend-autotest-{stamp}.json"
    md_report = report_dir / f"dlna-ui-backend-autotest-{stamp}.md"
    json_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_lines = [
        f"# DLNA UI/Backend Autotest {stamp}",
        "",
        f"- Renderer Base: `{base}`",
        f"- SOAP 200: `{all_ok}`",
        f"- PLAYING gesehen: `{play_state_ok}`",
        f"- STOPPED gesehen: `{stop_state_ok}`",
        f"- Positionsfortschritt gesehen: `{position_progress_ok}`",
        f"- Next/Previous Index-Wechsel gesehen: `{next_prev_ok}`",
        f"- Controller-Events erfasst: `{len(snapshot_events)}`",
        f"- Diagnose-Control verfügbar: `{bool(diag)}`",
        f"- Controller Log: `{dlna_log}`",
        f"- Android Log: `{adb_log_path}`",
        f"- JSON Report: `{json_report}`",
        "",
        "## Steps",
    ]
    for step in steps:
        md_lines.append(f"- {step['timestamp']} {step['action']} status={step['status']} state={step['transportState'] or '-'} rel={step['relTime'] or '-'} idx={step['playlistIndex']}")
    if ui_trace:
        md_lines.append("")
        md_lines.append("## UI Trace")
        for row in ui_trace:
            action_ok = row.get("actionResultOk")
            state_after = row.get("transportStateAfterAction") or "-"
            rel_after = row.get("positionAfterAction") or "-"
            md_lines.append(f"- {row['timestamp']} action={row['action']} actionOk={action_ok} rendererState={state_after} rel={rel_after}")
    md_report.write_text("\n".join(md_lines) + "\n", encoding="utf-8")

    print(str(md_report))
    print(str(json_report))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"autotest failed: {error}", file=sys.stderr)
        sys.exit(1)
