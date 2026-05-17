#!/bin/bash
# Script to update the Flathub manifest with a new release version and SHA256.
# Usage: ./update-flathub-manifest.sh <version> <sha256> [manifest-path]
#
# This script is intended to be called from CI (GitHub Actions) after a Linux
# tar.gz artifact has been built and its SHA256 computed.

set -euo pipefail

VERSION="${1:?Usage: $0 <version> <sha256> [manifest-path]}"
SHA256="${2:?Usage: $0 <version> <sha256> [manifest-path]}"
MANIFEST="${3:-app.better_craft.aurorapulse.yml}"

VERSION_CLEAN="${VERSION#v}"  # strip leading 'v' if present

echo "Updating Flathub manifest: ${MANIFEST}"
echo "  Version: ${VERSION_CLEAN}"
echo "  SHA256:  ${SHA256}"

# Update the archive URL
sed -i "s|url:.*github.com/galdo/aurora/releases/download/.*|url: https://github.com/galdo/aurora/releases/download/v${VERSION_CLEAN}/Aurora-Pulse-${VERSION_CLEAN}-linux-x64.tar.gz|" "${MANIFEST}"

# Update the SHA256
sed -i "s|sha256:.*|sha256: ${SHA256}|" "${MANIFEST}"

echo "Manifest updated successfully."