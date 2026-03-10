# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-03-10

### Added
- "Global Shuffle"-Button in der Topbar zum zufälligen Abspielen aller Titel
- CD-Import: Fortschrittsbalken und grüne Haken für bereits importierte Tracks
- CD-Import/Edit: Cover-Bilder werden beim Speichern in FLAC-Dateien auf max. 400x400 skaliert geschrieben

### Fixed
- Metadaten-Änderungen (Künstler, Album, Titel, Jahr, Genre) werden jetzt permanent in FLAC- und MP3-Dateien gespeichert
- Album-Ansicht: Künstlername wird wieder grün, kleiner und unter dem Titel dargestellt
- Lokalisierung der Info-Texte in den Einstellungen (inkl. DAP Sync) vervollständigt

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
