#!/usr/bin/env python3
import datetime
import json
import re
import socket
import time
from pathlib import Path

import requests


SERVICE_AVT = "urn:schemas-upnp-org:service:AVTransport:1"


def now_utc():
    return datetime.datetime.now(datetime.UTC)


def now_iso():
    return now_utc().isoformat(timespec="milliseconds").replace("+00:00", "Z")


def discover_renderer_base(wait_seconds=6.0):
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
        sock.sendto(msg, ("239.255.255.250", 1900))
        time.sleep(0.2)
    stop_at = time.time() + wait_seconds
    while time.time() < stop_at:
        try:
            data, _addr = sock.recvfrom(65535)
        except Exception:
            continue
        text = data.decode(errors="ignore")
        m = re.search(r"(?im)^location:\s*(\S+)\s*$", text)
        if not m:
            continue
        location = m.group(1).strip()
        try:
            xml = requests.get(location, timeout=2.5).text
        except Exception:
            continue
        if "Aurora Pulse Launcher" in xml:
            return location.rsplit("/", 1)[0]
    raise RuntimeError("renderer_not_found")


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
        response = requests.request(method, url, headers=headers, json=payload, timeout=5.0)
        body = {}
        try:
            body = response.json()
        except Exception:
            body = {}
        return {"ok": response.ok, "status": int(response.status_code), "body": body}
    except Exception as error:
        return {"ok": False, "status": 0, "body": {}, "error": str(error)}


def soap(base, action, inner):
    body = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
        "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
        "<s:Body>"
        f"<u:{action} xmlns:u=\"{SERVICE_AVT}\">{inner}</u:{action}>"
        "</s:Body></s:Envelope>"
    )
    started = time.time()
    response = requests.post(
        f"{base}/upnp/control/avtransport",
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPACTION": f"\"{SERVICE_AVT}#{action}\"",
        },
        timeout=7.0,
    )
    duration_ms = int((time.time() - started) * 1000)
    text = response.text or ""
    state = re.search(r"<CurrentTransportState>([^<]+)", text)
    rel = re.search(r"<RelTime>([^<]+)", text)
    idx = re.search(r"<X_PlaylistIndex>([^<]+)", text)
    return {
        "status": int(response.status_code),
        "durationMs": duration_ms,
        "transportState": state.group(1) if state else "",
        "relTime": rel.group(1) if rel else "",
        "playlistIndex": int(idx.group(1)) if idx else None,
    }


def expected_ui_state_for_action(action: str):
    if action == "pause":
        return "media/playback/paused"
    if action in {"play", "next", "previous"}:
        return "media/playback/playing"
    if action == "stop":
        return {"media/playback/stopped", "media/playback/paused"}
    return None


def expected_renderer_state_for_action(action: str):
    if action == "pause":
        return {"PAUSED_PLAYBACK", "PAUSED"}
    if action in {"play", "next", "previous"}:
        return {"PLAYING"}
    if action == "stop":
        return {"STOPPED"}
    return set()


