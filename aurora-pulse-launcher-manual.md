# Aurora Pulse Launcher — User Guide (Beta 5)

Aurora Pulse Launcher is an Android home launcher built around music: local library browsing, playback, optional DLNA-oriented audio routing, app launching, notifications, and an integrated equalizer. This guide matches the **1.0.0-beta.5** line of builds: installation, everyday use, what changed in recent betas, and troubleshooting.

The main workflow uses bottom tabs: **Library** (find music), **Play** (transport and queue), **Apps** (installed apps), and **Settings** (library, audio, launcher, and maintenance). A bell control opens the notification center when system access is granted.

---

## Installation

Install from a release APK (for example `AuroraPulseLauncher-1.0.0-beta5.apk`). Copy the file to the device and open it in a file manager, or install from a computer with USB debugging:

```bash
adb install -r AuroraPulseLauncher-1.0.0-beta5.apk
```

The `-r` flag keeps app data when replacing an existing install.

If Android blocks the install, allow “Install unknown apps” for your file manager or shell. If the package is rejected as a downgrade, the new APK’s version code must be greater than what is already installed—use a newer build or uninstall the old build during development only.

After install, open the app once and complete **library folder** and **notification** setup (below) so browsing and the player work reliably.

---

## Language and localization (Beta 5)

The interface strings follow your **device language** when a translation is available. Supported locales include:

- English  
- German  
- French  
- Spanish  
- Simplified Chinese  
- Hindi  

If the device locale is not matched, the app falls back to **English**. Library content (artist names, album titles, and so on) still comes from your files’ metadata, not from the UI translation layer.

---

## First-run setup

Recommended order:

1. **Music library** — Grant access to one or more folders that contain audio (see **Media library**).
2. **Default launcher** (optional but typical for DAP-style use) — Set Aurora Pulse as the default Home app so the **Home** button returns here.
3. **Notifications** — If you want the in-app notification center, grant notification access in system settings when prompted or from Settings.

Until at least one library folder is chosen, the Library tab can only show an empty state.

---

## Navigation and main areas

### Library

At the top you can switch **Albums**, **Titles**, and **Playlists**.

- **Albums** — Grid/list of albums. **Short press** opens the track list for that album. **Long press** starts playback from the beginning of that album (queue order follows metadata and folder ordering, including multi-disc layouts where applicable).
- **Titles** — Inside an album, a filtered track list; from the Titles mode directly, a global list sorted by track title.
- **Playlists** — Playlist-driven scope; opening items moves you into a title-style list for that playlist.

**Search** (where available) needs **at least three characters** before results are shown. You may see **active filters** (album or playlist); clear them from the chip or action shown in the library header.

While the indexer refreshes, a **background updating** style message can appear; large libraries may keep working for a while after the first import.

### Play (player)

Shows artwork (when available), metadata, progress, queue position (for example “3 / 12”), and prev / play-pause / next. Long titles use a **marquee** pattern: short titles stay still; long titles scroll periodically. Playback is wired to the **media session** so lock-screen and system controls stay in sync where the OS allows.

### Apps

Lists installed applications. You can **pin** apps for quicker access; pinned entries are grouped separately. A **search** field helps filter long app lists.

### Settings

Aggregates actions delivered by the native **settings bridge** plus built-in rows, typically including:

- **Import / manage music library** — Opens the Storage Access Framework folder picker; you can add **multiple** roots. URIs are stored and used to rebuild or update the index.
- **Audio output / DLNA** — Toggles renderer-related behavior for setups that use DLNA (wording depends on bridge labels).
- **Equalizer** — Opens the EQ sheet (see **Equalizer**).
- **Default launcher** — Sends you to Android’s Home app settings.
- **Bit-perfect / DAP sync** — Placeholders or bridge-driven entries may appear depending on build and native module.
- **Restart app** — Asks the native layer to **restart the current app** so the whole launcher process reloads (useful after permission or index changes). If native restart is unavailable, behavior may fall back to a dev reload in debug builds only.

Exact titles and order can vary slightly depending on the native module; function is unchanged.

### Notification center

With **notification listener** permission, the bell opens a panel that lists and manages recent notifications. Without permission, behavior is limited.

