# android-launcher

Prototype für den Android DAP Launcher.

## Funktionen im Starter

- Burger-Menü als Hauptnavigation mit Bibliothek, Podcasts, Settings, angepinnten Einträgen und Apps
- Content-Bereich in vertikaler Listenansicht für kleine DAP-Screens
- Apps-Ansicht als eigener Content-Bereich mit Startaktion pro App
- Vollbild-Sideview-Overlay für rechte Sidebar-Usecases
- Permanenter Player-Bereich am unteren Rand
- Keine Mock-Listeninhalte: Bibliothek-Views erwarten reale Bridge-Daten

## Native Bridges

- `PulseMediaLibraryModule` liefert Bibliotheks-Sektionen, Pins und Podcast-Updates
- `PulseLauncherAppsModule` liefert installierte Apps und Launch-Aktionen
- Wenn native Module fehlen, nutzt der Launcher automatische Fallback-Bridges:
  - Expo Media Library (`expo-media-library`) für Library/Album/Artist/Podcast-Daten
  - AsyncStorage für Pin-Persistenz
  - Android System-Shortcuts (Settings/WLAN/Bluetooth/Storage) in der Apps-Ansicht

## Entwicklung

```bash
npm install
npm run start
```

## Android lokal

```bash
npm run android
```

## APK via EAS

```bash
npm run build:apk
```

Für den APK-Build ist ein Expo-Account nötig (`eas login`) oder ein `EXPO_TOKEN`.
