export enum IPCCommChannel {
  // these channels are used to send messages from renderer to main
  AppToggleWindowFill = 'app:toggle_window_fill',
  AppResetSettings = 'app:reset_settings',
  AppReadDetails = 'app:read_details',
  AppOpenMenu = 'app:open_menu',
  AppReadUpdateSettings = 'app:read_update_settings',
  AppSaveUpdateSettings = 'app:save_update_settings',
  AppReadUpdateState = 'app:read_update_state',
  AppSetThemeMode = 'app:set_theme_mode',
  AppCheckForUpdates = 'app:check_for_updates',
  AppDownloadUpdate = 'app:download_update',
  AppInstallUpdate = 'app:install_update',
  AppReadWhatsNew = 'app:read_whats_new',
  AppDismissWhatsNew = 'app:dismiss_whats_new',
  // file system (fs)
  FSReadAsset = 'fs:read_asset',
  FSSelectDirectory = 'fs:select_directory',
  FSSelectFile = 'fs:select_file',
  FSReadDirectoryStream = 'fs:read_directory_stream',
  FSReadFile = 'fs:read_file',
  FSShowItemInFolder = 'fs:show_item_in_folder',
  // datastore (ds)
  DSCount = 'ds:count',
  DSRegisterDatastore = 'ds:register_datastore',
  DSFind = 'ds:find',
  DSFindOne = 'ds:find_one',
  DSInsertOne = 'ds:insert_one',
  DSUpdate = 'ds:update',
  DSUpdateOne = 'ds:update_one',
  DSRemoveOne = 'ds:remove_one',
  DSRemove = 'ds:remove',
  DSUpsertOne = 'ds:upsert_one',
  // image
  ImageScale = 'image:scale',
  ImageGetColors = 'image:get_colors',
  // device
  DeviceGetAudioCdStatus = 'device:get_audio_cd_status',
  DeviceGetAudioCdTracks = 'device:get_audio_cd_tracks',
  DeviceEjectAudioCd = 'device:eject_audio_cd',
  DeviceEjectVolume = 'device:eject_volume',
  DeviceSearchDiscogsReleases = 'device:search_discogs_releases',
  DeviceGetDiscogsRelease = 'device:get_discogs_release',
  DeviceImportAudioCd = 'device:import_audio_cd',
  DeviceWriteFlacMetadata = 'device:write_flac_metadata',
  DeviceFindAlbumImages = 'device:find_album_images',
  DeviceEmbedCoverInTracks = 'device:embed_cover_in_tracks',
}

export enum IPCRendererCommChannel {
  // these channels are used to send messages from main to renderer
  // state
  StateRemovePersisted = 'state:remove_persisted',
  // ui
  UIOpenSettings = 'ui:open_settings',
  UIAppUpdateStateChanged = 'ui:app_update_state_changed',
  UIAppBeforeQuit = 'ui:app_before_quit',
  UIFullScreenChanged = 'ui:fullscreen_changed',
  // media
  MediaHardwareControl = 'media:hardware_control',
  // device
  DeviceAudioCdUpdate = 'device:audio_cd_update',
  DeviceAudioCdImportProgress = 'device:audio_cd_import_progress',
}