### Equalizer (from Settings or menu)

- **10-band graphic EQ**, **preamp**, and **headroom** handling.
- **Parametric / AutoEQ mode** — Import profiles (for example `.peq` or `.txt`). When AutoEQ/Parametric mode is **on**, **manual 10-band editing is disabled** so two filter stacks do not fight each other. Turn AutoEQ off to edit bands again.
- Native apply errors surface as short **messages** in the panel (also localized where strings exist).

---

## Media library, cache, and startup (Beta 5)

**Folder selection** uses Android’s **document tree** permissions. Added folders are merged into the set of **library roots**.

To make cold starts usable on large collections, Beta 5 keeps a **persistent library cache** (metadata snapshot) when roots are unchanged:

- After a **full** scan, a snapshot can be saved so the next launch can **reuse** album/title data quickly.
- Very large JSON payloads are stored in **chunks** in persistent storage to stay within Android storage limits.
- If roots **change**, the cache is tied to the old roots and a **fresh** scan applies—this is expected.

**What you should know as a user:**

1. The **first** deep import after adding folders (or after a big library change) can take noticeable time—let it finish.
2. **Later launches** with the **same** folders should feel faster than repeating a full metadata mapping from scratch.
3. If the UI looks empty but you know music is there, use **library reload** from Settings (or the refresh pattern your build exposes) and confirm folder access was not revoked by the system.

---

## Everyday usage

A typical flow: **Library → Albums** → open album → start a track → **Play** for seeking and queue context. For “play the whole album now,” **long-press** the album on **Albums**.

For DAP-style use, set Aurora as **default Home**, then move between Library and Play without leaving the launcher shell.

---

## Set Aurora Pulse as default launcher

**Settings → Default launcher** (or equivalent) → Android Home settings → choose **Aurora Pulse** → prefer **Always** if the system asks “Once” vs “Always.” If a vendor update clears defaults, repeat this step.

---

## Troubleshooting

| Issue | What to try |
|--------|----------------|
| Empty library | Re-run **music library import**; confirm folders still exist; revoke/re-grant storage access if Android cleared it. |
| “No media in selected folders” after an upgrade | Trigger a **full reload**; ensure the first scan after upgrade completed; check that roots did not change under the same label. |
| Slow first launch after install | Normal for large libraries; wait for the initial sync. Later launches should improve when the cache matches current roots. |
| Stale or wrong metadata | Use **library reload / delta reload** from Settings (wording from native bridge). |
| EQ seems ineffective | Confirm **AutoEQ** is not **on** while you expect manual bands; raise/lower a band several dB on a playing track. |
| Lock-screen controls wrong | Pause and resume once; if it persists, use **Restart app** in Settings. |
| Default Home not Aurora | Open system **Home** settings again and re-select Aurora Pulse. |
| Notifications panel empty or disabled | Grant **notification access** in system settings. |

For crashes, capture a short log (for example `adb logcat -d -t 300`) and include `AndroidRuntime` / relevant `ReactNative` lines when reporting.

---

## Beta builds

Beta versions (such **1.0.0-beta.5**) may change behavior between releases: library caching, startup metrics, localization keys, and bridge defaults are actively refined. After updating an APK, do one clean **Restart app** from Settings if something looks stuck.

Stable **non-beta** version numbers (for example future `1.0.0` without a beta suffix) are intended to be long-lived storefront releases; treat beta APKs as time-limited field tests unless your distributor states otherwise.

---

## Quick reference — Beta 5 highlights

- **Six UI locales** driven by device language, English fallback.  
- **Persistent chunked library cache** for faster restarts when library roots are unchanged.  
- **Restart app** in Settings for a full process reload.  
- **Library search** (minimum three characters) and **filter chips** for album/playlist scope.  
- **Equalizer** with AutoEQ import and mutual exclusion between AutoEQ and manual bands.  
- **DLNA-related audio** toggle integrated into Settings where the bridge provides it.  

For developers, the app lives under `apps/android-launcher` in the [Aurora Pulse Launcher](https://github.com/galdo/aurora-launcher) repository; the desktop player is a separate project ([Aurora Pulse](https://github.com/galdo/aurora)).
