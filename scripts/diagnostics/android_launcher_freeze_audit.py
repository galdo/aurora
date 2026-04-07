#!/usr/bin/env python3
import datetime
import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path


def now_utc():
    return datetime.datetime.now(datetime.UTC)


def ts_stamp():
    return now_utc().strftime("%Y%m%d-%H%M%S")


def run_adb(command: str) -> str:
    sdk = "/Users/I743956/Documents/Projekte/aurora/.android-sdk"
    env = os.environ.copy()
    env["ANDROID_SDK_ROOT"] = sdk
    env["ANDROID_HOME"] = sdk
    env["PATH"] = f"{sdk}/platform-tools:{env.get('PATH', '')}"
    proc = subprocess.run(
        command,
        shell=True,
        check=False,
        env=env,
        capture_output=True,
        text=True,
    )
    return proc.stdout or ""


def parse_threadtime_prefix(line: str):
    match = re.match(r"^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+", line)
    if not match:
        return ""
    second_value = match.group(2).split(".")[0]
    return f"{match.group(1)} {second_value}"


def main():
    root = Path("/Users/I743956/Documents/Projekte/aurora")
    logs_dir = root / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stamp = ts_stamp()
    out_dir = logs_dir / "android-freeze-investigation"
    out_dir.mkdir(parents=True, exist_ok=True)
    logcat_path = out_dir / f"logcat-all-freeze-audit-{stamp}.txt"
    events_path = out_dir / f"logcat-events-freeze-audit-{stamp}.txt"
    report_json = out_dir / f"launcher-freeze-audit-{stamp}.json"
    report_md = out_dir / f"launcher-freeze-audit-{stamp}.md"

    logcat_all = run_adb("adb -d logcat -b all -d -v threadtime")
    logcat_events = run_adb("adb -d logcat -b events -d -v threadtime")
    logcat_path.write_text(logcat_all, encoding="utf-8")
    events_path.write_text(logcat_events, encoding="utf-8")

    lines = logcat_all.splitlines()
    event_lines = logcat_events.splitlines()
    notification_lines = [
        line for line in lines
        if "notification_enqueue:" in line and "app.pulse.laucher,7391" in line
    ]
    boot_lines = [line for line in event_lines if "boot_progress_start" in line]
    proc_start_lines = [line for line in event_lines if "am_proc_start" in line and "app.pulse.laucher" in line]
    anr_lines = [line for line in event_lines if "am_anr" in line or "Input dispatching timed out" in line]
    crash_lines = [line for line in event_lines if "am_crash" in line or "FATAL EXCEPTION" in line]
    lowmem_lines = [line for line in event_lines if "am_low_memory" in line or "am_kill" in line]
    skipped_frame_lines = [line for line in lines if "Choreographer" in line and "Skipped" in line]
    gc_pressure_lines = [
        line for line in lines
        if "WaitForGcToComplete" in line
        or "Background young concurrent copying GC" in line
        or "Explicit concurrent copying GC" in line
    ]

    notifications_per_second = defaultdict(int)
    for line in notification_lines:
        key = parse_threadtime_prefix(line)
        if key:
            notifications_per_second[key] += 1
    peak_notification_second = ""
    peak_notification_value = 0
    for key, value in notifications_per_second.items():
        if value > peak_notification_value:
            peak_notification_second = key
            peak_notification_value = value

    conclusions = []
    if len(notification_lines) >= 150:
        conclusions.append("Sehr hohe Notification-Update-Rate für PulseMediaNotificationService (potenzieller UI/Binder-Stau).")
    if peak_notification_value >= 10:
        conclusions.append("Burst-Verhalten: >10 Notification-Updates innerhalb einer Sekunde.")
    if anr_lines:
        conclusions.append("ANR-Indikatoren im Event-Buffer gefunden.")
    if lowmem_lines:
        conclusions.append("Low-Memory-/Process-Kill-Ereignisse vorhanden.")
    if not conclusions:
        conclusions.append("Keine harte Ursache im aktuellen Buffer gefunden, wahrscheinlich vor Reboot abgeschnitten.")

    payload = {
        "timestamp": now_utc().isoformat(),
        "logcatPath": str(logcat_path),
        "eventsPath": str(events_path),
        "notificationEnqueueCount": len(notification_lines),
        "peakNotificationSecond": peak_notification_second,
        "peakNotificationPerSecond": peak_notification_value,
        "bootCountInBuffer": len(boot_lines),
        "launcherProcStarts": proc_start_lines[-20:],
        "anrEvents": anr_lines[-50:],
        "crashEvents": crash_lines[-50:],
        "lowMemoryEvents": lowmem_lines[-120:],
        "skippedFrameLines": skipped_frame_lines[-120:],
        "gcPressureLines": gc_pressure_lines[-120:],
        "conclusions": conclusions,
    }
    report_json.write_text(__import__("json").dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    md_lines = [
        f"# Launcher Freeze Audit {stamp}",
        "",
        f"- Notification enqueue count (Pulse Media): `{len(notification_lines)}`",
        f"- Peak notification burst: `{peak_notification_value}` at `{peak_notification_second or '-'}`",
        f"- Boot markers in current buffer: `{len(boot_lines)}`",
        f"- Launcher process starts in current buffer: `{len(proc_start_lines)}`",
        f"- ANR events in current buffer: `{len(anr_lines)}`",
        f"- Crash events in current buffer: `{len(crash_lines)}`",
        f"- Low-memory events in current buffer: `{len(lowmem_lines)}`",
        "",
        "## Conclusions",
    ]
    for conclusion in conclusions:
        md_lines.append(f"- {conclusion}")
    md_lines.extend([
        "",
        "## Paths",
        f"- Raw logcat: `{logcat_path}`",
        f"- Raw events: `{events_path}`",
        f"- JSON report: `{report_json}`",
    ])
    report_md.write_text("\n".join(md_lines) + "\n", encoding="utf-8")
    print(report_md)
    print(report_json)


if __name__ == "__main__":
    main()
