#!/usr/bin/env python3
import datetime
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path

import requests


SERVICE_AVT = "urn:schemas-upnp-org:service:AVTransport:1"


def now_utc():
    return datetime.datetime.now(datetime.UTC)


def now_iso():
    return now_utc().isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_json_lines(path: Path, offset: int):
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    parsed = []
    for line in lines[offset:]:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed.append(json.loads(line))
        except Exception:
            continue
    return parsed


def load_diag_control(path: Path):
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


def soap(base, action, inner):
    body = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
        "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
        "<s:Body>"
        f"<u:{action} xmlns:u=\"{SERVICE_AVT}\">{inner}</u:{action}>"
        "</s:Body></s:Envelope>"
    )
    start = time.time()
    response = requests.post(
        f"{base}/upnp/control/avtransport",
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPACTION": f"\"{SERVICE_AVT}#{action}\"",
        },
        timeout=7.0,
    )
    duration = int((time.time() - start) * 1000)
    text = response.text or ""
    state = re.search(r"<CurrentTransportState>([^<]+)", text)
    rel = re.search(r"<RelTime>([^<]+)", text)
    idx = re.search(r"<X_PlaylistIndex>([^<]+)", text)
    return {
        "timestamp": now_iso(),
        "action": action,
        "status": int(response.status_code),
        "durationMs": duration,
        "transportState": state.group(1) if state else "",
        "relTime": rel.group(1) if rel else "",
        "playlistIndex": int(idx.group(1)) if idx else None,
    }


def run_adb_capture(path: Path):
    sdk = "/Users/I743956/Documents/Projekte/aurora/.android-sdk"
    env = os.environ.copy()
    env["ANDROID_SDK_ROOT"] = sdk
    env["ANDROID_HOME"] = sdk
    env["PATH"] = f"{sdk}/platform-tools:{env.get('PATH', '')}"
    subprocess.run(["adb", "-d", "logcat", "-c"], check=False, env=env)
    proc = subprocess.run(
        "adb -d logcat -d -v time | egrep \"PulseDLNAQueue|DLNA_|PlaybackState updated|QueueContext applied|SetAVTransportURI|GetPositionInfo|GetTransportInfo\" | tail -n 400",
        shell=True,
        check=False,
        env=env,
        capture_output=True,
        text=True,
    )
    path.write_text(proc.stdout or "", encoding="utf-8")
    return proc.stdout or ""


