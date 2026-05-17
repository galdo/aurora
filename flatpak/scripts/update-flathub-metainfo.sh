#!/bin/bash
# Script to update the AppStream metainfo.xml with a new release entry.
# Usage: ./update-flathub-metainfo.sh <version> [metainfo-path]

set -euo pipefail

VERSION="${1:?Usage: $0 <version> [metainfo-path]}"
METAINFO="${2:-app.better_craft.aurorapulse.metainfo.xml}"

VERSION_CLEAN="${VERSION#v}"
TODAY=$(date +%Y-%m-%d)

echo "Updating metainfo: ${METAINFO}"
echo "  Version: ${VERSION_CLEAN}"
echo "  Date:    ${TODAY}"

# Update the first <release> tag's version and date
sed -i "s|<release version=\"[^\"]*\" date=\"[^\"]*\"|<release version=\"${VERSION_CLEAN}\" date=\"${TODAY}\"|" "${METAINFO}"

echo "Metainfo updated successfully."