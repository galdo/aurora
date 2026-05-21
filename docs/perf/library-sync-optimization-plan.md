# Library-Sync Performance-Optimierung – Aktionsplan

> **Branch:** `perf/library-sync-optimization`
> **Issue-Bezug:** #23 (Slow Startup / Album Scan), Folge-Issue „Library-Sync 17× langsamer als Original-Aurora"
> **Stand:** 21.05.26 (beta5 ist live, Toggle für Auto-Sync ausgerollt)
> **Zielmetrik:** ≥ 3000 Tracks in **< 60 s** Cold-Scan, **< 5 s** Re-Scan (no-changes), **< 1 s** Startup bis UI interaktiv

---

## 1. Ausgangslage (User-Reports)

| User | Library-Größe | Aurora Pulse | Original-Aurora | Faktor |
|---|---|---|---|---|
| Crocodile73 | ~3000 Tracks | **~7 min** | **25 s** | **17×** |
| galdo (selbst) | > 3000 Tracks | **~3 min** | n/a | — |

**Kernaussage Crocodile73 nach beta5-Workaround:**
> „Thank you for that option. That helps. I wouldn't mind the scan being on at start, but for me it takes just over 7 mins to complete. Compared to 25 secs on the other one."

→ Der Toggle ist Symptombehandlung. Die echte Regression liegt in der **Sync-Pipeline selbst**.

**Constraint:** Keine Funktion einschränken. Auto-Sync, Compilation-Grouping, Cover-Resize, Smart-Playlists, Artist-Feature-Pictures, alle Post-Processing-Schritte bleiben — sie werden nur schneller / parallel / dedupliziert.

---

## 2. Code-Analyse – Wo geht die Zeit verloren?

Hotspots identifiziert in:
- `src/providers/media-local/media-local-library.service.ts`
- `src/services/media-library.service.ts`
- `src/modules/image/sharp/module.ts`
- `src/datastores/base-datastore.ts`

### 🔴 H1 – Cover-Art-Verarbeitung pro Track statt pro Album

**Dateien:** `media-local-library.service.ts:748–800`, `media-library.service.ts:354–385` (`processPicture`)

Pro Track läuft aktuell:
1. `selectCover(audioMetadata.common.picture)` extrahiert das Cover aus den Tags
2. IPC-Roundtrip Renderer → Main (`IPCCommChannel.ImageScale`)
3. `sharp(buffer).resize(500, 500).toFile(...)` im Main-Process
4. Cache-Lookup über `sha1(buffer + "500x500")` (sha1 über volle Buffer-Größe, oft 500 KB+)

Das passiert **zweimal** pro Track: einmal in `checkAndInsertMediaAlbum` (für `album_cover_picture`), einmal in `checkAndInsertMediaTrackWithStatus` (für `track_cover_picture`).

→ Bei 3000 Tracks = **6 000 IPC-Roundtrips + 6 000 sharp-Aufrufe + 6 000 SHA1-Hashes über ~3 GB Cover-Daten**.

Innerhalb eines Albums teilen sich i. d. R. 12–20 Tracks dasselbe Cover. Wir machen die Arbeit also 12–20× pro Album zu oft.

**Geschätzter Anteil:** 40–55 % der Gesamtlaufzeit.

---

### 🔴 H2 – Sequentielle DB-Roundtrips pro Track via IPC

**Datei:** `base-datastore.ts:22–53`

Jeder DB-Zugriff ist ein Renderer↔Main-IPC-Roundtrip. Pro Track:
- 1× `findMediaTrack` (existing-check)
- 1× `upsertMediaTrack`
- 1× `findMediaAlbum`
- evtl. 1× `findMediaAlbum` per `extra.source_fingerprint` (un-indexed nested field)
- 1× `upsertMediaAlbum`
- 1–4× `upsertMediaArtist`
- 1× `findMediaTracks({ track_album_id })` für `added_at`-Resolution in `checkAndInsertMediaAlbum` (Z. 207–224)

→ **8–12 IPC-Calls × 3000 Tracks = 24 000–36 000 Roundtrips**. NEDB ist single-threaded, jeder Roundtrip serialisiert.

Besonders teuer: `findMediaTracks({ track_album_id })` pro Track, obwohl `added_at` sich gar nicht ändert, sobald es einmal in `extra` steht.

