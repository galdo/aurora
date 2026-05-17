# Aurora Pulse – Flathub Package

This directory contains the Flatpak manifest and metadata for publishing Aurora Pulse on [Flathub](https://flathub.org).

## App ID

```
app.better_craft.aurorapulse
```

## Files

| File | Purpose |
|------|---------|
| `app.better_craft.aurorapulse.yml` | Flatpak build manifest |
| `app.better_craft.aurorapulse.desktop` | Desktop entry file |
| `app.better_craft.aurorapulse.metainfo.xml` | AppStream metadata (store listing) |
| `icons/` | App icons in multiple sizes |

## How it works

1. On each release, the CI updates the manifest in the Flathub repository (`flathub/app.better_craft.aurorapulse`) with the new download URL and SHA256 hash.
2. Flathub's build infrastructure picks up the change and builds the Flatpak.
3. Users can then install/update via `flatpak install flathub app.better_craft.aurorapulse`.

## Local testing

```bash
# Install flatpak-builder if not already installed
sudo apt install flatpak-builder

# Add Flathub remote
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

# Install required runtimes
flatpak install flathub org.freedesktop.Platform//23.08
flatpak install flathub org.freedesktop.Sdk//23.08
flatpak install flathub org.electronjs.Electron2.BaseApp//23.08

# Build locally (replace SHA256 and URL first!)
flatpak-builder --force-clean build-dir app.better_craft.aurorapulse.yml

# Run locally
flatpak-builder --run build-dir app.better_craft.aurorapulse.yml aurora-pulse
```

## Updating for a new release

The `publish-flathub` job in `.github/workflows/release-all.yml` handles this automatically. It:
1. Downloads the Linux tar.gz artifact
2. Calculates the SHA256
3. Updates the manifest URL + hash
4. Updates the metainfo.xml release version
5. Pushes to the Flathub repo