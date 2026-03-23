# Aurora Pulse

[![checks](https://github.com/galdo/aurora/actions/workflows/checks.yml/badge.svg?branch=main&event=push)](https://github.com/galdo/aurora/actions/workflows/checks.yml)
[![downloads](https://img.shields.io/github/downloads/galdo/aurora/total.svg)]()
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Spenden-orange.svg?style=flat-square&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/better_craft)

Aurora Pulse is a local-first, audiophile-focused desktop player for listeners who want complete control over sound quality, metadata, and library ownership without trading that control for cloud lock-in.

![Aurora Pulse - Main Interface](docs/images/placeholder-main-interface.png)

---

## Why Aurora Pulse

Aurora Pulse is built around a simple idea: your music library should stay yours, your playback chain should remain transparent, and your day-to-day listening should feel fast instead of fragile. The application keeps local playback and local data ownership at the center while exposing the quality details that matter in serious listening scenarios, including file and stream characteristics directly in the player context.

The project is developed for long-lived collections and real-world usage patterns. That means practical import workflows, reliable metadata handling, stable sync behavior, and UI decisions that reduce context switching when you move between browsing, queuing, and playback control.

---

## Feature Overview

### Playback and Audio Quality

Playback in Aurora Pulse is designed to be immediate and confidence-oriented. Transport controls, queue handling, and player state all prioritize responsiveness, while quality information remains visible so there is no ambiguity about what is actually being played. Recent iterations also improved remote playback reconciliation to keep local UI state and remote renderer state more closely aligned during transitions.

![Aurora Pulse - Playback](docs/images/placeholder-playback.png)

### Equalizer and Sound Tuning

Aurora Pulse includes a practical tuning workflow that combines multi-band equalization, AutoEQ profile support, and headroom compensation. The goal is not just flexibility, but repeatability: you can make broad tonal adjustments quickly and still keep enough structure to reproduce your preferred profile consistently across sessions.

![Aurora Pulse - Equalizer](docs/images/placeholder-equalizer.png)

### Library Management

Library management is optimized for local folder structures and larger collections. Albums, artists, tracks, and playlists are connected through one coherent navigation model, while sideview-based detail access and direct playback from search results keep common tasks short and predictable. Metadata edits for albums and tracks are integrated into that same flow so curation does not feel like a separate tool.

![Aurora Pulse - Library](docs/images/placeholder-library.png)

### Playlists and Collections

Playlist support covers both explicit manual curation and smart collection logic. Artwork generation and sorting behavior have been improved to stay robust even in mixed or generated collections, which makes playlists viable both for everyday listening and for structured thematic cataloging.

![Aurora Pulse - Playlists](docs/images/placeholder-playlists.png)

### DAP Sync

DAP sync extends your local workflow to portable devices with a focus on operational stability. Progress tracking, ETA, resume, and cancellation are available as first-class controls, and the sync engine has been hardened for reconnect, restart, and interruption scenarios that happen in real device usage.

![Aurora Pulse - DAP Sync](docs/images/placeholder-dap-sync.png)

### Podcasts

Podcasts are integrated into the same environment as your music library, including discovery, subscription management, and RSS-driven refresh. This keeps spoken content and music under one playback model, so you can switch context without leaving the app’s core workflow.

![Aurora Pulse - Podcasts](docs/images/placeholder-podcasts.png)

### CD Import

CD import is oriented toward archival quality and practical cleanup reduction. The workflow emphasizes FLAC-centric outcomes, metadata-aware import decisions, and predictable cover handling, so your imported releases require less post-processing in your library.

![Aurora Pulse - CD Import](docs/images/placeholder-cd-import.png)

### DLNA / Remote Playback

The DLNA stack has been significantly expanded to support remote playback scenarios with higher reliability. Command sequencing is serialized per renderer to reduce race conditions, transition handling between tracks is more robust, metadata compatibility has been improved for stricter renderer implementations, and bidirectional synchronization continues to evolve so player and renderer remain in sync during remote control operations.

---

## UI Philosophy

Aurora Pulse follows a continuity-first UI model. Instead of forcing full-page context shifts for every detail, the interface keeps actions and information close to the active listening flow. The intent is to reduce interaction latency, preserve orientation while navigating deep libraries, and make frequent actions feel direct on both desktop and connected playback scenarios.

![Aurora Pulse - UI Workflow](docs/images/placeholder-ui-workflow.png)

---

## Platform Support

Aurora Pulse is distributed for macOS (Apple Silicon and Intel), Windows, and Linux via Flatpak builds. Release artifacts are published through GitHub Releases and are intended for direct installation without additional packaging steps.

---

## Privacy and Data Ownership

Aurora Pulse is intentionally local-first in both architecture and operating model. Your library data, playback state, and app-level metadata remain on your system. Optional online lookups are used only in explicit metadata workflows, and the application is not built around analytics profiling or behavioral telemetry.

---

## Development Status

Aurora Pulse is in active development with a strong focus on audio confidence, sync resilience, and operational reliability in larger collections. Recent releases include substantial DLNA hardening work, expanded remote synchronization behavior, stronger DAP sync stability, and broader consistency improvements across the app shell.

If you want a visual product-style overview, see the landing page at [docs/landing_page/index.html](docs/landing_page/index.html).

---

## Install

### macOS

Download the latest `.dmg` from Releases, move `AuroraPulse.app` to `Applications`, and launch from there. If Gatekeeper blocks first launch, open the context menu on the app and choose **Open**.

### Windows

Download the latest `.exe` installer from Releases and run it. If SmartScreen appears, use **More info** and then **Run anyway**.

### Linux (Flatpak)

Download the `.flatpak` artifact from Releases and install it with your Flatpak manager or via `flatpak install <file>.flatpak`.

---

## Contributing

Contributions, bug reports, and feature suggestions are welcome via GitHub Issues and Pull Requests.

Repository: https://github.com/galdo/aurora

---

## License

Aurora Pulse is released under the [MIT License](./LICENSE).

---

## Disclaimer

Aurora Pulse interacts directly with local file systems and external storage devices. Use the software at your own risk; it is provided “as is” without warranty. Before larger import or synchronization operations, maintain current backups of your media library and related metadata.
