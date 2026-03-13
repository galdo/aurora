# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - Unreleased

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
