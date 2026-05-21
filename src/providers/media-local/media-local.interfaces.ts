import { IMediaTrack } from '../../interfaces';

export interface IMediaLocalSettings {
  library: {
    directories: string[];
    group_compilations_by_folder?: boolean;
    /**
     * Whether the local library should be re-scanned automatically on every
     * app start. When `false` (default since 1.5.6) the user's existing,
     * already-indexed library is loaded from the local DB and *no* filesystem
     * scan is performed at startup — that keeps cold start short, especially
     * for big libraries. The user can still trigger a sync manually via the
     * "Sync"-button in the browser sidebar (see `browser.component.tsx
     * → handleSync`) or from the local-provider settings.
     *
     * Existing profiles created before this flag was introduced fall back to
     * the historical behaviour (`undefined` is treated as `true`) so we don't
     * break workflows for anyone who relied on auto-sync. New profiles are
     * created with this flag explicitly set to `false` (see initial state in
     * `media-local.store.ts`).
     */
    auto_sync_on_startup?: boolean;
  };
  cd_import?: {
    output_directory?: string;
    naming_template?: string;
    discogs_token?: string;
  };
}

export interface IMediaLocalTrack extends IMediaTrack {
  extra: {
    file_source: string;
    file_path: string;
    file_mtime?: number;
    file_size?: number;
    audio_sample_rate_hz?: number;
    audio_bit_depth?: number;
    audio_bitrate_kbps?: number;
    audio_codec?: string;
    audio_file_type?: string;
  }
}