def main():
    root = Path("/Users/I743956/Documents/Projekte/aurora")
    logs_dir = root / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stamp = now_utc().strftime("%Y%m%d-%H%M%S")
    report_json = logs_dir / f"dlna-ui-event-pipeline-{stamp}.json"
    report_md = logs_dir / f"dlna-ui-event-pipeline-{stamp}.md"
    diag_path = Path.home() / "Library/Application Support/Aurora_Pulse/Logs/diag-control.json"
    diag = load_diag(diag_path)
    base = discover_renderer_base()

    queue_payload = {
        "contextId": f"event-pipeline-{int(time.time())}",
        "reset": True,
        "tracks": [
            {"uri": "http://example.com/e1.mp3", "title": "E1", "artist": "A"},
            {"uri": "http://example.com/e2.mp3", "title": "E2", "artist": "B"},
        ],
        "currentUri": "http://example.com/e1.mp3",
    }
    requests.post(f"{base}/aurora/queue", json=queue_payload, timeout=5)
    soap(base, "SetAVTransportURI", "<InstanceID>0</InstanceID><CurrentURI>http://example.com/e1.mp3</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>")
    soap(base, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")
    time.sleep(0.8)

    diag_request(diag, "POST", "/diag/events/clear")
    remote_on = diag_request(diag, "POST", "/diag/action", {"action": "remote_on"})
    time.sleep(0.6)
    event_state = diag_request(diag, "GET", "/diag/state")

    steps = [{
        "action": "remote_on",
        "control": remote_on,
        "controlState": event_state.get("body", {}).get("state"),
        "rendererTransport": soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>"),
        "rendererPosition": soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>"),
        "eventsWindow": [],
    }]

    last_seq = 0
    actions = ["pause", "play", "next", "previous", "stop"]
    for action in actions:
        request_at = now_iso()
        control = diag_request(diag, "POST", "/diag/action", {"action": action})
        time.sleep(1.0)
        events_result = diag_request(diag, "GET", f"/diag/events?sinceSeq={last_seq}&limit=500")
        events = events_result.get("body", {}).get("events", [])
        latest_seq = int(events_result.get("body", {}).get("latestSeq", last_seq))
        last_seq = max(last_seq, latest_seq)
        state_result = diag_request(diag, "GET", "/diag/state")
        renderer_transport = soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>")
        renderer_position = soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>")
        steps.append({
            "action": action,
            "requestAt": request_at,
            "control": control,
            "controlState": state_result.get("body", {}).get("state"),
            "rendererTransport": renderer_transport,
            "rendererPosition": renderer_position,
            "eventsWindow": events,
        })

    log_lines = diag_request(diag, "GET", "/diag/logs?name=dlna&lines=500").get("body", {}).get("lines", [])

    deviations = []
    for step in steps:
        action = step["action"]
        if action == "remote_on":
            state = step.get("controlState") or {}
            if not state.get("remoteOutputRequested"):
                deviations.append("remote_on: remoteOutputRequested is false")
            continue
        expected_renderer = expected_renderer_state_for_action(action)
        renderer_state = str(step["rendererTransport"].get("transportState") or "").upper()
        if expected_renderer and renderer_state not in expected_renderer:
            deviations.append(f"{action}: renderer state {renderer_state or '-'}")
        expected_ui_state = expected_ui_state_for_action(action)
        control_state = str((step.get("controlState") or {}).get("playbackState") or "")
        if isinstance(expected_ui_state, set):
            if control_state not in expected_ui_state:
                deviations.append(f"{action}: ui playbackState {control_state or '-'}")
        elif expected_ui_state and control_state != expected_ui_state:
            deviations.append(f"{action}: ui playbackState {control_state or '-'}")
        state_events = [event for event in step.get("eventsWindow", []) if event.get("type") == "ui_state"]
        if state_events:
            first_state = str((state_events[0].get("details") or {}).get("snapshot", {}).get("playbackState") or "")
            last_state = str((state_events[-1].get("details") or {}).get("snapshot", {}).get("playbackState") or "")
            if action == "pause" and first_state == "media/playback/paused" and last_state == "media/playback/playing":
                deviations.append("pause: ui state overwritten from paused to playing")
            if action == "stop" and first_state in {"media/playback/stopped", "media/playback/paused"} and last_state == "media/playback/playing":
                deviations.append("stop: ui state overwritten to playing")

    report = {
        "timestamp": now_iso(),
        "rendererBase": base,
        "diagAvailable": bool(diag),
        "steps": steps,
        "dlnaLogLines": log_lines,
        "deviations": deviations,
    }
    report_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        f"# DLNA UI Event Pipeline {stamp}",
        "",
        f"- Renderer: `{base}`",
        f"- Deviations: `{len(deviations)}`",
        "",
        "## Mapping",
    ]
    for step in steps:
        action = step["action"]
        renderer_state = step["rendererTransport"].get("transportState") or "-"
        ui_state = (step.get("controlState") or {}).get("playbackState") or "-"
        rel = step["rendererPosition"].get("relTime") or "-"
        lines.append(f"- {action}: rendererState={renderer_state} uiState={ui_state} rel={rel}")
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