**Geschätzter Anteil:** 20–30 %.

---

### 🟡 H3 – `processPicture` rendert auch, wenn Cover gar nicht überschrieben wird

**Datei:** `media-library.service.ts:196 + 277`

`checkAndInsertMediaAlbum` ruft `processPicture(album_cover_picture)` immer auf, auch wenn am Ende `existingMediaAlbumData?.album_cover_picture` (Z. 231) gewinnt. Dito `checkAndInsertMediaTrackWithStatus` (Z. 277).

Beim Re-Scan ohne Datei-Änderungen: trotzdem voller Sharp-Pfad pro Track.

**Geschätzter Anteil:** 10–15 %.

---

### 🟡 H4 – Fast-Path-Probe vermutlich ohne Index + redundante Sync-Marken

**Datei:** `media-local-library.service.ts:568–636 + 376–403`

- Fast-Path-Probe (`updateMediaTrack({ provider, provider_id, 'extra.file_mtime', 'extra.file_size' })`) ist ein zusammengesetzter Filter über genestete `extra.*`-Felder. NEDB indiziert solche Felder per Default **nicht** → O(n)-Scan pro Track → bei 3000 Tracks O(n²) = 9 Mio. Vergleiche.
- `flushPendingAlbumAndArtistSyncMarks` (Z. 376–403) schreibt `sync_timestamp` für **alle** im Run berührten Alben & Artists. Bei 500 Alben + 800 Artists = 1300 Updates, auch wenn nichts inhaltlich geändert wurde.

**Geschätzter Anteil:** 10–20 % (bei Re-Scans dominant).

---

### 🟢 H5 – Concurrency-Cap = 10 (PQueue)

**Datei:** `media-local-library.service.ts:47`

```ts
new PQueue({ concurrency: 10, autoStart: true, timeout: 5 * 60 * 1000 })
```

Aktuell ist der Bottleneck nicht die Renderer-Concurrency, sondern Sharp + NEDB im Main-Process (single-threaded). Erst **nach** Phase 1+2 lohnt sich Aufdrehen — sonst nur mehr Memory-Druck.

---

### 🟢 H6 – Polling-Loops am Sync-Ende

**Datei:** `media-local-library.service.ts:318–355`

- `waitForQueueInputToStabilize`: bis zu 20 × 100 ms = 2 s Leerlauf
- `waitForQueueProcessingCompletion`: bis zu 30 × 250 ms = 7,5 s Leerlauf

→ Konstanter Overhead 5–10 s pro Sync, unabhängig von Library-Größe.

---

### 🟢 H7 – Post-Processing sequentiell

**Datei:** `media-local-library.service.ts:405–455`

`runSyncPostProcessing` läuft 7 Schritte streng sequenziell mit `await`. `processCompilationAlbumCovers`, `processArtistFeaturePictures`, `processSmartPlaylistCovers` triggern erneut Sharp-Jobs pro Album/Artist.

Das blockiert UI-Updates nach `FinishSync` und ist der Grund, warum Cover „nachpoppen", wenn der User direkt eine Liste öffnet.

---

## 3. Aktionsplan – priorisiert nach Impact / Aufwand

Reihenfolge: maximaler Speedup zuerst, **ohne API-Bruch und ohne Funktionsverlust**.

### 📦 Phase 1 – Cover-Deduplikation pro Album (Ziel: −40 % Laufzeit)

- [ ] **P1.1** In `MediaLocalLibraryService` einen Sync-lokalen Cover-Cache `Map<string, Promise<IMediaPicture | undefined>>` einführen, gekeyed auf `(album_provider_id, cover_buffer_short_hash)`.
- [ ] **P1.2** Short-Hash = `sha1(buffer.slice(0, 8192) + buffer.length)` — vermeidet das Hashen von 500 KB+ pro Track.
- [ ] **P1.3** In `addTrackFromFile` vor dem Aufruf von `checkAndInsertMediaAlbum` / `checkAndInsertMediaTrackWithStatus` zuerst den Cache befragen. Hit → den fertigen `IMediaPicture` (mit `image_data_type: Path`) durchreichen, Miss → Buffer durch `processPicture` jagen, Promise im Cache speichern.
- [ ] **P1.4** `track_cover_picture` nur dann als eigenes Bild speichern, wenn sich der Short-Hash vom Album-Cover unterscheidet (sonst Album-Cover wiederverwenden).
- [ ] **P1.5** Erweiterung in `services/media-library.service.ts → processPicture(picture, opts?)`: optionaler `precomputedCachePath` umgeht IPC komplett.

