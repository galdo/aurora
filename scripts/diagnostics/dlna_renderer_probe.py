import argparse
import socket
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

MCAST_GROUP = "239.255.255.250"
MCAST_PORT = 1900
SOAP_TIMEOUT_SECONDS = 3.5


def discover_renderer_locations(wait_seconds: float) -> dict:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(1.5)
    request = (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {MCAST_GROUP}:{MCAST_PORT}\r\n"
        "MAN: \"ssdp:discover\"\r\n"
        "MX: 2\r\n"
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
    )
    sock.sendto(request.encode("utf-8"), (MCAST_GROUP, MCAST_PORT))
    end_at = time.time() + wait_seconds
    by_location = {}
    while time.time() < end_at:
        try:
            payload, address = sock.recvfrom(65535)
        except Exception:
            continue
        text = payload.decode("utf-8", "ignore").replace("\r", "")
        headers = {}
        lines = [line.strip() for line in text.split("\n") if line.strip()]
        for line in lines[1:]:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
        location = headers.get("location", "")
        if not location:
            continue
        entry = by_location.setdefault(location, {"source_ip": address[0], "sts": set(), "server": headers.get("server", "")})
        response_st = headers.get("st", "")
        if response_st:
            entry["sts"].add(response_st)
    return by_location


def parse_renderer_services(description_xml: str):
    root = ET.fromstring(description_xml)
    namespace = {"upnp": "urn:schemas-upnp-org:device-1-0"}
    device = root.find(".//upnp:device", namespace)
    if device is None:
        return None
    device_type = (device.findtext("upnp:deviceType", default="", namespaces=namespace) or "").strip()
    friendly_name = (device.findtext("upnp:friendlyName", default="", namespaces=namespace) or "").strip()
    av_transport = None
    rendering_control = None
    connection_manager = None
    for service in device.findall(".//upnp:service", namespace):
        service_type = (service.findtext("upnp:serviceType", default="", namespaces=namespace) or "").strip()
        control_url = (service.findtext("upnp:controlURL", default="", namespaces=namespace) or "").strip()
        if "AVTransport" in service_type:
            av_transport = (service_type, control_url)
        elif "RenderingControl" in service_type:
            rendering_control = (service_type, control_url)
        elif "ConnectionManager" in service_type:
            connection_manager = (service_type, control_url)
    return {
        "device_type": device_type,
        "friendly_name": friendly_name,
        "av_transport": av_transport,
        "rendering_control": rendering_control,
        "connection_manager": connection_manager,
    }


def call_soap(location_url: str, service_type: str, control_url: str, action: str, body: str):
    base = urllib.parse.urlsplit(location_url)
    target = urllib.parse.urljoin(f"{base.scheme}://{base.netloc}", control_url)
    envelope = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f"<s:Body>{body}</s:Body></s:Envelope>"
    ).encode("utf-8")
    request = urllib.request.Request(
        target,
        data=envelope,
        method="POST",
        headers={
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": f"\"{service_type}#{action}\"",
        },
    )
    started = time.time()
    with urllib.request.urlopen(request, timeout=SOAP_TIMEOUT_SECONDS) as response:
        payload = response.read().decode("utf-8", "ignore")
        elapsed_ms = int((time.time() - started) * 1000)
        return elapsed_ms, payload


def main():
    parser = argparse.ArgumentParser(description="Probe DLNA renderer SOAP readiness and service support")
    parser.add_argument("--wait", type=float, default=4.0, help="SSDP discovery wait in seconds")
    args = parser.parse_args()

    locations = discover_renderer_locations(args.wait)
    print(f"renderer_locations={len(locations)}")
    for location, meta in locations.items():
        print("---")
        print(f"source_ip={meta['source_ip']}")
        print(f"location={location}")
        print(f"server={meta['server']}")
        print(f"st_count={len(meta['sts'])}")
        try:
            description_xml = urllib.request.urlopen(location, timeout=3).read().decode("utf-8", "ignore")
        except Exception as error:
            print(f"description_error={error}")
            continue
        services = parse_renderer_services(description_xml)
        if not services:
            print("description_parse_error=true")
            continue
        print(f"friendly_name={services['friendly_name']}")
        print(f"device_type={services['device_type']}")
        print(f"has_av_transport={bool(services['av_transport'])}")
        print(f"has_rendering_control={bool(services['rendering_control'])}")
        print(f"has_connection_manager={bool(services['connection_manager'])}")
        if services["av_transport"]:
            av_service, av_control = services["av_transport"]
            try:
                elapsed, _payload = call_soap(
                    location,
                    av_service,
                    av_control,
                    "GetTransportInfo",
                    '<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>',
                )
                print(f"soap_get_transport_info_ms={elapsed}")
            except Exception as error:
                print(f"soap_get_transport_info_error={error}")
        if services["rendering_control"]:
            rc_service, rc_control = services["rendering_control"]
            try:
                elapsed, _payload = call_soap(
                    location,
                    rc_service,
                    rc_control,
                    "GetVolume",
                    '<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>',
                )
                print(f"soap_get_volume_ms={elapsed}")
            except Exception as error:
                print(f"soap_get_volume_error={error}")


if __name__ == "__main__":
    main()
