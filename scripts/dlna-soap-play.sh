#!/usr/bin/env bash
# Send AVTransport Play to a renderer (local test / recovery check).
# Usage:
#   export AV_CONTROL_URL='http://192.168.x.x:port/AVTransport/.../control.xml'
#   bash scripts/dlna-soap-play.sh
set -euo pipefail
URL="${AV_CONTROL_URL:-}"
if [[ -z "$URL" ]]; then
  echo "Set AV_CONTROL_URL to the renderer AVTransport control URL." >&2
  exit 1
fi
BODY='<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>'
curl -sS -X POST "$URL" \
  -H 'Content-Type: text/xml; charset="utf-8"' \
  -H 'SOAPACTION: "urn:schemas-upnp-org:service:AVTransport:1#Play"' \
  --data-binary "$BODY" | head -c 2000
echo
