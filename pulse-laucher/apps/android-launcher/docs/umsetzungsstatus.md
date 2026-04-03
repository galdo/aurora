# Pulse Launcher – Umsetzungsstatus

## Aktueller Stand

- Aurora-Pulse UI-Branding ist umgesetzt (Farbsystem, Topbar, Player-Bar).
- UI-Look wurde modernisiert für kleine Screens:
  - Hero-Kopfbereich mit Kontext-Chips
  - größere Card-Radien, höhere Kontraste, ruhigeres Spacing
  - modernisierte Menü-/Listen- und Player-Flächen im Aurora-Pulse-Stil
- Library-, Album-, Artist-, Playlist-, Podcast-, Settings- und Apps-Ansichten sind angebunden.
- System-/Bridge-Integration ist erweitert:
  - Fallback-Media-Bridge über `expo-media-library` für reale Geräteinhalte ohne native Module
  - Fallback-Pin-Persistenz über AsyncStorage im Aurora-Record-Schema
  - Fallback-App-Launcher mit Android-System-Shortcuts (Settings/WLAN/Bluetooth/Apps/Speicher)
  - Systemstatus-Bridge über `expo-battery`, `expo-network`, `expo-device` (Hero-Chips)
- Apps-Listing und App-Start laufen primär über native Bridge, fallen ansonsten auf System-Shortcuts zurück.
- Pinned-Records laufen im Aurora-nahen Schema:
  - `collection_item_id`
  - `collection_item_type`
  - `order`
  - `pinned_at`
  - `title`
- Pin/Unpin im Content sowie Reorder und Unpin im Pinned-Overlay sind implementiert.
- Podcast-Erkennung nutzt `IS_PODCAST` plus Titel/Album/Artist-Heuristik.
- Legacy-Pin-Migration in der JS-Bridge ist ergänzt:
  - bestehende `pinned_items` werden beim Start in `pinned_records` überführt
  - Reihenfolge wird direkt nach Migration persistiert
- Expo-Android-Buildkonfiguration wurde gehärtet:
  - `expo-build-properties` Plugin in `app.json`
  - `kotlinVersion`, `compileSdkVersion`, `targetSdkVersion` zentral gesetzt

## Verifikation

- `pulse-laucher/apps/android-launcher`
  - `npm run lint` erfolgreich
  - `npm run typecheck` erfolgreich
- Root-Projekt `aurora`
  - `npm run lint` erfolgreich mit bestehender Warning in `src/hooks/use-data-load.tsx`
  - `npm run typecheck` erfolgreich
- Emulator-Test
  - Expo-Metro Start erfolgreich
  - Start über `exp://10.0.2.2:8083` erfolgreich

## Offene Punkte

1. Native Gradle-Buildpfad final verifizieren (`expo run:android` / `gradlew`)  
   Status: `expo prebuild --platform android` schlägt in der aktuellen Umgebung mit `fetch failed` fehl; finaler End-to-End-Lauf steht aus.

2. Vollständige Aurora-Datensynchronisierung auf gemeinsame Datenbasis  
   Status: Teilweise. Bridge nutzt bereits Aurora-nahe Records (u. a. `pinned_records`), aber weiterhin keine direkte gemeinsame Datastore-Instanz zwischen Desktop und Android.

3. Persistenz-Migration alter Pin-Daten  
   Status: umgesetzt in der App-Bridge; ausstehend bleibt nur die serverseitig/native Absicherung als dedizierte Migration im Modul selbst.

## Nächster technischer Schritt

- Mit Expo-Login/Token einen EAS-APK-Build ausführen (`npm run build:apk`) und auf realem Gerät gegen Library/Apps/Pinning testen.
