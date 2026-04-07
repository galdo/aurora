#!/usr/bin/env python3
import argparse
import json
import sys
import urllib.error
import urllib.request


def post(url: str, body: str, soap_action: str | None = None, content_type: str = "text/xml; charset=utf-8"):
    data = body.encode("utf-8")
    request = urllib.request.Request(url=url, data=data, method="POST")
    request.add_header("Content-Type", content_type)
    if soap_action:
        request.add_header("SOAPAction", soap_action)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = response.read().decode("utf-8", "ignore")
            return response.status, payload
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "ignore")
        return error.code, payload


def soap_body(action: str, namespace: str, inner: str):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{namespace}">{inner}</u:{action}>
  </s:Body>
</s:Envelope>"""


def run_matrix(base_url: str, queue_optional: bool):
    av = f"{base_url}/upnp/control/avtransport"
    rc = f"{base_url}/upnp/control/renderingcontrol"
    queue = f"{base_url}/aurora/queue"
    report = []

    queue_payload = {
        "contextId": "diag-context",
        "mode": "replace",
        "reset": True,
        "currentTrackId": "track-1",
        "tracks": [
            {
                "id": "track-1",
                "uri": "http://127.0.0.1:58200/stream/track-1",
                "title": "Track One",
                "artist": "Artist One",
                "albumArt": "http://127.0.0.1:58200/cover/track-1",
                "duration": 200,
            },
            {
                "id": "track-2",
                "uri": "http://127.0.0.1:58200/stream/track-2",
                "title": "Track Two",
                "artist": "Artist Two",
                "albumArt": "http://127.0.0.1:58200/cover/track-2",
                "duration": 220,
            },
        ],
    }
    status, payload = post(queue, json.dumps(queue_payload), content_type="application/json; charset=utf-8")
    report.append(("queue_context", status, "ok" if status == 200 else payload[:120]))

    set_uri = soap_body(
        "SetAVTransportURI",
        "urn:schemas-upnp-org:service:AVTransport:1",
        "<InstanceID>0</InstanceID><CurrentURI>http://127.0.0.1:58200/stream/track-1</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>",
    )
    status, _ = post(av, set_uri, '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"')
    report.append(("set_uri", status, "ok" if status == 200 else "fail"))

    set_next = soap_body(
        "SetNextAVTransportURI",
        "urn:schemas-upnp-org:service:AVTransport:1",
        "<InstanceID>0</InstanceID><NextURI>http://127.0.0.1:58200/stream/track-2</NextURI><NextURIMetaData></NextURIMetaData>",
    )
    status, _ = post(av, set_next, '"urn:schemas-upnp-org:service:AVTransport:1#SetNextAVTransportURI"')
    report.append(("set_next_uri", status, "ok" if status == 200 else "fail"))

    status, _ = post(av, soap_body("Play", "urn:schemas-upnp-org:service:AVTransport:1", "<InstanceID>0</InstanceID><Speed>1</Speed>"), '"urn:schemas-upnp-org:service:AVTransport:1#Play"')
    report.append(("play", status, "ok" if status == 200 else "fail"))
    status, _ = post(av, soap_body("Pause", "urn:schemas-upnp-org:service:AVTransport:1", "<InstanceID>0</InstanceID>"), '"urn:schemas-upnp-org:service:AVTransport:1#Pause"')
    report.append(("pause", status, "ok" if status == 200 else "fail"))
    status, _ = post(av, soap_body("Play", "urn:schemas-upnp-org:service:AVTransport:1", "<InstanceID>0</InstanceID><Speed>1</Speed>"), '"urn:schemas-upnp-org:service:AVTransport:1#Play"')
    report.append(("resume", status, "ok" if status == 200 else "fail"))
    status, _ = post(av, soap_body("GetTransportInfo", "urn:schemas-upnp-org:service:AVTransport:1", "<InstanceID>0</InstanceID>"), '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"')
    report.append(("get_transport", status, "ok" if status == 200 else "fail"))
    status, _ = post(av, soap_body("GetPositionInfo", "urn:schemas-upnp-org:service:AVTransport:1", "<InstanceID>0</InstanceID>"), '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"')
    report.append(("get_position", status, "ok" if status == 200 else "fail"))
    status, _ = post(rc, soap_body("GetVolume", "urn:schemas-upnp-org:service:RenderingControl:1", "<InstanceID>0</InstanceID><Channel>Master</Channel>"), '"urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"')
    report.append(("get_volume", status, "ok" if status == 200 else "fail"))
    status, _ = post(rc, soap_body("GetMute", "urn:schemas-upnp-org:service:RenderingControl:1", "<InstanceID>0</InstanceID><Channel>Master</Channel>"), '"urn:schemas-upnp-org:service:RenderingControl:1#GetMute"')
    report.append(("get_mute", status, "ok" if status == 200 else "fail"))
    status, _ = post(av, soap_body("Stop", "urn:schemas-upnp-org:service:AVTransport:1", "<InstanceID>0</InstanceID>"), '"urn:schemas-upnp-org:service:AVTransport:1#Stop"')
    report.append(("stop", status, "ok" if status == 200 else "fail"))

    failures = [row for row in report if row[1] != 200 and (row[0] != "queue_context" or not queue_optional)]
    print("dlna_command_matrix")
    for name, status, detail in report:
        print(f"{name} status={status} detail={detail}")
    return 0 if not failures else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--queue-optional", action="store_true")
    args = parser.parse_args()
    code = run_matrix(args.base_url.rstrip("/"), args.queue_optional)
    sys.exit(code)


if __name__ == "__main__":
    main()
