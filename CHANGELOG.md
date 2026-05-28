# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.7-beta1] - 2026-05-28

Hotfix-Beta for #62 — slow startup on legacy / lossy-format libraries.

### Fixed
- **Library sync fast-path now triggers reliably for all formats and legacy databases** (#62). The Phase-3 in-memory fast-path used to require the persisted track row to carry at least one `audio_*` extra (sample rate, bit depth, codec, …) before it would skip a re-parse. That gate had two side-effects we hadn't anticipated:
  1. Libraries first imported before the `audio_codec` / `audio_file_type` fields existed (early 1.5.x and earlier) never qualified — every startup re-parsed every file from disk, even when `mtime + size` already proved nothing had changed.
  2. The same gate accidentally penalized lossy formats (MP3, AAC, Opus, …) on user setups where the audio details had simply never been back-filled.
  Combined with a slow USB drive that's exactly the ~5-minute startup the issue describes. The fast-path now relies solely on `mtime + size + known album grouping`, which is structurally sufficient: if a file on disk is byte-for-byte identical to what we last indexed, none of the `audio_*` extras can have changed either. The full re-scan still kicks in for genuinely new or modified files.

### Diagnostics
- **Sync profiling summary now ships in production logs.** `[Aurora] library sync done in <ms> ms — files=…, fastPathHits=… (xx %), inMemoryHits=…, regroupFallbacks=…, probeMap=… entries (built in … ms), metadataReadMs=…` is emitted via `console.info` after every sync. This makes it possible to triage performance regressions from a user log without having to ask them to start Aurora with `DEBUG=…` flags. The detailed per-phase breakdown remains available via `debug(aurora:provider:media_local:*)` for engineering.

## [1.5.6] - 2026-05-21

Stable release consolidating the 1.5.6-beta1 … 1.5.6-beta6 series.

### Performance
- **Library sync drastically faster** through a 5-phase optimization track:
  - Phase 1: content-hash cover deduplication so identical artwork is processed only once
  - Phase 2: DB hot-path memoization + new SQLite indexes for track/album/artist lookups
  - Phase 3: smart re-scan via in-memory probe map (skips unchanged files instead of re-reading tags)
  - Phase 4: Sharp worker-pool for parallel image resizing + short-hash cache key + bounded queue concurrency
  - Phase 5: polling-loops eliminated, post-processing parallelized
- **Startup performance**: Renderer phase ~50–80 % faster (Splash → UI in ~323 ms vs. 600–1500 ms before). Login-shell PATH resolution is now async and non-blocking (saves up to 4 s on slow shell init). Background services (`Equalizer`, `DLNA`, `BitPerfect`, `Update`) are deferred via `requestIdleCallback`.
- **Auto-updater** initialization is delayed 5 s after the main window is shown so the first update check never blocks the critical path.

### Added
- **Library auto-sync on startup is now opt-in** with a clear toggle in Settings — users can choose to load only the indexed library on launch and trigger sync manually for noticeably faster cold starts.
- **Sync state can be reset** from the DAP-Sync settings (e.g. after reformatting the SD card), forcing all files to be re-transferred on the next sync.
- **DAP Sync ADB transport** with diagnostic error messages for missing adb, unauthorized device, multiple devices, timeouts, etc. Bundled adb binary is used as fallback.
- **DAP Sync mirror-host-folder-layout** option: when active, files under `Music/` mirror the exact folder/file names of your local library; when off, Aurora builds Artist/Album/… paths from metadata.
- **Audio-CD import** flow with Discogs metadata lookup, Discogs Dev-Key configuration, naming-template editor, FLAC export, and cached metadata reuse for already-recognized discs.
- **Bit-Perfect output** with technical-diagnostics block (binary path, process ID, backend) and runtime status indicator.
- **DLNA / UPnP Media Server**: Aurora now publishes the local library on the network via SSDP-discovery as a UPnP MediaServer (DMS). Diagnostic block exposes Description URL, Content URL, Stream URL and bound IP addresses.
- **Album-cover-from-folder** modal: pick any image from an album's folder and embed it into all tracks of that album in one go.
- **Cover-embed for FLAC** via new `scripts/embed-folder-covers-flac.sh`.
- **Top-menu-bar sort store**: persistent sort selection across sessions and views (artists, albums, playlists).
- **macOS Media Keys** section in Settings (macOS only) showing whether system Play/Pause/Next shortcuts are registered and whether Aurora has the Accessibility permission. Includes a deep-link button to "System Settings → Accessibility".
- **Aurora Pulse Launcher (Android)** info section in Settings introduces the dedicated Android companion launcher (built for DAPs and music/podcast lovers): focused home screen with Now Playing, cover wall for albums/artists/playlists/podcasts, DAP-sync compatibility (including SD-card folders), built-in podcast player, customizable widgets/themes/wallpapers (portrait + landscape), focus mode, fully offline, no tracking.
- **Updates panel**: auto-update toggle, beta-channel toggle, manual "Check / Download / Install" buttons; live status (`checking / available / downloading / downloaded / installing / error`) with download-progress percentage.
- **What's New** card in the info column showing release notes inline with a "Mark read" button.
- **DAP Sync progress UI**: status pill (`idle / planning / copying / cleaning / done / aborted / error`), progress bar with percentage, counters for Checked / Copied / Unchanged / Deleted, ETA, and resume hint after an interrupted sync.
- **Settings localization**: 29 new translation keys (DAP progress meta, sync reset, DLNA UPnP description, logo alt text, full Pulse-Launcher feature list, community thanks block) across all 12 supported locales.
- **GitHub Pages landing site** redesigned around the V-Music palette, with Aurora Green for the desktop identity, Buy-Me-A-Coffee CTA, official Google Play badge, GDPR privacy-policy page, and Google Analytics opt-in.
- **Flathub manifest** + tar.gz build target for Linux distribution.

### Changed
- **Settings → Info column** completely rewritten: replaces the historical fork/AI-process narrative with a community-thanks block and an Aurora-Pulse-Launcher companion section tailored for DAP users. Logo and version still anchor the bottom of the column.
- **Auto-sync toggle** in Settings is now a switch pill (was a checkbox), matching the rest of the settings UI.
- **Update channel handling** uses a custom GitHub Releases lookup that bypasses the electron-updater channel bug, so stable installs reliably see new betas when the beta channel is enabled.
- **macOS auto-update path** for ad-hoc-signed builds: Aurora now applies its own update flow when no developer identity is present, instead of silently failing.
- **Service initialization** in the renderer is split into a critical path (`ThemeService`, `I18nService`) and deferred background services, each wrapped in its own try/catch so a single failing service can't block the rest.
- **Sidebar / browser header** drag-region rules tightened so the burger menu is no longer eaten by the title-bar drag area on Windows/Linux, and window controls hide in fullscreen as per the design spec.

### Fixed
- **Player cover** now always shows the *track's own embedded artwork* and falls back to the album cover only if the track has none. Previously, mosaic/collage covers from playlist-as-hidden-album collections leaked into the player.
- **DLNA position sync** with the Aurora Pulse Launcher (Vibe) was unreliable due to parallel SOAP snapshot calls — those are now serialized.
- **Album edit modal** scrolls smoothly and no longer "snaps back" when clearing the genre field; the cleared value is now persisted correctly.
- **Updater channel bug**: stable channel no longer skips beta releases when the user has opted into the beta channel.
- **Hidden-album playlist covers** are regenerated correctly even when only one or two distinct track covers are available (previous logic could leave the playlist without any cover).

## [1.5.6-beta1] - 2026-05-16

### Performance
- Startup-Geschwindigkeit deutlich verbessert: gemessene Verbesserung in der Renderer-Phase ~50–80 % (Splash → UI in 323 ms gegenüber zuvor 600–1500 ms)
- Login-Shell-PATH-Resolution erfolgt nicht mehr blockierend im Main-Konstruktor, sondern asynchron nach Anzeige des Splash-Fensters (Ersparnis bis 4 s je nach Shell-Init)
- Service-Initialisierung im Renderer aufgeteilt in Critical-Path (`ThemeService`, `I18nService`) und Background (`EqualizerService`, `DlnaService`, `BitPerfectService`, `UpdateService`); Background-Services werden über `requestIdleCallback` deferred ausgeführt
- Splash-Fenster wird jetzt vor `installExtensions` erstellt, sodass User sofort visuelles Feedback erhalten
- Auto-Updater-Initialisierung erst 5 s nach Hauptfenster-Anzeige, damit der initiale Update-Check keine kritische Phase blockiert

### Added
- Lightweight Startup-Performance-Marker `[STARTUP_MARK]` (Main) und `[STARTUP_MARK_RENDERER]` (Renderer) zur Diagnose; deaktivierbar via `AURORA_STARTUP_MARKS=0`
- `enrichProcessPathFast()` für synchrone Wellknown-Path-Anreicherung (sub-millisecond)
- `enrichProcessPathFromLoginShellAsync()` mit 4 s Timeout für asynchrone Login-Shell-PATH-Auflösung
- Globaler Renderer-Helper `window.auroraStartupMark` zur prozessübergreifenden Korrelation von Startup-Phasen

### Changed
- Background-Services im Renderer in einzelne `try/catch`-Blöcke gewrappt, damit ein fehlerhafter Service den Rest nicht mehr verhindert
- `registerAutoUpdater()` aus dem Hot-Path von `createWindow()` entfernt und in einen deferred Timer im `showMainWindow`-Callback verschoben

## [1.5.5] - 2026-05-06

### Fixed
- Burger menu (hamburger icon) on Windows and Linux no longer blocked by the window drag region — clicks are now properly received
- Window controls (Minimize, Maximize, Close) are now hidden in fullscreen mode on Windows and Linux as per design rules — they only appear in windowed mode

### Added
- `PlatformOS.Linux` enum value for explicit Linux platform detection
- `UIFullScreenChanged` IPC channel for communicating fullscreen state to the renderer process

### Changed
- Sidebar header drag region moved from global `app-window-drag` class to CSS-only with explicit `z-index` elevation for child interactive elements
- Browser header dynamically removes Windows-specific padding and title bar overlay styling when entering fullscreen

## [1.5.1-beta3] - 2026-03-19

### Added
- DLNA-Befehls-Serialisierung pro Renderer zur Vermeidung konkurrierender SOAP-Kommandos
- Adaptive Remote-State-Abfrage mit schneller Startphase und ruhigerem Steady-State
- Renderer-spezifische DSD-MIME-Profile mit `audio/x-dsd`-Fallback für sensible Stacks

### Changed
- Safe-Skip-Ablauf auf explizites Stoppen mit kurzem Settling-Fenster vor `SetAVTransportURI`/`Play` umgestellt
- Lautstärke-, Seek-, Pause-, Resume-, Stop- und Next-Befehle in eine sequenzierte DLNA-Kommando-Pipeline überführt
- DSD-ProtocolInfo um `audio/x-dsd` erweitert

### Fixed
- Race-Conditions bei schnellen Skip-/Pause-/Resume-Folgen gegenüber DLNA-Renderern reduziert
- Zustandssprünge während `TRANSITIONING` durch geordnete Befehlsausführung deutlich entschärft
- Remote-Playback-Sync reagiert in der Track-Startphase schneller auf reale Renderer-Zustände

## [1.5.1-beta2] - 2026-03-19

### Added
- DAP-Sync-Planungsphase mit laufendem Fortschritt statt statischem 0/0-Status

### Changed
- DAP-Sync-Planungsvalidierung parallelisiert und auf kontrollierte Last begrenzt
- Persistenz von DAP-Checkpoint/State während Sync gedrosselt, um UI-Last zu reduzieren
- DAP-Copy/Cleaning-Fortschritt zeitlich und nach Schrittzahl gebündelt aktualisiert
- Auto-DAP-Resume während aktivem Bibliotheks-Sync unterdrückt
- Sidebar-Branding (Logo/Text/Loader) visuell an Splash-Proportionen und Position angepasst
- DLNA-Logausgabe auf relevante Kernereignisse reduziert

### Fixed
- DAP-Abbruch reagiert auch in laufenden Hash- und Dateivergleichsphasen zuverlässig
- DAP-Sync kann nach Geräte-Trennung sauber abbrechen und Status zurücksetzen
- Topbar-Sync stört laufenden Initial-Sync nicht mehr durch konkurrierende Trigger
- Player-Layout bleibt beim ersten Start ohne geladenen Track vollständig stabil

### Included from 1.5.0 → 1.5.1-beta1
- DLNA-Steuerpfad für Play/Pause/Resume/Stop inkl. Next-Track-Synchronisierung gehärtet
- Dashboard-Toplisten in paginierte Top Songs/Top Albums-Sichten umgebaut
- Cover-/Metadatenlieferung für Renderer robuster gemacht
- DAP- und Podcast-Sync-Grundlagen für Resume, Fortschritt und Bereinigung erweitert

## [1.5.1-beta1] - 2026-03-17

### Changed
- Prerelease-Basis für 1.5.1 mit Fokus auf DLNA-Härtung, Dashboard-Verhalten und Sync-Resilienz

## [1.5.0] - 2026-03-17

### Changed
- Start der Entwicklung für Version 1.5.0

## [1.4.0] - 2026-03-11

### Added
- Equalizer-Seite mit mehrbandiger Regelung, Headroom-Kompensation und Reset
- Podcast-Bereich mit Discovery-Flow, Abo-Verwaltung und Sideview-Details
- DAP-Sync-Unterstützung für Podcast-Episoden im Zielordner `Podcasts`
- Album-Header-Aktionen in der Topbar mit Repeat- und mehrstufigem Shuffle-Verhalten
- Verbesserte Playlist-/Cover-Generierung für Sammlungen und konvertierte Album-Playlists

### Changed
- Topbar-Layout neu geordnet: Umschalter direkt neben Suche, Sortierung/Zoom in den rechten Actions-Bereich
- Kontextbezogene Plus-Aktion im Header für Playlists und Podcasts direkt links neben Global Shuffle
- Podcasts-Titel aus der Topbar entfernt und als große grüne Seitenüberschrift im Content-Bereich dargestellt
- Player-Interaktionen überarbeitet: Like-Button neben Queue/Volume positioniert und Größen vereinheitlicht
- Playlist-Collagen stabilisiert: Regeneration nur einmal pro App-Session statt bei jedem Ansichtswechsel
- Build-Metadaten für macOS erweitert, um App-Name konsistent als „Aurora Pulse“ anzuzeigen

### Fixed
- M3U/M3U8/M3U8-DAP-Exporte sind auch für aus Alben erzeugte (versteckte) Playlists verfügbar
- Numerische Track-Sortierung für aus Alben erzeugte Playlists korrigiert
- Robusteres Cover-Clustering für Hidden-Album-Playlists verhindert fehlerhafte Einzelcover-Fälle
- Medien-Session-Steuerung auf macOS stabilisiert (Verhalten der Hardware-Tasten verbessert)

## [1.3.2] - 2026-03-10

### Added
- "Global Shuffle"-Button in der Topbar zum zufälligen Abspielen aller Titel
- CD-Import: Fortschrittsbalken und grüne Haken für bereits importierte Tracks
- CD-Import/Edit: Cover-Bilder werden beim Speichern in FLAC-Dateien auf max. 400x400 skaliert geschrieben

### Changed
- Settings: Info-Texte zum Aurora-Pulse-Fork in DE/EN auf sachliche, ausführliche Beschreibung umgestellt
- Settings: Layout so angepasst, dass nur die linke Spalte scrollt und die Info-Spalte fest bleibt
- Settings: Hintergrundlogo in der Info-Spalte als sichtbare Gravur verstärkt

### Fixed
- Metadaten-Änderungen (Künstler, Album, Titel, Jahr, Genre) werden jetzt permanent in FLAC- und MP3-Dateien gespeichert
- Album-Ansicht: Künstlername wird wieder grün, kleiner und unter dem Titel dargestellt
- Lokalisierung der Info-Texte in den Einstellungen (inkl. DAP Sync) vervollständigt
- DAP-Sync: Zielpfad im Fortschrittsstatus verwendet konsistent den konfigurierten Ordner
- DAP-Sync: Legacy-Podcastdateien im alten Musikpfad werden beim Sync bereinigt
- Bibliothek: Alben mit leerem oder „Unknown Artist“-Artist werden automatisch repariert
- repair_db.js: ESLint-Verstöße bereinigt (u. a. arrow-parens, unused-vars, underscore-dangle)

## [1.3.1] - 2026-03-09

### Changed
- Sidebar-Breite für kleine Fenster robuster gemacht, damit Menüpunkte vollständig sichtbar bleiben
- Album-Darstellung für Titel/Künstler korrigiert und Artist-Zeile wieder klar unter dem Titel platziert
- Einstellungen überarbeitet: „Zusammenstellungen gruppieren“ nach „Ansicht und Oberfläche“ verschoben
- Info-Spalte in den Einstellungen mit großem, dezentem Logo im Hintergrund versehen
- Info-Links in den Einstellungen auf reguläre Textgröße und grüne Hervorhebung angepasst
- Versionsstände auf 1.3.1 angehoben

### Fixed
- Wechsel zwischen Musik- und Podcast-Wiedergabe stoppt die jeweils andere Quelle sofort
- Player zeigt bei Podcast-Wiedergabe jetzt den korrekten Inhalt und Fortschritt an
- „Problem melden“-Link auf das gewünschte Repository aktualisiert

## [1.3.0] - 2026-03-09

### Added
- Podcasts-Seite mit Sidebar-Eintrag, Header und visuellem New-Episodes-Indikator
- Podcast-Discovery-Modal mit Suche, Filtern und Direkt-Abonnement
- Podcast-Service für Abonnements, RSS-Episode-Refresh und lokale Persistenz
- DAP-Sync für Podcast-Episoden in den Zielordner `Podcasts`
- Neue i18n-Keys für Podcast-UI in allen unterstützten Sprachen
- Album-Header-Steuerung mit Repeat-Umschaltung und 3-stufigem Shuffle-Modus (Aus/Album/Alles)
- Automatische Künstlerbilder-Suche mit Fallback auf bestehende Platzhalter
- Automatische Cover-Generierung für Smart-Playlists aus enthaltenen Album-/Track-Covern

### Changed
- Routing um dedizierte Podcasts-Route und Header-Slot erweitert
- Media-Library-Sync um Podcast-Synchronisierung nach dem Musik-Sync ergänzt
- Services-Exportliste um PodcastService erweitert
- Topbar in der Album-Ansicht um kontextbezogene Header-Aktionen erweitert
- Settings: Option „Ordner als Alben behandeln“ auf Ein/Aus-Toggle im gleichen Stil wie „Künstler ausblenden“ umgestellt
- README für Version 1.3 vollständig überarbeitet (Funktionsumfang, Nutzen, Bereichsbeschreibungen, Bildplatzhalter)

### Fixed
- Typisierung und URL/Dateiendungsbehandlung im Podcast-Service stabilisiert
- Lint- und Typecheck-Fehler in neu hinzugefügten Podcast-Dateien behoben
- Hook-Reihenfolge in der Topbar-Suche auf der Settings-Seite korrigiert

## [1.2.0] - 2026-03-09

### Added
- Topbar-Suche mit Live-Ergebnissen und direktem Abspielen aus der Trefferliste
- Album-Sideview mit Overlay, Schnellaktionen und aktualisiertem Detailbereich
- Playlist-Wizard für manuelle und Smart-Playlist-Erstellung
- Track- und Album-Bearbeitungsdialoge inkl. aktualisierter UI-Flows
- DAP-Sync-Bedienung in den Einstellungen mit Fortschritt, ETA, Fortsetzen und Abbrechen
- Theme-Modus (Light, Dark, Auto) und erweiterte Sprachunterstützung

### Changed
- Navigation, Header und Sidebar visuell überarbeitet
- Library-, Album-, Playlist- und Track-Komponenten modernisiert
- Routing und Header-Slots für neue Aktionen erweitert
- Datenfluss in Services/Reducer für konsistentere UI-Updates angepasst
- IPC-, Device- und Datastore-Module für neue Sync- und Geräteprozesse erweitert

### Fixed
- Album-Ansicht und Sidebar aktualisieren Metadaten nach Bearbeitung konsistent
- DAP-Sync überspringt problematische Dateien (z. B. ENAMETOOLONG) ohne Abbruch
- Stabilere Aktualisierung von Collections, Tracks und Playlists nach Sync-Vorgängen

## [1.0.0] - TBD

Initial Release
