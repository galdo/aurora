# Aurora Pulse

[![checks](https://github.com/galdo/aurora/actions/workflows/checks.yml/badge.svg?branch=main&event=push)](https://github.com/galdo/aurora/actions/workflows/checks.yml)
[![downloads](https://img.shields.io/github/downloads/galdo/aurora/total.svg)]()
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Spenden-orange.svg?style=flat-square&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/better_craft)

Aurora Pulse is a local-first, audiophile-focused desktop player for listeners who want complete control over sound quality, metadata, and library ownership without trading that control for cloud lock-in.

![Aurora Pulse - Main Interface](docs/images/placeholder-main-interface.png)

---

## What’s new since 1.5.0

**1.5.x** doubles down on *where* you listen and *how* reliably your library follows you. On the desktop, **DAP sync over ADB** lets you push music and podcasts to a USB-connected Android player without mounting it as a disk—complete with SD-first storage discovery and shell-safe paths for real-world filenames (spaces, parentheses, and more). Prefer your PC folder tree on the device? Toggle **mirror host folder layout** and keep your library structure 1:1 under `Music/`, or fall back to classic tag-based layout.

Large sync sessions stay honest: **planning → copying → cleaning** progress is clearer, remote cleanup **streams** file listings so huge libraries don’t stall at the finish line, and **DLNA / remote playback** keeps getting smarter—tighter queue handling, calmer transitions, and renderer state that stays glued to what you hear.

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

### DAP Sync

DAP sync extends your local workflow to portable players with **filesystem** or **ADB (USB)** transport. Copy with progress, ETA, resume, and cancellation as first-class controls—built for the messy reality of cables, reconnects, and interrupted sessions. **ADB** mode targets Android-class devices: automatic writable storage resolution, optional **mirror your desktop library folder layout**, and a cleaning phase designed for very large libraries without choking the UI. **Filesystem** mode remains ideal when your player mounts as a drive.

![Aurora Pulse - DAP Sync](docs/images/placeholder-dap-sync.png)

### Podcasts

Podcasts are integrated into the same environment as your music library, including discovery, subscription management, and RSS-driven refresh. This keeps spoken content and music under one playback model, so you can switch context without leaving the app’s core workflow.

![Aurora Pulse - Podcasts](docs/images/placeholder-podcasts.png)

### CD Import

CD import is oriented toward archival quality and practical cleanup reduction. The workflow emphasizes FLAC-centric outcomes, metadata-aware import decisions, and predictable cover handling, so your imported releases require less post-processing in your library.

![Aurora Pulse - CD Import](docs/images/placeholder-cd-import.png)

### DLNA / Remote Playback

The DLNA stack is built for **living-room and companion devices**—not just “it plays,” but *it stays in sync*. Command sequencing is serialized per renderer to reduce race conditions, track-to-track transitions are handled with care, and metadata compatibility keeps improving for picky renderers. The player and the renderer are continuously reconciled so your on-screen queue, transport state, and what’s actually playing tell the same story.

---

## Aurora Pulse × Aurora Pulse Launcher — the power duo

**The desktop is your mission control. Your phone is the encore.**

[Aurora Pulse Launcher](./pulse-laucher/README.md) is the Android experience built for the same philosophy as Aurora Pulse: *your* library, *your* rhythm, without renting your habits back from a cloud. Pair it with Aurora Pulse on macOS, Windows, or Linux and you get a deliberate **two-screen story**: curate, sync, and drive playback from the big screen; slip the same world into your pocket when you walk away.

On the **DLNA** side, Aurora Pulse is tuned for queue-aware, launcher-friendly remote playback—so handoffs between the desktop player and a dedicated Android listening surface feel intentional, not accidental. Together, they’re not two random apps with a logo in common; they’re **one ecosystem** split across the desk and the commute.

**Want in early?** The Launcher is under active development; rough edges are part of the ride, and your feedback steers the roadmap. Apply for the **beta program** and help shape the Android side of Aurora:

**→ [Aurora Pulse Launcher — Beta tester application](https://forms.gle/KBymYocF7hieTFJZ7)**

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

Aurora Pulse is in active development with a strong focus on audio confidence, sync resilience, and operational reliability in larger collections. The **1.5** generation emphasizes **ADB DAP sync**, **mirror-folder workflows**, **streaming-safe device cleanup**, and **DLNA / remote playback** refinements—including paths that play nicely with **Aurora Pulse Launcher** on Android. Expect the desktop and mobile stories to keep converging: one library, two surfaces, zero lock-in.

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
