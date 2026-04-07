# DLNA Deep Analysis (Mac Controller ↔ Android Renderer)

## Scope
- Controller: `src/services/dlna.service.ts`, `src/services/media-player.service.ts`, `src/providers/media-local/media-local-playback.model.ts`
- Renderer: Android Launcher DLNA service and control bridge
- Evidence: merged logs from controller + ADB

## Observed Symptoms
- Renderer executes commands, but controller occasionally remains in playing state after stop.
- Playback position intermittently appears stale on controller side.
- Track change state can desync under snapshot gaps.

## Evidence Highlights
- Historical timeout phase exists in controller log:
  - `soap_request_timeout` for `Play`, `Stop`, `GetTransportInfo` (legacy phase before parser hardening).
- Current renderer ADB trace shows healthy state and position updates:
  - Repeated `PlaybackState updated state=PLAYING posMs=...` with monotonic progress.
  - `QueueContext applied ... stored=... index=...`.
- Retest command sequence (post-fix) confirms:
  - `GetTransportInfo` returns `PLAYING` after Play and `STOPPED` after Stop.
  - `GetPositionInfo` returns progressing `RelTime` and correct playlist index on next/previous.

## Root Cause Analysis
- Controller-side fallback logic allowed stale `PLAYING` state for too long when snapshots briefly fail or are missing (`lastRendererTransportState` grace window too wide).
- After stop, stale renderer progress/state cache could still bias UI state toward playing in edge windows.
- Renderer-side position exposure was already improved, but controller reconciliation needed stricter demotion to paused/stopped.

## Implemented Controller Hardening
- In `stopMediaPlayer()`:
  - force controller renderer-state cache reset to `STOPPED`
  - clear playing grace flags
  - reset inferred renderer progress cache
- In remote snapshot processing:
  - on `STOPPED/NO_MEDIA_PRESENT`: persist paused state and reset playing grace signals
  - restrict fallback-to-PLAYING branch to a short freshness window
  - reduce catch/fallback inferred-playing grace from long window to short window

## Key Code Changes
- `src/services/media-player.service.ts`
  - `stopMediaPlayer()` cache reset for renderer transport/progress flags
  - strict handling for `STOPPED/NO_MEDIA_PRESENT`
  - fallback playing grace tightened to short window

## Validation Steps Executed
- Reinstall Android APK on device and verify version.
- Execute E2E SOAP cycle:
  - `SetAVTransportURI → Play → GetTransportInfo → GetPositionInfo → Pause → Seek → Play → Next → GetPositionInfo → Previous → GetPositionInfo → Stop → GetTransportInfo → GetPositionInfo`
- Capture ADB logs and controller logs into merged analysis file.

## Current Status
- Command transport is stable (`HTTP 200`).
- Transport state transitions are consistent (`PLAYING`, `PAUSED`, `STOPPED`).
- Position data is available and updates correctly in renderer responses.
- Controller reconciliation hardened against stale playing carry-over after stop.