def main():
    root = Path("/Users/I743956/Documents/Projekte/aurora")
    logs_dir = root / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stamp = now_utc().strftime("%Y%m%d-%H%M%S")
    report_json = logs_dir / f"dlna-mitm-mapping-{stamp}.json"
    report_md = logs_dir / f"dlna-mitm-mapping-{stamp}.md"
    adb_log = logs_dir / f"android-dlna-mitm-{stamp}.log"
    dlna_log = Path.home() / "Library/Application Support/Aurora_Pulse/Logs/dlna.log"
    diag_path = Path.home() / "Library/Application Support/Aurora_Pulse/Logs/diag-control.json"

    dlna_offset = 0
    if dlna_log.exists():
        dlna_offset = len(dlna_log.read_text(encoding="utf-8", errors="ignore").splitlines())

    diag = load_diag_control(diag_path)
    base = discover_renderer_base()
    queue_payload = {
        "contextId": f"mitm-{int(time.time())}",
        "reset": True,
        "tracks": [
            {"uri": "http://example.com/m1.mp3", "title": "M1", "artist": "A"},
            {"uri": "http://example.com/m2.mp3", "title": "M2", "artist": "B"},
        ],
        "currentUri": "http://example.com/m1.mp3",
    }
    requests.post(f"{base}/aurora/queue", json=queue_payload, timeout=5)
    soap(base, "SetAVTransportURI", "<InstanceID>0</InstanceID><CurrentURI>http://example.com/m1.mp3</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>")
    soap(base, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")
    time.sleep(1.0)

    flow = []
    remote_on = diag_request(diag, "POST", "/diag/action", {"action": "remote_on"})
    remote_state = diag_request(diag, "GET", "/diag/state")
    flow.append({
        "action": "remote_on",
        "controlRequestAt": now_iso(),
        "controlResult": remote_on,
        "rendererTransport": soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>"),
        "rendererPosition": soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>"),
        "controlState": remote_state.get("body", {}).get("state"),
    })
    time.sleep(1.0)
    for action in ["pause", "play", "next", "previous", "stop"]:
        control_request_at = now_iso()
        control_result = diag_request(diag, "POST", "/diag/action", {"action": action})
        time.sleep(0.8)
        transport = soap(base, "GetTransportInfo", "<InstanceID>0</InstanceID>")
        position = soap(base, "GetPositionInfo", "<InstanceID>0</InstanceID>")
        state_after = diag_request(diag, "GET", "/diag/state")
        flow.append({
            "action": action,
            "controlRequestAt": control_request_at,
            "controlResult": control_result,
            "rendererTransport": transport,
            "rendererPosition": position,
            "controlState": state_after.get("body", {}).get("state"),
        })

    dlna_events = parse_json_lines(dlna_log, dlna_offset)
    adb_text = run_adb_capture(adb_log)

    deviations = []
    for row in flow:
        action = row["action"]
        result_payload = row["controlResult"].get("body", {}).get("result")
        action_ok = bool((result_payload or {}).get("ok")) if isinstance(result_payload, dict) else bool(result_payload)
        if not action_ok:
            deviations.append(f"{action}: control action not acknowledged")
        if action == "remote_on":
            control_state = row.get("controlState") or {}
            if not control_state.get("remoteOutputRequested"):
                deviations.append("remote_on: control still not in remote mode")
            continue
        state_after = row["rendererTransport"].get("transportState", "").upper()
        if action == "pause" and state_after not in {"PAUSED_PLAYBACK", "PAUSED"}:
            deviations.append(f"{action}: renderer state is {state_after or '-'}")
        if action == "play" and state_after != "PLAYING":
            deviations.append(f"{action}: renderer state is {state_after or '-'}")
        if action == "stop" and state_after != "STOPPED":
            deviations.append(f"{action}: renderer state is {state_after or '-'}")

    notify_count = sum(1 for e in dlna_events if e.get("event") == "renderer_event_notify")
    subscribe_ack_count = sum(1 for e in dlna_events if e.get("event") == "renderer_event_subscribe_ack")
    subscribe_failed_404 = any(
        e.get("event") == "renderer_event_subscribe_failed"
        and int((e.get("details") or {}).get("status") or 0) == 404
        for e in dlna_events
    )
    if subscribe_ack_count == 0 and not subscribe_failed_404:
        deviations.append("missing renderer_event_subscribe_ack")
    if notify_count == 0 and not subscribe_failed_404:
        deviations.append("missing renderer_event_notify")

    report = {
        "timestamp": now_iso(),
        "rendererBase": base,
        "diagAvailable": bool(diag),
        "flow": flow,
        "dlnaEventCount": len(dlna_events),
        "dlnaEvents": dlna_events[-200:],
        "rendererNotifyCount": notify_count,
        "subscribeAckCount": subscribe_ack_count,
        "adbLogPath": str(adb_log),
        "adbPreview": adb_text.splitlines()[-80:],
        "deviations": deviations,
    }
    report_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        f"# DLNA MITM Mapping {stamp}",
        "",
        f"- Renderer: `{base}`",
        f"- Diag available: `{bool(diag)}`",
        f"- subscribeAckCount: `{subscribe_ack_count}`",
        f"- rendererNotifyCount: `{notify_count}`",
        f"- Deviations: `{len(deviations)}`",
        "",
        "## Command Mapping",
    ]
    for row in flow:
        action = row["action"]
        state = row["rendererTransport"].get("transportState") or "-"
        rel = row["rendererPosition"].get("relTime") or "-"
        lines.append(f"- {action}: controlStatus={row['controlResult'].get('status')} rendererState={state} rel={rel}")
    if deviations:
        lines.append("")
        lines.append("## Deviations")
        for deviation in deviations:
            lines.append(f"- {deviation}")
    lines.append("")
    lines.append(f"- JSON: `{report_json}`")
    lines.append(f"- ADB: `{adb_log}`")
    lines.append(f"- DLNA log: `{dlna_log}`")
    report_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(report_md)
    print(report_json)


if __name__ == "__main__":
    main()