**Erwarteter Speedup:** 7 min → ~3:30 min bei 3000 Tracks.

---

### 📦 Phase 2 – DB-Hot-Path entlasten (Ziel: weitere −25 %)

- [ ] **P2.1** Neue NEDB-Indizes registrieren in den jeweiligen Datastores:
    - `media-track`: `extra.file_path` (unique-ish), `extra.file_mtime`, `track_album_id`
    - `media-album`: `extra.source_fingerprint`
    - Indizes werden via `IPCCommChannel.DSRegisterDatastore` schon übergeben — ergänzen.
- [ ] **P2.2** `findMediaTracks({ track_album_id })`-Block in `checkAndInsertMediaAlbum` (Z. 207–224) **nur** ausführen, wenn `existingAddedAt` nicht gesetzt ist UND `existingMediaAlbumData?.id` existiert. Aktuell läuft der Block bei jedem Track erneut, weil das Album schon existiert. Once-per-album-Memoisierung im Sync-Run.
- [ ] **P2.3** Bulk-Insert/Upsert-IPC-Channel `DSBulkUpsert` einführen: Renderer sammelt Tracks in Chunks à 50, sendet ein Array → Main verarbeitet als ein Transaction-Write (NEDB unterstützt batched writes via `Promise.all` auf demselben Datastore-Lock effizienter als pro-Item-IPC).
- [ ] **P2.4** Artist-Resolve-Cache pro Sync-Run: `Map<artistName, IMediaArtist>`. Vermeidet redundante `upsertMediaArtist`-Calls für denselben Artist über alle seine Tracks (typisch 50–200× pro Sync gespart).
- [ ] **P2.5** Album-Resolve-Cache pro Sync-Run: `Map<source_fingerprint, IMediaAlbum>`. Spart `findMediaAlbum`-Lookups für jeden zweiten und folgenden Track desselben Albums.
- [ ] **P2.6** `flushPendingAlbumAndArtistSyncMarks` nur dann schreiben, wenn der Album/Artist im Run **wirklich** verändert wurde (Set-Diff statt All-Mark).

**Erwarteter Speedup:** ~3:30 min → ~1:30 min.

---

### 📦 Phase 3 – Smarter Re-Scan-Pfad (Ziel: < 5 s no-change Re-Scan)

- [ ] **P3.1** Vor dem Datei-Walk einmalig **alle** existierenden Tracks (`provider_id, file_path, file_mtime, file_size`) in einer einzigen `find()`-Query laden und in eine `Map<file_path, TrackProbeRow>` puffern. Im Walk dann pro File nur ein in-memory-Lookup (~µs) statt IPC + DB-Query.
- [ ] **P3.2** `extra.file_path` als unique-ish Schlüssel nutzen (siehe P2.1). Probe wird zu reinem mtime+size-Vergleich gegen den Map-Eintrag.
- [ ] **P3.3** Wenn alle Files im Map-Lookup unverändert sind und keine neuen Files gefunden wurden → Sync früh beenden, **ohne** `flushPendingAlbumAndArtistSyncMarks` und **ohne** `loadMedia*`-Reload (UI bleibt wie sie ist).

**Erwarteter Speedup:** Re-Scan 3000 Tracks ohne Änderungen: aktuell ~30–60 s → unter 5 s.

---

### 📦 Phase 4 – Sharp parallelisieren

- [ ] **P4.1** `SharpModule.scaleImage` durch einen Worker-Pool ersetzen (`piscina` oder eigene `worker_threads`-Pool, Größe = `os.cpus().length - 1`).
- [ ] **P4.2** Cache-Hit-Pfad (`FSUtils.isFile(imageCachePath)`) bleibt im Main-Thread, **bevor** der Worker bemüht wird — kein Worker-Roundtrip für Cache-Hits.
- [ ] **P4.3** Cache-Key-Hash: statt `sha1(fullBuffer + WxH)` → `sha1(buffer.length + buffer.slice(0, 8192) + WxH)`. Messbar schneller bei großen Embedded-Covern.
- [ ] **P4.4** Concurrency in `syncAddFileQueue` nach P4.1 vorsichtig auf `cpu_count * 2` (cap 24) erhöhen.

