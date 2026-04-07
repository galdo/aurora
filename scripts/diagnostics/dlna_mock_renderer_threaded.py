#!/usr/bin/env python3
import argparse
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class RendererState:
    def __init__(self, host: str, port: int, queue_status: int):
        self.host = host
        self.port = port
        self.queue_status = queue_status
        self.transport_state = "STOPPED"
        self.current_uri = ""
        self.current_title = "Mock Track"
        self.current_artist = "Mock Artist"
        self.current_position = "00:00:00"
        self.current_duration = "00:03:30"
        self.queue = []
        self.queue_index = 0

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"

    def description_xml(self) -> str:
        return f"""<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>{self.base_url}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>MockRendererThreaded</friendlyName>
    <manufacturer>AuroraDiagnostics</manufacturer>
    <modelName>ThreadedModel</modelName>
    <UDN>uuid:aurora-threaded-renderer</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/upnp/scpd/avtransport.xml</SCPDURL>
        <controlURL>/upnp/control/avtransport</controlURL>
        <eventSubURL>/upnp/event/avtransport</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/upnp/scpd/renderingcontrol.xml</SCPDURL>
        <controlURL>/upnp/control/renderingcontrol</controlURL>
        <eventSubURL>/upnp/event/renderingcontrol</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>"""


def extract_xml(xml: str, tag: str) -> str:
    start = xml.lower().find(f"<{tag.lower()}>")
    end = xml.lower().find(f"</{tag.lower()}>")
    if start < 0 or end < 0 or end <= start:
        return ""
    start += len(tag) + 2
    return xml[start:end].strip()


def soap(action: str, namespace: str, body: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{namespace}">{body}</u:{action}>
  </s:Body>
</s:Envelope>"""


def create_handler(state: RendererState):
    class Handler(BaseHTTPRequestHandler):
        def _write(self, code: int, body: str, content_type: str):
            payload = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path == "/description.xml":
                self._write(200, state.description_xml(), "text/xml; charset=utf-8")
            else:
                self._write(404, "not found", "text/plain; charset=utf-8")

        def do_POST(self):
            content_length = int(self.headers.get("Content-Length", "0") or "0")
            body = self.rfile.read(content_length).decode("utf-8", "ignore")
            if self.path == "/aurora/queue":
                if state.queue_status != 200:
                    self._write(state.queue_status, json.dumps({"ok": False}), "application/json; charset=utf-8")
                    return
                try:
                    payload = json.loads(body or "{}")
                    state.queue = payload.get("tracks") or []
                    state.queue_index = int(payload.get("currentIndex") or 0)
                except Exception:
                    pass
                self._write(200, json.dumps({"ok": True}), "application/json; charset=utf-8")
                return
            if self.path != "/upnp/control/avtransport" and self.path != "/upnp/control/renderingcontrol":
                self._write(404, "not found", "text/plain; charset=utf-8")
                return
            action_header = self.headers.get("SOAPAction", "")
            action = action_header.split("#")[-1].replace('"', "").strip()
            if self.path.endswith("avtransport"):
                if action == "SetAVTransportURI":
                    state.current_uri = extract_xml(body, "CurrentURI")
                    state.transport_state = "STOPPED"
                    self._write(200, soap("SetAVTransportURIResponse", "urn:schemas-upnp-org:service:AVTransport:1", ""), "text/xml; charset=utf-8")
                    return
                if action == "SetNextAVTransportURI":
                    self._write(200, soap("SetNextAVTransportURIResponse", "urn:schemas-upnp-org:service:AVTransport:1", ""), "text/xml; charset=utf-8")
                    return
                if action == "Play":
                    state.transport_state = "PLAYING"
                    self._write(200, soap("PlayResponse", "urn:schemas-upnp-org:service:AVTransport:1", ""), "text/xml; charset=utf-8")
                    return
                if action == "Pause":
                    state.transport_state = "PAUSED_PLAYBACK"
                    self._write(200, soap("PauseResponse", "urn:schemas-upnp-org:service:AVTransport:1", ""), "text/xml; charset=utf-8")
                    return
                if action == "Stop":
                    state.transport_state = "STOPPED"
                    self._write(200, soap("StopResponse", "urn:schemas-upnp-org:service:AVTransport:1", ""), "text/xml; charset=utf-8")
                    return
                if action == "GetTransportInfo":
                    body_xml = f"<CurrentTransportState>{state.transport_state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>"
                    self._write(200, soap("GetTransportInfoResponse", "urn:schemas-upnp-org:service:AVTransport:1", body_xml), "text/xml; charset=utf-8")
                    return
                if action == "GetPositionInfo":
                    body_xml = f"<Track>1</Track><TrackDuration>{state.current_duration}</TrackDuration><TrackMetaData></TrackMetaData><TrackURI>{state.current_uri}</TrackURI><RelTime>{state.current_position}</RelTime><AbsTime>{state.current_position}</AbsTime><RelCount>0</RelCount><AbsCount>0</AbsCount>"
                    self._write(200, soap("GetPositionInfoResponse", "urn:schemas-upnp-org:service:AVTransport:1", body_xml), "text/xml; charset=utf-8")
                    return
            if self.path.endswith("renderingcontrol"):
                if action == "GetVolume":
                    self._write(200, soap("GetVolumeResponse", "urn:schemas-upnp-org:service:RenderingControl:1", "<CurrentVolume>35</CurrentVolume>"), "text/xml; charset=utf-8")
                    return
                if action == "GetMute":
                    self._write(200, soap("GetMuteResponse", "urn:schemas-upnp-org:service:RenderingControl:1", "<CurrentMute>0</CurrentMute>"), "text/xml; charset=utf-8")
                    return
            self._write(500, "unsupported", "text/plain; charset=utf-8")

        def log_message(self, *_args):
            return

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=45817)
    parser.add_argument("--queue-status", type=int, default=200)
    args = parser.parse_args()
    state = RendererState(args.host, args.port, args.queue_status)
    server = ThreadedHTTPServer((args.host, args.port), create_handler(state))
    print(f"threaded_renderer={state.base_url}")
    server.serve_forever()


if __name__ == "__main__":
    main()
