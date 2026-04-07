#!/usr/bin/env python3
import argparse
import asyncio
import json


class AsyncRenderer:
    def __init__(self, host: str, port: int, queue_status: int):
        self.host = host
        self.port = port
        self.queue_status = queue_status
        self.transport_state = "STOPPED"
        self.current_uri = ""
        self.current_position = "00:00:00"
        self.current_duration = "00:03:00"

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"

    def description(self):
        return f"""<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>{self.base_url}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>MockRendererAsyncio</friendlyName>
    <manufacturer>AuroraDiagnostics</manufacturer>
    <modelName>AsyncModel</modelName>
    <UDN>uuid:aurora-async-renderer</UDN>
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

    def soap(self, action: str, namespace: str, body: str):
        return f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{namespace}">{body}</u:{action}>
  </s:Body>
</s:Envelope>"""

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            line = await reader.readline()
            if not line:
                writer.close()
                await writer.wait_closed()
                return
            request_line = line.decode("utf-8", "ignore").strip()
            parts = request_line.split(" ")
            if len(parts) < 2:
                writer.close()
                await writer.wait_closed()
                return
            method, path = parts[0], parts[1]
            headers = {}
            while True:
                next_line = await reader.readline()
                if not next_line:
                    break
                decoded = next_line.decode("utf-8", "ignore").strip()
                if not decoded:
                    break
                if ":" in decoded:
                    key, value = decoded.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            content_length = int(headers.get("content-length", "0") or "0")
            body = ""
            if content_length > 0:
                body = (await reader.readexactly(content_length)).decode("utf-8", "ignore")
            status = 200
            content_type = "text/plain; charset=utf-8"
            payload = ""
            if method == "GET" and path == "/description.xml":
                payload = self.description()
                content_type = "text/xml; charset=utf-8"
            elif method == "POST" and path == "/aurora/queue":
                status = self.queue_status
                payload = json.dumps({"ok": status == 200})
                content_type = "application/json; charset=utf-8"
            elif method == "POST" and path == "/upnp/control/avtransport":
                action_header = headers.get("soapaction", "")
                action = action_header.split("#")[-1].replace('"', "").strip()
                if action == "SetAVTransportURI":
                    marker = "<CurrentURI>"
                    marker_end = "</CurrentURI>"
                    start = body.find(marker)
                    end = body.find(marker_end)
                    if start >= 0 and end > start:
                        self.current_uri = body[start + len(marker):end]
                    self.transport_state = "STOPPED"
                    payload = self.soap("SetAVTransportURIResponse", "urn:schemas-upnp-org:service:AVTransport:1", "")
                elif action == "SetNextAVTransportURI":
                    payload = self.soap("SetNextAVTransportURIResponse", "urn:schemas-upnp-org:service:AVTransport:1", "")
                elif action == "Play":
                    self.transport_state = "PLAYING"
                    payload = self.soap("PlayResponse", "urn:schemas-upnp-org:service:AVTransport:1", "")
                elif action == "Pause":
                    self.transport_state = "PAUSED_PLAYBACK"
                    payload = self.soap("PauseResponse", "urn:schemas-upnp-org:service:AVTransport:1", "")
                elif action == "Stop":
                    self.transport_state = "STOPPED"
                    payload = self.soap("StopResponse", "urn:schemas-upnp-org:service:AVTransport:1", "")
                elif action == "GetTransportInfo":
                    body_xml = f"<CurrentTransportState>{self.transport_state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>"
                    payload = self.soap("GetTransportInfoResponse", "urn:schemas-upnp-org:service:AVTransport:1", body_xml)
                elif action == "GetPositionInfo":
                    body_xml = f"<Track>1</Track><TrackDuration>{self.current_duration}</TrackDuration><TrackMetaData></TrackMetaData><TrackURI>{self.current_uri}</TrackURI><RelTime>{self.current_position}</RelTime><AbsTime>{self.current_position}</AbsTime><RelCount>0</RelCount><AbsCount>0</AbsCount>"
                    payload = self.soap("GetPositionInfoResponse", "urn:schemas-upnp-org:service:AVTransport:1", body_xml)
                else:
                    status = 500
                    payload = "unsupported"
                content_type = "text/xml; charset=utf-8"
            elif method == "POST" and path == "/upnp/control/renderingcontrol":
                action_header = headers.get("soapaction", "")
                action = action_header.split("#")[-1].replace('"', "").strip()
                if action == "GetVolume":
                    payload = self.soap("GetVolumeResponse", "urn:schemas-upnp-org:service:RenderingControl:1", "<CurrentVolume>25</CurrentVolume>")
                    content_type = "text/xml; charset=utf-8"
                elif action == "GetMute":
                    payload = self.soap("GetMuteResponse", "urn:schemas-upnp-org:service:RenderingControl:1", "<CurrentMute>0</CurrentMute>")
                    content_type = "text/xml; charset=utf-8"
                else:
                    status = 500
                    payload = "unsupported"
            else:
                status = 404
                payload = "not found"
            encoded = payload.encode("utf-8")
            writer.write(f"HTTP/1.1 {status} OK\r\n".encode("utf-8"))
            writer.write(f"Content-Type: {content_type}\r\n".encode("utf-8"))
            writer.write(f"Content-Length: {len(encoded)}\r\n".encode("utf-8"))
            writer.write(b"Connection: close\r\n\r\n")
            writer.write(encoded)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


async def run_server(host: str, port: int, queue_status: int):
    renderer = AsyncRenderer(host, port, queue_status)
    server = await asyncio.start_server(renderer.handle, host, port)
    print(f"async_renderer={renderer.base_url}")
    async with server:
        await server.serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=49153)
    parser.add_argument("--queue-status", type=int, default=500)
    args = parser.parse_args()
    asyncio.run(run_server(args.host, args.port, args.queue_status))


if __name__ == "__main__":
    main()
