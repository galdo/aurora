import socket
import time

MCAST_GROUP = "239.255.255.250"
MCAST_PORT = 1900

SEARCH_TARGETS = [
    "ssdp:all",
    "urn:schemas-upnp-org:device:MediaRenderer:1",
    "urn:schemas-upnp-org:service:AVTransport:1",
    "urn:schemas-upnp-org:service:RenderingControl:1",
]


def parse_headers(payload: str) -> dict:
    headers = {}
    lines = [line.strip() for line in payload.replace("\r", "").split("\n") if line.strip()]
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(2.2)

    responses = []
    for search_target in SEARCH_TARGETS:
        request = (
            "M-SEARCH * HTTP/1.1\r\n"
            f"HOST: {MCAST_GROUP}:{MCAST_PORT}\r\n"
            "MAN: \"ssdp:discover\"\r\n"
            "MX: 2\r\n"
            f"ST: {search_target}\r\n\r\n"
        )
        sock.sendto(request.encode("utf-8"), (MCAST_GROUP, MCAST_PORT))
        deadline = time.time() + 3.0
        while time.time() < deadline:
            try:
                data, address = sock.recvfrom(65535)
            except Exception:
                break
            responses.append((search_target, address[0], data.decode("utf-8", "ignore")))

    print(f"TOTAL_RESPONSES={len(responses)}")
    dedupe = set()
    for requested_st, source_ip, raw_payload in responses:
        headers = parse_headers(raw_payload)
        usn = headers.get("usn", "")
        location = headers.get("location", "")
        response_st = headers.get("st", "")
        server = headers.get("server", "")
        dedupe_key = (source_ip, usn, location, response_st)
        if dedupe_key in dedupe:
            continue
        dedupe.add(dedupe_key)
        print("---")
        print(f"requested_st={requested_st}")
        print(f"source_ip={source_ip}")
        print(f"response_st={response_st}")
        print(f"usn={usn}")
        print(f"server={server}")
        print(f"location={location}")


if __name__ == "__main__":
    main()
