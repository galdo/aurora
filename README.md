# Aurora Pulse

[![checks](https://github.com/galdo/aurora/actions/workflows/checks.yml/badge.svg?branch=main&event=push)](https://github.com/galdo/aurora/actions/workflows/checks.yml)
[![downloads](https://img.shields.io/github/downloads/galdo/aurora/total.svg)]()
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Spenden-orange.svg?style=flat-square&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/better_craft)

Aurora Pulse is a local-first, audiophile-focused desktop player for listeners who want complete control over sound quality, metadata, and library ownership without trading that control for cloud lock-in.

![Aurora Pulse - Main Interface](docs/images/placeholder-main-interface.png)

> **🌐 Project website:** [galdo.github.io/aurora](https://galdo.github.io/aurora/)
>
> A complete walk-through of Aurora Pulse and its Android companion **Vibe – Music & Podcast Launcher** — features, screenshots, downloads, and the privacy story — all in one place.

---

## Install

### macOS

Download the latest `.dmg` from [Releases](https://github.com/galdo/aurora/releases/latest), move `AuroraPulse.app` to `Applications`, and launch from there. If Gatekeeper blocks first launch, open the context menu on the app and choose **Open**.

### Windows

Download the latest `.exe` installer from [Releases](https://github.com/galdo/aurora/releases/latest) and run it. If SmartScreen appears, use **More info** and then **Run anyway**.

### Linux (Flatpak)

Download the `.flatpak` artifact from [Releases](https://github.com/galdo/aurora/releases/latest) and install it with your Flatpak manager or via `flatpak install <file>.flatpak`.

### Android — Vibe Launcher (companion)

The official Android companion is **Vibe – Music & Podcast Launcher**, available on Google Play:

[![Get it on Google Play](GetItOnGooglePlay_Badge_Web_color_English.svg)](https://play.google.com/store/apps/details?id=app.better_craft.vibelauncher)

---

## Platform Support

Aurora Pulse is distributed for macOS (Apple Silicon and Intel), Windows, and Linux via Flatpak builds. Release artifacts are published through GitHub Releases and are intended for direct installation without additional packaging steps.

---

## Privacy and Data Ownership

Aurora Pulse is intentionally local-first in both architecture and operating model. Your library data, playback state, and app-level metadata remain on your system. Optional online lookups are used only in explicit metadata workflows, and the application is not built around analytics profiling or behavioral telemetry.

For the full privacy policy, see [docs/privacy-policy.md](docs/privacy-policy.md) or the project website.

---

## Contributing

Contributions, bug reports, and feature suggestions are welcome via GitHub Issues and Pull Requests.

Repository: <https://github.com/galdo/aurora>

---

## License

Aurora Pulse is released under the [MIT License](./LICENSE).

---

## Disclaimer

Aurora Pulse interacts directly with local file systems and external storage devices. Use the software at your own risk; it is provided “as is” without warranty. Before larger import or synchronization operations, maintain current backups of your media library and related metadata.