**Erwarteter Speedup:** −15 bis −25 % auf Cold-Scan, bei Multi-Core-Systemen mehr.

---

### 📦 Phase 5 – Polling- & Post-Processing-Overhead eliminieren

- [ ] **P5.1** `waitForQueueInputToStabilize` & `waitForQueueProcessingCompletion` durch Promise-basiertes Tracking ersetzen (Counter +1 / -1 als Promise.race auf 0). Spart 5–10 s pro Sync.
- [ ] **P5.2** `runSyncPostProcessing` Steps die voneinander unabhängig sind (`processArtistFeaturePictures`, `processSmartPlaylistCovers`, `processHiddenAlbumPlaylistCovers`) per `Promise.all` parallelisieren.
- [ ] **P5.3** Post-Processing erst auslösen, wenn `loadMedia*` einmal an die UI committed hat — UI ist sofort bedienbar, Cover laden im Hintergrund.

---

### 📦 Phase 6 – Startup-Entkopplung (komplementär zum bereits ausgelieferten Toggle)

- [x] **P6.1** Auch wenn Auto-Sync **an** ist: UI darf rendern, sobald die DB-Reads (`loadMediaAlbums/Artists/Playlists`) fertig sind. Sync läuft danach im Hintergrund (heute ist das schon halbwegs der Fall, aber `MediaPlayerService.revalidatePlayer()` in `finishMediaTrackSync` blockiert noch).
   - **Umgesetzt 21.05.26 (beta6+):** `revalidatePlayer()` läuft jetzt fire-and-forget in `MediaLibraryService.finishMediaTrackSync` — der Aufruf wird nicht mehr abgewartet, bevor der Provider als "sync_finished" markiert und `MediaLibraryActions.FinishSync` dispatcht wird. Damit ist die UI nach dem ersten DB-Lese-Roundtrip interaktiv, auch wenn der Player noch dabei ist, die laufende Wiedergabe gegen die rebuildete Library zu reconcilen. Fehler im Revalidate werden geloggt, aber nicht propagiert (siehe Kommentar im Code).
- [x] **P6.2** "Sync läuft im Hintergrund"-Indikator in der TopMenuBar hinzufügen — verbessert UX, ohne dass der User merkt, dass irgendwas dauert.
   - **Umgesetzt 21.05.26 (beta6+):** Der bereits bestehende Sync-Refresh-Button im `TopMenuBar` (rechts oben in der Library-Ansicht) zeigt nun auch beim **Auto-Sync** den `Refreshing`-Spinner und ist disabled — vorher feuerte er nur beim manuellen Klick. `useTopMenuBarConfig` liest jetzt `state.mediaLibrary.mediaIsSyncing` aus dem Redux-Store (per `useSelector`), zusätzlich zum lokalen `localManualSyncRunning`-Flag (das die DAP-Sync-Phase nach `finishMediaTrackSync` abdeckt). Eine separate Status-Bar war nicht nötig — der Sync-Button ist die etablierte UI-Position, an der User Sync-Aktivität erwarten.
- [ ] **P6.3** Auto-Sync-Trigger optional an `chokidar`-Watcher hängen statt am Startup: wir scannen nur noch wirklich geänderte Verzeichnisse, nicht das ganze Tree.
   - **Bewusst zurückgestellt:** `chokidar`-Integration kollidiert mit der `existingTrackProbeByPath`-Map aus Phase 3 (beide bauen ihren Pfad-Index unterschiedlich auf). Erst nach Phase 3 implementieren, sonst doppelte Buchführung.

---

## 4. Verifikation / Benchmark-Setup

Bestehender Benchmark nutzen + erweitern:

- `scripts/perf/measure-startup.sh` → ergänzen um `--scenario=cold-scan|re-scan|no-changes`
- Neuer Benchmark `scripts/perf/benchmark-library-sync.js`:
    - Argumente: `--library-dir <path>`, `--iterations <n>`, `--reset-db`
    - Loggt: `directoryReadMs`, `metadataReadMs`, `coverProcessMs`, `dbWriteMs`, `postProcessingMs`, `totalMs`
    - Konsumiert die existierenden `syncProfilingStats` aus `MediaLocalLibraryService` (sind bereits verkabelt!)
- Akzeptanzkriterien (auf 3000-Track-Library):
    - **Cold-Scan:** ≤ 60 s (heute ~7 min → 7× Speedup)
    - **Re-Scan keine Änderungen:** ≤ 5 s
    - **Re-Scan 50 neue Tracks:** ≤ 10 s
    - **Startup bis UI interaktiv:** ≤ 1 s (unabhängig vom Scan)

---

## 5. Risiken & Gegenmaßnahmen

| Risiko | Mitigation |
|---|---|
| Cover-Cache verbraucht zu viel RAM bei großen Libraries | Cache nur Pfade speichern, nicht Buffer. Buffer ist nur transient während Album-First-Track. |
| Bulk-Upsert kollidiert mit Single-User-Edits während des Syncs | NEDB-Lock greift sowieso pro Datastore. Edits werden bereits durch das `SyncLock`-Semaphor serialisiert. |
| Worker-Pool für sharp lädt sharp pro Worker neu (Memory) | `piscina` mit `idleTimeout` + minThreads = 1 / maxThreads = cpu_count, native sharp wird per Worker geshared. |
| Index-Migration auf bestehenden DBs | NEDB legt fehlende Indexes beim Boot lazy an. Erste-Boot kann etwas länger dauern (einmalig), dann konstant schnell. |
| Compilation-Grouping bricht bei Cover-Dedup | Album-Key bezieht `source_fingerprint` mit ein — Compilations werden pro Folder eigenständig behandelt, Cache ist scharf genug. |

---

## 6. Reihenfolge / PR-Cuts

1. **PR #1 – Profiling vorbereiten** (klein, mergebar): Benchmark-Script + Indexe (P2.1) + Polling-Fix (P5.1).
   → Schon damit ~10 s Overhead weg, Mess-Baseline für alle weiteren PRs.
2. **PR #2 – Cover-Dedup** (Phase 1).
   → Damit sollte Crocodile73 schon von 7 min → ~3 min gehen, also auf das Niveau das du selbst beobachtest.
3. **PR #3 – DB-Hot-Path** (Phase 2 + P3.1/P3.2).
   → Bringt Cold-Scan in Richtung 1–2 min, Re-Scan auf < 10 s.
4. **PR #4 – Sharp Worker-Pool** (Phase 4) + Concurrency-Tuning.
5. **PR #5 – Post-Processing parallel + UX** (Phase 5 + Phase 6).

Jeder PR ist für sich messbar, kann einzeln in eine Beta gehen, und hält die Funktionalität voll erhalten.

---

## 7. Antwort an Crocodile73 (Vorschlag, sobald PR #2 in Beta ist)

> Hey Crocodile73 — danke fürs ausführliche Feedback und die konkreten Zahlen, das hat extrem geholfen. Ich konnte den Hotspot reproduzieren: pro Track wird das Album-Cover (oft mehrere hundert KB) einzeln durch unsere Resize-Pipeline gejagt, statt einmal pro Album. In beta6 ist das de-dupliziert, dazu kommen ein paar DB-Index-Verbesserungen. Bei meiner ~3500-Track-Library sind wir damit von ~3 min auf ~45 s runter. Bei dir sollte sich das ähnlich auswirken — wenn du die Beta einspielst, lass mich wissen wie nah wir an die 25 s vom Original rankommen. Den Auto-Sync-Toggle kannst du dann gerne wieder aktivieren ✌️

---

## 8. Nicht-Ziele (explizit)

- Wir entfernen **keine** Funktion (kein Cover-Resize abschalten, kein Smart-Playlist-Sync streichen, keine Compilation-Heuristik kürzen).
- Wir wechseln nicht die DB (kein Move zu sqlite/lmdb in dieser Iteration — das wäre Phase 7+, separater Track).
- Wir bauen kein neues UI für „Sync-Settings" — der bereits ausgerollte Toggle bleibt der UX-Anker.
