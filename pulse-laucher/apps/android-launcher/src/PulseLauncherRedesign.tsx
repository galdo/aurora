import * as React from 'react';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Animated,
  DevSettings,
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Audio, InterruptionModeAndroid } from 'expo-av';
import { FontAwesome } from '@expo/vector-icons';

import { ContentRoute, ILauncherListItem } from './models/launcher';
import {
  IInstalledLauncherApp,
  loadInstalledLauncherApps,
  launchInstalledLauncherApp,
  refreshInstalledLauncherApps,
} from './services/launcher-apps';
import {
  IAudioFileMetadata,
  IPlaylistEntry,
  listAudioEntriesFromRoots,
  listPlaylistEntriesFromRoots,
  loadMetadataForUris,
  scanMetadataFromRoots,
} from './services/media-artwork';
import { loadRouteSections } from './services/media-library-bridge';
import {
  AutoEqProfile,
  createDefaultEqualizerSettings,
  IEqualizerSettings,
  importAutoEqProfileFromText,
  loadEqualizerSettings,
  persistEqualizerSettings,
  resetEqualizerBands,
  selectAutoEqProfile,
  setAutoEqEnabled,
  setEqualizerBandGain,
  setHeadroomCompensation,
} from './services/equalizer';
import {
  ISystemNotificationNativeItem,
  isNotificationAccessGranted,
  notificationEvents,
  openNotificationAccessSettings,
} from './services/system-notifications';
import { DLNAControlEventEmitter, updateDLNAPlaybackState, updateDLNAPlaybackTrack } from './services/dlna-control';
import { getSystemLanguage, translate } from './i18n';
import { AuroraThemeMode, getAuroraTheme } from './theme/aurora-theme';

type MainTab = 'library' | 'player' | 'apps' | 'settings';
type LibraryMode = 'albums' | 'titles' | 'playlists';
interface ILauncherNotification {
  id: string;
  packageName: string;
  appName: string;
  title: string;
  message: string;
}

const APP_LOGO = require('./assets/aurora-pulse-logo.png');
const { StorageAccessFramework } = FileSystem;
const DEFAULT_LAUNCHER_PROMPT_STORAGE_KEY = 'pulse-launcher:default-launcher-prompt-shown';
const MUSIC_LIBRARY_DIRECTORY_STORAGE_KEY = 'pulse-launcher:music-library-directory-uris';
const MUSIC_LIBRARY_CACHE_STORAGE_KEY = 'pulse-launcher:music-library-cache-v1';
const NOTIFICATION_ALLOWLIST_STORAGE_KEY = 'pulse-launcher:notification-allowlist-v1';
const APP_VERSION_DISPLAY = '0.0.1';
const APP_BUILD_DISPLAY = (() => {
  const now = new Date();
  const twoDigit = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${twoDigit(now.getMonth() + 1)}${twoDigit(now.getDate())}${twoDigit(now.getHours())}${twoDigit(now.getMinutes())}`;
})();
const libraryModes: { key: LibraryMode; label: string }[] = [
  { key: 'albums', label: 'Alben' },
  { key: 'titles', label: 'Titel' },
  { key: 'playlists', label: 'Playlists' },
];
const tabs: { key: MainTab; label: string; icon: keyof typeof FontAwesome.glyphMap }[] = [
  { key: 'library', label: 'Bibliothek', icon: 'home' },
  { key: 'player', label: 'Play', icon: 'play-circle' },
  { key: 'apps', label: 'Apps', icon: 'th-large' },
  { key: 'settings', label: 'Settings', icon: 'cog' },
];

const resolveRoute = (tab: MainTab, mode: LibraryMode): ContentRoute => {
  if (tab === 'settings') {
    return 'settings';
  }
  if (tab === 'apps') {
    return 'apps';
  }
  if (mode === 'albums') {
    return 'albums';
  }
  if (mode === 'playlists') {
    return 'playlists';
  }
  return 'library';
};

const formatClock = (milliseconds: number): string => {
  const safeMs = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatFrequencyLabel = (frequency: number): string => {
  if (frequency >= 1000) {
    return `${frequency / 1000}kHz`;
  }
  return `${frequency}Hz`;
};

const getLibraryPathFromUri = (uri?: string): string => {
  const source = decodeURIComponent(String(uri || ''));
  if (!source) {
    return '';
  }
  const documentMarkerIndex = source.indexOf('/document/');
  const treeMarkerIndex = source.indexOf('/tree/');
  let docPart = '';
  if (documentMarkerIndex >= 0) {
    docPart = source.slice(documentMarkerIndex + '/document/'.length);
  } else if (treeMarkerIndex >= 0) {
    docPart = source.slice(treeMarkerIndex + '/tree/'.length);
  } else {
    docPart = source;
  }
  const colonIndex = docPart.indexOf(':');
  const relativePath = colonIndex >= 0 ? docPart.slice(colonIndex + 1) : docPart;
  return relativePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
};

const normalizeLibraryPath = (path: string): string => path.toLowerCase();

const getParentLibraryPath = (path: string): string => {
  const separatorIndex = path.lastIndexOf('/');
  if (separatorIndex <= 0) {
    return '';
  }
  return path.slice(0, separatorIndex);
};

const getAlbumFolderKeyFromUri = (uri: string, rootUris: string[]): string => {
  const entryPath = getLibraryPathFromUri(uri);
  const normalizedEntryPath = normalizeLibraryPath(entryPath);
  const normalizedRoots = rootUris
    .map((rootUri) => getLibraryPathFromUri(rootUri))
    .filter(Boolean)
    .map((path) => ({
      raw: path,
      normalized: normalizeLibraryPath(path),
    }))
    .sort((left, right) => right.normalized.length - left.normalized.length);

  for (const root of normalizedRoots) {
    if (normalizedEntryPath === root.normalized || normalizedEntryPath.startsWith(`${root.normalized}/`)) {
      const relativePath = entryPath.slice(root.raw.length).replace(/^\/+/, '');
      
      // If the file is directly in the root, it belongs to a virtual root album
      if (!relativePath || !relativePath.includes('/')) {
        return root.raw;
      }

      const segments = relativePath.split('/');
      
      // The Album is ALWAYS the folder directly containing the tracks, 
      // UNLESS that folder is a CD1/CD2 folder, in which case the PARENT is the album.
      // E.g. Root/Audiophile Songs/Track.flac -> Album is "Root/Audiophile Songs"
      // E.g. Root/Artist/Album/CD1/Track.flac -> Album is "Root/Artist/Album"
      
      let albumSegments = [];
      // If the last segment is the filename, ignore it for folder logic
      // Actually `segments` here contains the filename as the last element because it's a file path
      for (let i = 0; i < segments.length - 1; i++) {
        const isDiscFolder = /^(?:cd|disc)\s*\d+$/i.test(segments[i] || '');
        if (isDiscFolder && i > 0) {
          // Stop accumulating album path at the disc folder
          break;
        }
        albumSegments.push(segments[i]);
      }
      
      if (albumSegments.length > 0) {
        return `${root.raw}/${albumSegments.join('/')}`.replace(/\/+/g, '/');
      }
      return root.raw;
    }
  }
  
  const parentPath = getParentLibraryPath(entryPath);
  if (parentPath) {
    const parentSegments = parentPath.split('/');
    const lastSegment = parentSegments[parentSegments.length - 1];
    if (/^(?:cd|disc)\s*\d+$/i.test(lastSegment || '')) {
       return getParentLibraryPath(parentPath) || parentPath;
    }
    return parentPath;
  }
  return '__library-root__';
};

const isTrackInFolder = (trackUri: string, folderPath?: string): boolean => {
  const normalizedTrackPath = normalizeLibraryPath(getLibraryPathFromUri(trackUri));
  const normalizedFolderPath = normalizeLibraryPath(String(folderPath || ''));
  if (!normalizedFolderPath) {
    return false;
  }
  // The track is in the folder if its path starts with the folder path
  // We don't want to strictly limit it to direct children because CD1/CD2 subfolders are part of the album
  return normalizedTrackPath === normalizedFolderPath || normalizedTrackPath.startsWith(`${normalizedFolderPath}/`);
};

const createStyles = (
  theme: ReturnType<typeof getAuroraTheme>,
  compact: boolean,
  topInset: number,
  bottomInset: number,
) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.mode === 'dark' ? '#0f131c' : '#ffffff' },
  screen: {
    flex: 1,
    backgroundColor: theme.mode === 'dark' ? '#0f131c' : '#ffffff',
    paddingHorizontal: compact ? 14 : 18,
    paddingTop: topInset + (compact ? 8 : 12),
  },
  title: { marginTop: 2, marginBottom: 12, fontSize: compact ? 34 : 38, fontWeight: '800', color: theme.colors.textPrimary },
  segmented: { minHeight: 44, marginBottom: 10, borderRadius: 22, padding: 4, flexDirection: 'row', backgroundColor: theme.mode === 'dark' ? '#1a2130' : '#f1f4f8', gap: 4 },
  segmentButton: { flex: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  segmentButtonActive: { backgroundColor: theme.colors.accent },
  segmentText: { fontSize: 16, fontWeight: '700', color: theme.mode === 'dark' ? '#96a0b5' : '#5c6478' },
  segmentTextActive: { color: '#ffffff' },
  scrollContent: { paddingBottom: 120, gap: 14 },
  libraryContent: { flex: 1, paddingBottom: 0 },
  grid: { marginTop: 14, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 40 },
  card: { width: '48%', marginBottom: 24 },
  cover: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2c3445' : '#ecf0f5',
    backgroundColor: theme.mode === 'dark' ? '#161d2b' : '#f4f7fb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverIcon: { fontSize: 28, color: theme.mode === 'dark' ? '#687086' : '#98a0b2' },
  coverImage: { width: '100%', height: '100%', borderRadius: 18 },
  itemTitle: { marginTop: 8, fontSize: 15, fontWeight: '800', color: theme.colors.textPrimary },
  itemSubtitle: { marginTop: 2, fontSize: 13, color: theme.colors.textSecondary },
  itemSubtitleAlbum: { marginTop: 2, fontSize: 13, color: theme.colors.accent, fontWeight: '400' },
  search: {
    marginTop: 10,
    minHeight: 46,
    borderRadius: 14,
    paddingHorizontal: 14,
    color: theme.colors.textPrimary,
    backgroundColor: theme.mode === 'dark' ? '#1a2231' : '#f6f8fb',
    fontSize: 16,
  },
  appsCaption: { marginTop: 16, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1.2, fontSize: 12, fontWeight: '800', color: theme.colors.textMuted },
  appsGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 },
  appCell: { width: '25%', alignItems: 'center', paddingHorizontal: 4 },
  appIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: theme.mode === 'dark' ? '#1b2433' : '#f7f9fc',
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2f3a4f' : '#edf1f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  appIconText: { fontSize: 20, fontWeight: '700', color: theme.mode === 'dark' ? '#aeb5c5' : '#697188' },
  appIconImage: { width: '100%', height: '100%', borderRadius: 16 },
  appName: { marginTop: 8, textAlign: 'center', fontSize: 12, fontWeight: '700', color: theme.colors.textPrimary },
  playerArt: {
    marginTop: 8,
    width: '88%',
    alignSelf: 'center',
    aspectRatio: 1,
    borderRadius: 34,
    backgroundColor: theme.mode === 'dark' ? '#181f2d' : '#f4f6fa',
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2a3243' : '#edf1f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerArtImage: { width: '76%', height: '76%', resizeMode: 'contain' },
  playerQueueIndex: { marginTop: 4, textAlign: 'center', fontSize: 10, fontWeight: '600', color: theme.mode === 'dark' ? '#8f98ab' : '#8b95a9' },
  playerScreen: { flex: 1, justifyContent: 'space-between', paddingBottom: bottomInset + 78 },
  playerTopBlock: { paddingTop: 6 },
  playerMiddleBlock: { marginTop: 9 },
  playerBottomBlock: { marginTop: 9, marginBottom: 28 },
  playerTitleViewport: { marginTop: 16, width: '100%', overflow: 'hidden', alignItems: 'center' },
  playerTitleMarqueeRow: { flexDirection: 'row', alignItems: 'center' },
  playerTitleMeasure: { position: 'absolute', left: -10000, opacity: 0 },
  playerTitle: { marginTop: 2, textAlign: 'center', fontSize: 30, fontWeight: '800', color: theme.colors.textPrimary },
  playerMeta: { marginTop: 10, textAlign: 'center', fontSize: 17, fontWeight: '600', color: theme.colors.textSecondary },
  progressRow: { marginTop: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  progressTrack: { flex: 1, height: 6, borderRadius: 999, backgroundColor: theme.mode === 'dark' ? '#242d3d' : '#edf0f5', overflow: 'hidden' },
  progressActive: { height: '100%', backgroundColor: theme.colors.accent },
  progressTimeText: { width: 44, fontSize: 12, fontWeight: '700', color: theme.colors.textMuted, textAlign: 'center' },
  refreshHintText: { marginTop: 4, fontSize: 11, color: theme.colors.textMuted },
  controls: {
    marginTop: 0,
    marginBottom: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
  },
  controlBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.mode === 'dark' ? '#20293a' : '#f4f6fb', alignItems: 'center', justifyContent: 'center' },
  controlBtnMain: { width: 62, height: 62, borderRadius: 31, backgroundColor: theme.colors.accent },
  controlText: { color: theme.mode === 'dark' ? '#c0c7d6' : '#6f778a', fontSize: 16, fontWeight: '700' },
  controlTextMain: { color: '#ffffff', fontSize: 37 },
  playPauseGlyphWrap: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPauseGlyphPlay: {
    marginLeft: 4,
    width: 0,
    height: 0,
    borderTopWidth: 11,
    borderBottomWidth: 11,
    borderLeftWidth: 17,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#ffffff',
  },
  playPauseGlyphPause: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  playPauseBar: {
    width: 7,
    height: 24,
    borderRadius: 2,
    backgroundColor: '#ffffff',
  },
  panel: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#273042' : '#edf1f6',
    backgroundColor: theme.mode === 'dark' ? '#171f2e' : '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  panelHeading: { textTransform: 'uppercase', letterSpacing: 1.4, fontSize: 12, fontWeight: '800', color: theme.colors.textMuted },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  settingLeading: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  settingIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.mode === 'dark' ? '#1f293c' : '#edf3fa',
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2b3448' : '#dfe7f2',
  },
  settingIcon: { color: theme.colors.accent, fontSize: 13 },
  settingTextWrap: { flex: 1 },
  settingsHeaderRow: { marginBottom: 8 },
  settingsHeaderTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingsVersionInline: { marginTop: -2, fontSize: 11, fontWeight: '700', color: theme.colors.textMuted },
  settingsInfoButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2b3448' : '#dfe7f2',
    backgroundColor: theme.mode === 'dark' ? '#1a2435' : '#edf3fa',
  },
  settingsInfoPanel: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2b3448' : '#dfe7f2',
    backgroundColor: theme.mode === 'dark' ? '#141d2c' : '#f5f9ff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    marginBottom: 6,
  },
  settingsInfoLogo: { width: 130, height: 44, resizeMode: 'contain', alignSelf: 'center', opacity: 0.9 },
  settingsInfoTitle: { textAlign: 'center', fontSize: 13, fontWeight: '800', color: theme.colors.textPrimary },
  settingAction: { minHeight: 34, paddingHorizontal: 12, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.mode === 'dark' ? '#193326' : '#ebfef2' },
  settingActionText: { color: theme.colors.accent, fontSize: 12, fontWeight: '800' },
  helper: {
    marginTop: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#273041' : '#edf1f6',
    backgroundColor: theme.mode === 'dark' ? '#171f2e' : '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  helperText: { fontSize: 12, color: theme.colors.textSecondary },
  debugText: { fontSize: 11, color: theme.colors.textMuted, marginTop: 6 },
  notificationsFab: {
    position: 'absolute',
    right: compact ? 14 : 18,
    top: topInset + (compact ? 20 : 24),
    minWidth: 42,
    minHeight: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? 'rgba(120,136,160,0.25)' : 'rgba(120,136,160,0.18)',
    backgroundColor: theme.mode === 'dark' ? 'rgba(22,30,44,0.55)' : 'rgba(255,255,255,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: theme.mode === 'dark' ? 0.24 : 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
    zIndex: 13,
  },
  notificationsFabPressable: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationsFabInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  notificationsBell: { color: theme.mode === 'dark' ? '#dde6f8' : '#606b81' },
  notificationsText: { color: theme.mode === 'dark' ? '#dde6f8' : '#606b81', fontSize: 12, fontWeight: '800' },
  notificationsScreen: {
    position: 'absolute',
    top: topInset + (compact ? 54 : 60),
    left: 0,
    right: 0,
    bottom: bottomInset + 76,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? 'rgba(178,194,220,0.36)' : 'rgba(132,149,176,0.34)',
    backgroundColor: 'transparent',
    padding: 10,
    gap: 8,
    shadowColor: '#000000',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
    zIndex: 12,
    overflow: 'hidden',
  },
  notificationsBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 11,
  },
  notificationsBackdropTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.mode === 'dark' ? 'rgba(4, 8, 18, 0.22)' : 'rgba(234, 242, 252, 0.2)',
  },
  notificationsGlassTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.mode === 'dark' ? 'rgba(12, 18, 28, 0.2)' : 'rgba(244, 250, 255, 0.14)',
  },
  notificationsScreenContent: {
    flex: 1,
    gap: 8,
    backgroundColor: theme.mode === 'dark' ? 'rgba(12, 18, 28, 0.2)' : 'rgba(244, 250, 255, 0.14)',
  },
  notificationsScreenHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', marginBottom: 4 },
  notificationsTitle: { fontSize: 12, fontWeight: '800', color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  notificationsClose: { color: theme.colors.accent, fontSize: 12, fontWeight: '800' },
  notificationsScreenFooter: { marginTop: 10, alignItems: 'flex-end' },
  notificationsItem: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2f3a4f' : '#e6ecf4',
    backgroundColor: theme.mode === 'dark' ? '#182233' : '#f8fbff',
    padding: 8,
    gap: 2,
  },
  notificationsItemRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  notificationsItemContent: { flex: 1, gap: 2 },
  notificationsItemApp: { fontSize: 11, fontWeight: '800', color: theme.colors.accent },
  notificationsItemTitle: { fontSize: 13, fontWeight: '800', color: theme.colors.textPrimary },
  notificationsItemMessage: { fontSize: 12, color: theme.colors.textSecondary },
  notificationsItemPreview: { fontSize: 11, color: theme.colors.textMuted },
  notificationsDelete: { minWidth: 28, minHeight: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  notificationsDeleteIcon: { color: theme.mode === 'dark' ? '#d7deee' : '#607089' },
  notificationsEmpty: { fontSize: 12, color: theme.colors.textSecondary, textAlign: 'center', paddingVertical: 12 },
  trackList: { marginTop: 12, gap: 12, paddingHorizontal: 16, paddingBottom: 16 },
  trackGroup: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2b3447' : '#e9edf3',
    backgroundColor: theme.mode === 'dark' ? '#161e2d' : '#f9fbfe',
    overflow: 'hidden',
  },
  trackGroupHeader: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.mode === 'dark' ? '#2b3447' : '#e9edf3',
    backgroundColor: theme.mode === 'dark' ? '#1b2434' : '#eff4fb',
  },
  trackGroupHeaderText: { fontSize: 13, fontWeight: '800', color: theme.colors.accent },
  trackRow: {
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.mode === 'dark' ? '#2b3447' : '#e9edf3',
  },
  trackRowLast: { borderBottomWidth: 0 },
  trackNumber: {
    width: 24,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '800',
    color: theme.colors.textMuted,
  },
  trackCover: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2f3a4f' : '#e8edf3',
    backgroundColor: theme.mode === 'dark' ? '#1b2434' : '#f3f6fb',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  trackBody: { flex: 1 },
  trackTitle: { fontSize: 14, fontWeight: '800', color: theme.colors.textPrimary },
  trackArtist: { marginTop: 1, fontSize: 12, color: theme.colors.textSecondary },
  trackDuration: {
    width: 50,
    textAlign: 'right',
    fontSize: 11,
    color: theme.colors.textMuted,
    fontWeight: '700',
  },
  equalizerScreen: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 13,
    backgroundColor: theme.mode === 'dark' ? 'rgba(10,14,22,0.94)' : 'rgba(248,251,255,0.96)',
    paddingTop: topInset + 8,
    paddingHorizontal: compact ? 14 : 18,
    paddingBottom: bottomInset + 78,
  },
  equalizerScreenScroll: { paddingBottom: 12 },
  equalizerPanel: {
    marginTop: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2b3447' : '#e7edf5',
    backgroundColor: theme.mode === 'dark' ? '#141d2d' : '#f8fbff',
    padding: 12,
    gap: 10,
  },
  equalizerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  equalizerTitle: { fontSize: 16, fontWeight: '800', color: theme.colors.textPrimary },
  equalizerClose: { color: theme.colors.accent, fontSize: 12, fontWeight: '800' },
  equalizerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  equalizerLabel: { flex: 1, fontSize: 12, color: theme.colors.textSecondary },
  equalizerToggle: { minWidth: 58, minHeight: 28, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.mode === 'dark' ? '#1f2a3e' : '#e8eef6' },
  equalizerToggleActive: { backgroundColor: theme.colors.accent },
  equalizerToggleText: { fontSize: 11, fontWeight: '800', color: theme.mode === 'dark' ? '#d6dff0' : '#58627a' },
  equalizerToggleTextActive: { color: '#f7fff9' },
  equalizerBands: { gap: 6 },
  equalizerBandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  equalizerBandFreq: { width: 58, fontSize: 11, fontWeight: '700', color: theme.colors.textSecondary },
  equalizerBandValue: { width: 54, textAlign: 'center', fontSize: 11, fontWeight: '800', color: theme.colors.textPrimary },
  equalizerBandButton: { minWidth: 30, minHeight: 30, borderRadius: 10, backgroundColor: theme.mode === 'dark' ? '#202a3f' : '#e9eef6', alignItems: 'center', justifyContent: 'center' },
  equalizerBandButtonText: { fontSize: 16, fontWeight: '800', color: theme.colors.textPrimary },
  equalizerButtonRow: { flexDirection: 'row', gap: 8 },
  equalizerFooter: { marginTop: 10, alignItems: 'flex-end' },
  equalizerActionButton: { minHeight: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.colors.accent, alignItems: 'center', justifyContent: 'center' },
  equalizerActionText: { color: '#f7fff9', fontSize: 11, fontWeight: '800' },
  equalizerMessage: { fontSize: 11, color: theme.colors.textMuted },
  equalizerHistory: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  equalizerHistoryChip: { paddingHorizontal: 10, minHeight: 28, borderRadius: 99, backgroundColor: theme.mode === 'dark' ? '#24304a' : '#e8eff8', alignItems: 'center', justifyContent: 'center' },
  equalizerHistoryChipText: { fontSize: 11, color: theme.colors.textPrimary, fontWeight: '700' },
  bmcCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2b3447' : '#e9edf3',
    backgroundColor: theme.mode === 'dark' ? '#162236' : '#f5f9ff',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bmcLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  bmcIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.mode === 'dark' ? '#243551' : '#e4eefb',
  },
  bmcTitle: { fontSize: 14, fontWeight: '800', color: theme.colors.textPrimary },
  bmcSubtitle: { marginTop: 2, fontSize: 12, color: theme.colors.textSecondary },
  bmcAction: { color: theme.colors.accent, fontSize: 12, fontWeight: '800' },
  albumFilterRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: theme.mode === 'dark' ? '#1a2232' : '#f5f7fb',
  },
  albumFilterText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  albumFilterClear: { color: theme.colors.accent, fontSize: 12, fontWeight: '800' },
  loading: { minHeight: 90, alignItems: 'center', justifyContent: 'center', gap: 8 },
  bottomNav: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: bottomInset + 8,
    borderRadius: 28,
    borderWidth: theme.mode === 'dark' ? 1 : 0,
    borderColor: theme.mode === 'dark' ? 'rgba(90,104,128,0.24)' : 'transparent',
    backgroundColor: theme.mode === 'dark' ? 'rgba(18,25,39,0.62)' : '#eef3f8',
    padding: 5,
    flexDirection: 'row',
    gap: 6,
    shadowColor: '#000000',
    shadowOpacity: theme.mode === 'dark' ? 0.36 : 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: theme.mode === 'dark' ? 12 : 5,
    overflow: 'hidden',
  },
  bottomNavBackdrop: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: bottomInset + 8,
    height: 64,
    borderRadius: 28,
    overflow: 'hidden',
  },
  bottomNavBackdropTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.mode === 'dark' ? 'rgba(4, 8, 18, 0.45)' : 'rgba(234, 242, 252, 0.56)',
  },
  tab: { flex: 1, minHeight: 54, borderRadius: 22, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabActive: { backgroundColor: theme.colors.accent },
  tabActivePlayer: { backgroundColor: theme.colors.accent },
  tabActiveOutlined: { backgroundColor: theme.colors.accent },
  tabIcon: { color: theme.mode === 'dark' ? '#dde6f8' : '#606b81', fontSize: 24, fontWeight: '700' },
  tabIconActive: { color: '#f7fff9' },
  tabText: {
    color: theme.mode === 'dark' ? '#dde6f8' : '#606b81',
    fontSize: 10,
    fontWeight: '700',
    textDecorationLine: 'none',
    includeFontPadding: false,
  },
  tabTextActive: { color: '#f7fff9', textDecorationLine: 'none', includeFontPadding: false },
});

const isSettingItem = (item: ILauncherListItem): boolean => item.collectionType === 'setting';
const sanitizeDirectoryUris = (uris: string[]): string[] => Array.from(
  new Set(
    uris
      .map((uri) => String(uri || '').trim())
      .filter((uri) => uri.startsWith('content://')),
  ),
);

const collectUrisWithSafFallback = async (rootUris: string[]): Promise<string[]> => {
  const queue = [...rootUris];
  const visited = new Set<string>();
  const fileUris: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    let children: string[] = [];
    try {
      children = await StorageAccessFramework.readDirectoryAsync(current);
    } catch (_error) {
      continue;
    }
    if (!children || children.length === 0) {
      fileUris.push(current);
      continue;
    }
    children.forEach((child) => queue.push(child));
    if (fileUris.length > 3000) {
      break;
    }
  }
  return fileUris;
};

const loadMetadataForUrisChunked = async (uris: string[], chunkSize = 120): Promise<IAudioFileMetadata[]> => {
  const normalizedUris = Array.from(new Set(uris.filter(Boolean)));
  const rows: IAudioFileMetadata[] = [];
  for (let index = 0; index < normalizedUris.length; index += chunkSize) {
    const chunk = normalizedUris.slice(index, index + chunkSize);
    const chunkRows = await loadMetadataForUris(chunk);
    rows.push(...chunkRows);
  }
  return rows;
};

const shuffleItems = <T,>(items: T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = current;
  }
  return result;
};

const mapMetadataToLibraryItems = (
  metadataRows: IAudioFileMetadata[],
  mode: LibraryMode,
  rootUris: string[],
): ILauncherListItem[] => {
  const parseFileDescriptor = (row: IAudioFileMetadata): { track: number; artist: string; title: string; fileStem: string } => {
    const uri = row.uri;
    const decodedName = decodeURIComponent(String(uri || '').split('/').pop() || '');
    const fileStem = decodedName.replace(/\.[^.]+$/, '').trim();
    
    // 1. Try strict parsing from filename: "01. Artist - Title"
    const strictMatch = fileStem.match(/^(\d{1,3})\.\s*(.*?)\s*-\s*(.+)$/);
    if (strictMatch) {
      const track = Number.parseInt(strictMatch[1], 10);
      return {
        track: Number.isFinite(track) && track > 0 ? track : Number.MAX_SAFE_INTEGER,
        artist: strictMatch[2].trim() || 'Unbekannter Interpret',
        title: strictMatch[3].trim() || fileStem,
        fileStem,
      };
    }
    
    // 2. Try loose parsing from filename: "01. Title"
    const looseTrackMatch = fileStem.match(/^(\d{1,3})\./);
    let trackNum = Number.MAX_SAFE_INTEGER;
    
    if (looseTrackMatch) {
      const parsed = Number.parseInt(looseTrackMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        trackNum = parsed;
      }
    } else {
      // 3. Try reading track number from metadata
      const metaTrack = Number.parseInt(row.trackNumber || '', 10);
      if (Number.isFinite(metaTrack) && metaTrack > 0) {
        trackNum = metaTrack;
      }
    }

    return {
      track: trackNum,
      artist: 'Unbekannter Interpret',
      title: fileStem || 'Unbekannter Titel',
      fileStem,
    };
  };
  const parseDiscFromPath = (uri: string): number => {
    const normalizedPath = decodeURIComponent(getLibraryPathFromUri(uri)).toLowerCase();
    const segments = normalizedPath.split('/').filter(Boolean);
    for (const segment of segments) {
      const discMatch = segment.match(/^(?:cd|disc)\s*0*(\d{1,2})$/i);
      if (discMatch) {
        const parsedDisc = Number.parseInt(discMatch[1], 10);
        if (Number.isFinite(parsedDisc) && parsedDisc > 0) {
          return parsedDisc;
        }
      }
    }
    return 1; // Default to CD 1 if no disc folder is found
  };
  if (mode === 'albums') {
    const byFolder = new Map<string, IAudioFileMetadata[]>();
    metadataRows.forEach((row) => {
      const folderKey = getAlbumFolderKeyFromUri(row.uri, rootUris);
      byFolder.set(folderKey, [...(byFolder.get(folderKey) || []), row]);
    });
    return Array.from(byFolder.entries()).map(([folderKey, rows]) => {
      const first = rows[0];
      const folderLabel = decodeURIComponent(folderKey.split('/').pop() || 'Ordner');
      
      // Determine the most frequent artist to represent the "Album Artist"
      // instead of hardcoding 'Various Artists'
      const artistCounts = new Map<string, number>();
      rows.forEach((row) => {
        const artist = String(row.artist || '').trim();
        if (artist) {
          artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
        }
      });
      let bestArtist = 'Unbekannter Interpret';
      let maxCount = 0;
      artistCounts.forEach((count, artist) => {
        if (count > maxCount) {
          maxCount = count;
          bestArtist = artist;
        }
      });
      // Gather all distinct artworks in this album folder
      const distinctArtworks = Array.from(new Set(rows.map((row) => row.artworkUri).filter((uri): uri is string => !!uri)));
      const isMixedAlbum = artistCounts.size > 1 && distinctArtworks.length > 1;
      
      const subtitle = isMixedAlbum ? 'Various Artists' : bestArtist;

      // Attempt to get Album title from metadata of the first track
      // If it exists, use it, otherwise use folder name
      let albumTitle = String(first.album || '').trim();
      if (!albumTitle) {
         albumTitle = folderLabel || 'Ordner';
      }

      return {
        id: `album:${folderKey}`,
        title: albumTitle,
        subtitle,
        meta: folderKey,
        artworkUri: isMixedAlbum ? undefined : first.artworkUri,
        mosaicArtworks: isMixedAlbum ? distinctArtworks.slice(0, 4) : undefined,
        sourceUri: folderKey,
        collectionType: 'album' as const,
      } as ILauncherListItem;
    }).sort((left, right) => {
      const artistCompare = (left.subtitle || '').localeCompare(right.subtitle || '', 'de', { sensitivity: 'base' });
      if (artistCompare !== 0) {
        return artistCompare;
      }
      return (left.title || '').localeCompare(right.title || '', 'de', { sensitivity: 'base' });
    });
  }
  if (mode === 'playlists') {
    return [];
  }
  const sortedRows = metadataRows
    .slice()
    .sort((left, right) => {
      const leftPath = getLibraryPathFromUri(left.uri);
      const rightPath = getLibraryPathFromUri(right.uri);
      
      // Compare the entire path naturally.
      // This perfectly handles:
      // 1. Folder grouping (all tracks in same folder stay together)
      // 2. CD1 vs CD2 (CD1 comes before CD2 because "C" < "C" and "1" < "2")
      // 3. Track numbers in filename (01... comes before 02...)
      return leftPath.localeCompare(rightPath, 'de', { numeric: true, sensitivity: 'base' });
    });

  // Calculate strict sequential track numbers per album folder
  const trackCounters = new Map<string, number>();
  
  // Track CD changes to insert headers
  const cdHeaders = new Set<string>();
  const items: ILauncherListItem[] = [];

  sortedRows.forEach((row) => {
    const albumFolderKey = getAlbumFolderKeyFromUri(row.uri, rootUris);
    const descriptor = parseFileDescriptor(row);
    const cdNum = parseDiscFromPath(row.uri);
    const pathSegments = getLibraryPathFromUri(row.uri).split('/').filter(Boolean);
    const folderSegments = pathSegments.slice(0, -1);
    const hasCdFolder = folderSegments.some((segment) => /^(?:cd|disc)\s*0*\d{1,2}$/i.test(segment));

    const cdHeaderKey = `${albumFolderKey}::CD${cdNum}`;
    if (hasCdFolder && !cdHeaders.has(cdHeaderKey)) {
      cdHeaders.add(cdHeaderKey);
      items.push({
        id: cdHeaderKey,
        title: `CD ${cdNum}`,
        subtitle: '',
        meta: albumFolderKey,
        collectionType: 'cd-header' as const,
      });
      // Reset track counter for new CD
      trackCounters.set(cdHeaderKey, 0);
    }
    
    // Use CD-specific counter if we have CDs, otherwise album counter
    const counterKey = hasCdFolder ? cdHeaderKey : albumFolderKey;
    const currentCount = (trackCounters.get(counterKey) || 0) + 1;
    trackCounters.set(counterKey, currentCount);

    items.push({
      id: `${row.uri}::${albumFolderKey}`,
      title: String(row.title || '').trim() || descriptor.title,
      subtitle: String(row.artist || '').trim() || descriptor.artist,
      meta: albumFolderKey,
      durationMs: Number.parseInt(row.durationMs || '0', 10) || 0,
      trackNumber: currentCount,
      artworkUri: row.artworkUri,
      sourceUri: row.uri,
      collectionType: 'track' as const,
    });
  });
  
  return items;
};

const mapPlaylistEntriesToItems = (
  playlistEntries: IPlaylistEntry[],
  metadataRows: IAudioFileMetadata[],
): ILauncherListItem[] => {
  const rowsByUri = new Map(metadataRows.map((row) => [row.uri, row]));
  return playlistEntries
    .map((entry) => {
      const resolvedRows = entry.trackUris
        .map((uri) => rowsByUri.get(uri))
        .filter((row): row is IAudioFileMetadata => !!row);
      const uniqueArtists = new Set(resolvedRows.map((row) => row.artist).filter(Boolean));
      const uniqueAlbums = new Set(resolvedRows.map((row) => row.album).filter(Boolean));
      const fileName = decodeURIComponent(entry.displayName || '')
        .replace(/\.m3u8?$/i, '')
        .trim();
      const subtitleParts = [`${entry.trackUris.length} Titel`];
      if (uniqueArtists.size > 0) {
        subtitleParts.push(`${uniqueArtists.size} Künstler`);
      }
      if (uniqueAlbums.size > 0) {
        subtitleParts.push(`${uniqueAlbums.size} Alben`);
      }
      return {
        id: `playlist:${entry.uri}`,
        title: fileName || 'Playlist',
        subtitle: subtitleParts.join(' · '),
        meta: entry.uri,
        artworkUri: resolvedRows[0]?.artworkUri,
        sourceUri: entry.uri,
        collectionType: 'playlist' as const,
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title, 'de'));
};

interface ILibraryCacheSnapshot {
  rootsKey: string;
  rowsByUri: Record<string, IAudioFileMetadata>;
  lastModifiedByUri: Record<string, number>;
  playlistEntries?: IPlaylistEntry[];
}

export default function PulseLauncherRedesign() {
  const dimensions = useWindowDimensions();
  const colorScheme = useColorScheme();
  const compact = dimensions.width < 390 || dimensions.height < 760;
  const themeMode: AuroraThemeMode = colorScheme === 'dark' ? 'dark' : 'light';
  const theme = useMemo(() => getAuroraTheme(themeMode), [themeMode]);
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;
  const bottomInset = Platform.OS === 'android' ? 12 : 0;
  const styles = useMemo(() => createStyles(theme, compact, topInset, bottomInset), [theme, compact, topInset, bottomInset]);
  const language = useMemo(() => getSystemLanguage(), []);
  const t = useCallback(
    (key: string, fallbackText: string, vars?: Record<string, string | number>) => translate(language, key, fallbackText, vars),
    [language],
  );

  const [mainTab, setMainTab] = useState<MainTab>('library');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('albums');
  const [libraryItems, setLibraryItems] = useState<ILauncherListItem[]>([]);
  const [settingsItems, setSettingsItems] = useState<ILauncherListItem[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [contentReason, setContentReason] = useState<'not-android' | 'module-missing' | 'module-error' | undefined>(undefined);

  const [apps, setApps] = useState<IInstalledLauncherApp[]>([]);
  const [appsSearch, setAppsSearch] = useState('');
  const [loadingApps, setLoadingApps] = useState(false);
  const [appsReason, setAppsReason] = useState<'not-android' | 'module-missing' | 'module-error' | undefined>(undefined);
  const [appsLoadedOnce, setAppsLoadedOnce] = useState(false);
  const [refreshingApps, setRefreshingApps] = useState(false);

  const [showLauncherPrompt, setShowLauncherPrompt] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsVisible, setNotificationsVisible] = useState(false);
  const [notifications, setNotifications] = useState<ILauncherNotification[]>([]);
  const [notificationAccessGranted, setNotificationAccessGranted] = useState(false);
  const [notificationAllowlistPackages, setNotificationAllowlistPackages] = useState<string[]>([]);
  const [selectedLibraryDirectoryUris, setSelectedLibraryDirectoryUris] = useState<string[]>([]);
  const [refreshingLibrary, setRefreshingLibrary] = useState(false);
  const [libraryReloadToken, setLibraryReloadToken] = useState(0);
  const [libraryMetadataRows, setLibraryMetadataRows] = useState<IAudioFileMetadata[]>([]);
  const [playlistEntries, setPlaylistEntries] = useState<IPlaylistEntry[]>([]);
  const [albumTitleFilter, setAlbumTitleFilter] = useState<string | undefined>(undefined);
  const [albumSourceFolderFilter, setAlbumSourceFolderFilter] = useState<string | undefined>(undefined);
  const [albumFolderFilterLabel, setAlbumFolderFilterLabel] = useState<string | undefined>(undefined);
  const [playlistUriFilter, setPlaylistUriFilter] = useState<string | undefined>(undefined);
  const [playerState, setPlayerState] = useState<'playing' | 'paused'>('paused');
  const [playerTrack, setPlayerTrack] = useState('Aurora Pulse');
  const [playerMeta, setPlayerMeta] = useState(t('common.noPlayback', 'Keine Wiedergabe'));
  const [playerArtworkUri, setPlayerArtworkUri] = useState<string | undefined>(undefined);
  const [playerPositionMs, setPlayerPositionMs] = useState(0);
  const [playerDurationMs, setPlayerDurationMs] = useState(0);
  const [playerProgressWidth, setPlayerProgressWidth] = useState(0);
  const [playerTitleContainerWidth, setPlayerTitleContainerWidth] = useState(0);
  const [playerTitleTextWidth, setPlayerTitleTextWidth] = useState(0);
  const [playQueue, setPlayQueue] = useState<ILauncherListItem[]>([]);
  const [playQueueIndex, setPlayQueueIndex] = useState(-1);
  const [libraryDebugInfo, setLibraryDebugInfo] = useState('');
  const [equalizerOpen, setEqualizerOpen] = useState(false);
  const [equalizerSettings, setEqualizerSettings] = useState<IEqualizerSettings>(createDefaultEqualizerSettings());
  const [equalizerMessage, setEqualizerMessage] = useState('');
  const [settingsInfoOpen, setSettingsInfoOpen] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const queueRef = useRef<ILauncherListItem[]>([]);
  const queueIndexRef = useRef(-1);
  const pendingDlnaTrackRef = useRef<ILauncherListItem | null>(null);
  const currentPlayingUriRef = useRef<string>('');
  const isDlnaSessionRef = useRef(false);
  const dlnaPlaybackSwitchInFlightRef = useRef(false);
  const dlnaQueueRef = useRef<ILauncherListItem[]>([]);
  const dlnaQueueIndexRef = useRef(-1);
  const dlnaContextIdRef = useRef('');
  const notificationsAnim = useRef(new Animated.Value(0)).current;
  const playerTitleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const normalizeDlnaUri = (value: string): string => {
      const raw = String(value || '').trim();
      if (!raw) {
        return '';
      }
      try {
        const parsed = new URL(raw);
        const normalizedPath = decodeURIComponent(parsed.pathname || '');
        return `${parsed.protocol}//${parsed.host}${normalizedPath}`;
      } catch (_error) {
        return decodeURIComponent(raw);
      }
    };
    const decodeDlnaText = (value: string): string => {
      let result = String(value || '');
      for (let index = 0; index < 3; index += 1) {
        const decoded = result
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, '\'')
          .replace(/&#39;/g, '\'')
          .replace(/&#x27;/g, '\'')
          .replace(/&amp;/g, '&');
        if (decoded === result) {
          return decoded;
        }
        result = decoded;
      }
      return result;
    };
    const subs = [
      DLNAControlEventEmitter.addListener('DLNA_SET_URI', (payload: { uri?: string; title?: string; artist?: string; albumArt?: string }) => {
        const uri = String(payload?.uri || '').trim();
        if (!uri) {
          return;
        }
        const title = decodeDlnaText(String(payload?.title || 'DLNA Stream')).trim();
        const artist = decodeDlnaText(String(payload?.artist || 'External')).trim();
        const albumArt = String(payload?.albumArt || '').trim();
        const track: ILauncherListItem = {
          id: `dlna:${uri}`,
          title,
          subtitle: artist || 'External',
          sourceUri: uri,
          artworkUri: albumArt || undefined,
          collectionType: 'track',
        };
        const existingIndex = dlnaQueueRef.current.findIndex((item) => (item.sourceUri || item.id) === uri);
        if (existingIndex >= 0) {
          dlnaQueueRef.current[existingIndex] = track;
          dlnaQueueIndexRef.current = existingIndex;
        } else {
          dlnaQueueRef.current = [...dlnaQueueRef.current, track];
          dlnaQueueIndexRef.current = dlnaQueueRef.current.length - 1;
        }
        queueRef.current = dlnaQueueRef.current;
        queueIndexRef.current = dlnaQueueIndexRef.current;
        setPlayQueue([...dlnaQueueRef.current]);
        setPlayQueueIndex(dlnaQueueIndexRef.current);
        console.log('[DLNA][UI] SET_URI', {
          uri,
          queueSize: dlnaQueueRef.current.length,
          queueIndex: dlnaQueueIndexRef.current,
          contextId: dlnaContextIdRef.current,
        });
        pendingDlnaTrackRef.current = track;
        isDlnaSessionRef.current = true;
        setPlayerTrack(track.title);
        setPlayerMeta(track.subtitle || 'External');
        setPlayerArtworkUri(track.artworkUri);
      }),
      DLNAControlEventEmitter.addListener('DLNA_SET_NEXT_URI', (payload: { uri?: string; title?: string; artist?: string; albumArt?: string }) => {
        const uri = String(payload?.uri || '').trim();
        if (!uri) {
          return;
        }
        const track: ILauncherListItem = {
          id: `dlna:${uri}`,
          title: decodeDlnaText(String(payload?.title || 'Nächster Track')).trim() || 'Nächster Track',
          subtitle: decodeDlnaText(String(payload?.artist || 'External')).trim() || 'External',
          sourceUri: uri,
          artworkUri: String(payload?.albumArt || '').trim() || undefined,
          collectionType: 'track',
        };
        const currentIndex = Math.max(0, dlnaQueueIndexRef.current);
        const withoutExisting = dlnaQueueRef.current.filter((item) => (item.sourceUri || item.id) !== uri);
        const insertIndex = Math.min(currentIndex + 1, withoutExisting.length);
        dlnaQueueRef.current = [
          ...withoutExisting.slice(0, insertIndex),
          track,
          ...withoutExisting.slice(insertIndex),
        ];
        queueRef.current = dlnaQueueRef.current;
        queueIndexRef.current = Math.min(currentIndex, dlnaQueueRef.current.length - 1);
        setPlayQueue([...dlnaQueueRef.current]);
        setPlayQueueIndex(queueIndexRef.current);
        console.log('[DLNA][UI] SET_NEXT_URI', {
          uri,
          queueSize: dlnaQueueRef.current.length,
          queueIndex: queueIndexRef.current,
          contextId: dlnaContextIdRef.current,
        });
      }),
      DLNAControlEventEmitter.addListener('DLNA_QUEUE_CONTEXT', (payload: { json?: string }) => {
        const raw = String(payload?.json || '').trim();
        if (!raw) {
          return;
        }
        try {
          const parsed = JSON.parse(raw) as {
            tracks?: Array<{ uri?: string; title?: string; artist?: string; albumArt?: string }>;
            currentIndex?: number;
            contextId?: string;
          };
          const tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
          const normalizedQueue: ILauncherListItem[] = tracks
            .map((track) => {
              const uri = String(track?.uri || '').trim();
              if (!uri) {
                return undefined;
              }
              const title = decodeDlnaText(String(track?.title || 'DLNA Stream')).trim() || 'DLNA Stream';
              const artist = decodeDlnaText(String(track?.artist || 'External')).trim() || 'External';
              const albumArt = String(track?.albumArt || '').trim();
              return {
                id: `dlna:${uri}`,
                title,
                subtitle: artist,
                sourceUri: uri,
                artworkUri: albumArt || undefined,
                collectionType: 'track',
              } as ILauncherListItem;
            })
            .filter(Boolean) as ILauncherListItem[];
          if (normalizedQueue.length === 0) {
            return;
          }
          const nextContextId = String(parsed.contextId || '').trim();
          if (normalizedQueue.length === 1 && dlnaQueueRef.current.length > 1) {
            console.log('[DLNA][UI] QUEUE_CONTEXT_IGNORED_SHRINK', {
              contextId: nextContextId,
              incomingQueueSize: normalizedQueue.length,
              currentQueueSize: dlnaQueueRef.current.length,
            });
            return;
          }
          if (nextContextId) {
            dlnaContextIdRef.current = nextContextId;
          }
          const currentIndex = Math.max(0, Math.min(normalizedQueue.length - 1, Number(parsed.currentIndex || 0)));
          dlnaQueueRef.current = normalizedQueue;
          dlnaQueueIndexRef.current = currentIndex;
          queueRef.current = normalizedQueue;
          queueIndexRef.current = currentIndex;
          setPlayQueue([...normalizedQueue]);
          setPlayQueueIndex(currentIndex);
          console.log('[DLNA][UI] QUEUE_CONTEXT_APPLIED', {
            contextId: nextContextId || dlnaContextIdRef.current,
            queueSize: normalizedQueue.length,
            currentIndex,
          });
          pendingDlnaTrackRef.current = normalizedQueue[currentIndex];
          setPlayerTrack(normalizedQueue[currentIndex].title);
          setPlayerMeta(normalizedQueue[currentIndex].subtitle || 'External');
          setPlayerArtworkUri(normalizedQueue[currentIndex].artworkUri);
        } catch (_error) {
        }
      }),
      DLNAControlEventEmitter.addListener('DLNA_PLAY', () => {
        setTimeout(() => {
          if (dlnaPlaybackSwitchInFlightRef.current) {
            return;
          }
          setMainTab('player');
          const pendingTrack = pendingDlnaTrackRef.current;
          const activeQueue = dlnaQueueRef.current.length > 0 ? dlnaQueueRef.current : queueRef.current;
          if (pendingTrack) {
            const pendingUri = String(pendingTrack.sourceUri || pendingTrack.id);
            const currentUri = String(currentPlayingUriRef.current || '');
            if (pendingUri && pendingUri !== currentUri) {
              const normalizedPendingUri = normalizeDlnaUri(pendingUri);
              const targetIndex = activeQueue.findIndex((item) => {
                const itemUri = String(item.sourceUri || item.id);
                return itemUri === pendingUri || normalizeDlnaUri(itemUri) === normalizedPendingUri;
              });
              if (targetIndex >= 0) {
                void playTrackAtIndex(activeQueue, targetIndex);
              } else {
                const queueFallbackIndex = Math.max(0, Math.min(activeQueue.length - 1, dlnaQueueIndexRef.current));
                if (activeQueue.length > 0) {
                  void playTrackAtIndex(activeQueue, queueFallbackIndex);
                } else {
                  void playTrackAtIndex([pendingTrack], 0);
                }
              }
              return;
            }
          }
          if (!soundRef.current && pendingTrack) {
            const queueFallbackIndex = Math.max(0, Math.min(activeQueue.length - 1, dlnaQueueIndexRef.current));
            if (activeQueue.length > 0) {
              void playTrackAtIndex(activeQueue, queueFallbackIndex);
            } else {
              void playTrackAtIndex([pendingTrack], 0);
            }
            return;
          }
          void playPlayer();
        }, 180);
      }),
      DLNAControlEventEmitter.addListener('DLNA_PAUSE', () => {
        void pausePlayer();
      }),
      DLNAControlEventEmitter.addListener('DLNA_STOP', () => {
        void pausePlayer();
      }),
      DLNAControlEventEmitter.addListener('DLNA_NEXT', () => {
        void nextTrack();
      }),
      DLNAControlEventEmitter.addListener('DLNA_PREVIOUS', () => {
        void prevTrack();
      }),
      DLNAControlEventEmitter.addListener('DLNA_FORWARD', () => {
        void nextTrack();
      }),
      DLNAControlEventEmitter.addListener('DLNA_REWIND', () => {
        void prevTrack();
      }),
      DLNAControlEventEmitter.addListener('DLNA_CONNECTION_LOST', () => {
        if (!isDlnaSessionRef.current) {
          return;
        }
        const sound = soundRef.current;
        if (!sound) {
          return;
        }
        sound.stopAsync()
          .then(() => {
            setPlayerState('paused');
            setPlayerPositionMs(0);
          })
          .catch(() => undefined);
      }),
      DLNAControlEventEmitter.addListener('DLNA_SET_VOLUME', (payload: { volume?: string }) => {
        const nextVolume = Number(payload?.volume);
        if (!Number.isFinite(nextVolume) || !soundRef.current) {
          return;
        }
        void soundRef.current.setVolumeAsync(Math.max(0, Math.min(1, nextVolume / 100)));
      }),
      DLNAControlEventEmitter.addListener('DLNA_SEEK', (payload: { target?: string }) => {
        const parts = String(payload?.target || '00:00:00').split(':');
        if (parts.length !== 3 || !soundRef.current) {
          return;
        }
        const nextMs = ((Number(parts[0]) * 3600) + (Number(parts[1]) * 60) + Number(parts[2])) * 1000;
        if (Number.isFinite(nextMs) && nextMs >= 0) {
          void soundRef.current.setPositionAsync(nextMs);
        }
      }),
    ];
    return () => {
      subs.forEach((sub) => sub.remove());
    };
  }, []);


  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    let active = true;
    AsyncStorage.getItem(DEFAULT_LAUNCHER_PROMPT_STORAGE_KEY)
      .then((value) => {
        if (active && value !== '1') {
          setShowLauncherPrompt(true);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    loadEqualizerSettings()
      .then((settings) => {
        if (active) {
          setEqualizerSettings(settings);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(MUSIC_LIBRARY_DIRECTORY_STORAGE_KEY)
      .then((value) => {
        if (!active || !value) {
          return;
        }
        try {
          const parsedUris = sanitizeDirectoryUris(JSON.parse(value) as string[]);
          if (parsedUris.length > 0) {
            setSelectedLibraryDirectoryUris(parsedUris);
            return;
          }
        } catch (_error) {
        }
        if (value.startsWith('content://')) {
          setSelectedLibraryDirectoryUris([value]);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (mainTab === 'apps' || mainTab === 'player') {
      return;
    }
    let active = true;
    const loadData = async () => {
      if (mainTab === 'settings') {
        setLoadingContent(true);
        const result = await loadRouteSections(resolveRoute(mainTab, libraryMode));
        if (!active) {
          return;
        }
        const flatItems = result.sections.flatMap((section) => section.items);
        const baseSettings = flatItems.filter(isSettingItem);
        const sortedSettings = [...baseSettings].sort((left, right) => {
          const leftKey = `${left.title} ${left.subtitle}`.toLowerCase();
          const rightKey = `${right.title} ${right.subtitle}`.toLowerCase();
          const leftScore = leftKey.includes('bibliothek') || leftKey.includes('library')
            ? 0
            : leftKey.includes('dlna')
              ? 1
              : leftKey.includes('audio') || leftKey.includes('equalizer')
                ? 2
                : leftKey.includes('theme') || leftKey.includes('design')
                  ? 3
                  : 4;
          const rightScore = rightKey.includes('bibliothek') || rightKey.includes('library')
            ? 0
            : rightKey.includes('dlna')
              ? 1
              : rightKey.includes('audio') || rightKey.includes('equalizer')
                ? 2
                : rightKey.includes('theme') || rightKey.includes('design')
                  ? 3
                  : 4;
          if (leftScore !== rightScore) {
            return leftScore - rightScore;
          }
          return left.title.localeCompare(right.title, 'de');
        });
        setSettingsItems([
          ...sortedSettings,
          {
            id: 'set-restart-app',
            title: 'App neu starten',
            subtitle: 'Launcher neu laden',
            meta: 'Neustart',
            collectionType: 'setting',
          },
        ]);
        setContentReason(result.reason);
        return;
      }
      if (selectedLibraryDirectoryUris.length === 0) {
        if (active) {
          setLibraryItems([]);
          setLibraryMetadataRows([]);
          setPlaylistEntries([]);
          setContentReason(undefined);
          setLibraryDebugInfo('Keine Bibliotheksordner ausgewählt');
          setLoadingContent(false);
        }
        return;
      }
      const mediaPermission = await MediaLibrary.getPermissionsAsync();
      if (!mediaPermission.granted) {
        const requestedPermission = await MediaLibrary.requestPermissionsAsync();
        if (!requestedPermission.granted) {
          if (active) {
            setLibraryItems([]);
            setLibraryMetadataRows([]);
            setContentReason('module-error');
            setLibraryDebugInfo('Audio-Berechtigung fehlt. Bitte Medienzugriff erlauben.');
            setLoadingContent(false);
          }
          return;
        }
      }
      const rootsKey = [...selectedLibraryDirectoryUris].sort().join('|');
      const cachedRaw = await AsyncStorage.getItem(MUSIC_LIBRARY_CACHE_STORAGE_KEY).catch(() => null);
      let cachedRowsByUri: Record<string, IAudioFileMetadata> = {};
      let cachedLastModifiedByUri: Record<string, number> = {};
      let cachedPlaylistEntries: IPlaylistEntry[] = [];
      if (cachedRaw) {
        try {
          const cacheSnapshot = JSON.parse(cachedRaw) as ILibraryCacheSnapshot;
          if (cacheSnapshot.rootsKey === rootsKey) {
            cachedRowsByUri = cacheSnapshot.rowsByUri || {};
            cachedLastModifiedByUri = cacheSnapshot.lastModifiedByUri || {};
            cachedPlaylistEntries = cacheSnapshot.playlistEntries || [];
          }
        } catch (_error) {
          cachedRowsByUri = {};
          cachedLastModifiedByUri = {};
          cachedPlaylistEntries = [];
        }
      }
      if (active && cachedPlaylistEntries.length > 0) {
        setPlaylistEntries(cachedPlaylistEntries);
      }
      const hasCachedRows = Object.keys(cachedRowsByUri).length > 0;
      if (!hasCachedRows) {
        setLoadingContent(true);
      }
      if (active && hasCachedRows) {
        const cachedRows = Object.values(cachedRowsByUri);
        setLibraryMetadataRows(cachedRows);
        const baseItems = libraryMode === 'playlists'
          ? mapPlaylistEntriesToItems(cachedPlaylistEntries, cachedRows)
          : mapMetadataToLibraryItems(cachedRows, libraryMode, selectedLibraryDirectoryUris);
        const filteredItems = (libraryMode === 'titles' && albumSourceFolderFilter)
          ? baseItems.filter((item) => {
            const uri = item.sourceUri || item.id;
            return isTrackInFolder(uri, albumSourceFolderFilter);
          })
          : (libraryMode === 'titles' && albumTitleFilter)
          ? baseItems.filter((item) => item.meta === albumTitleFilter)
          : baseItems;
        setLibraryItems(filteredItems);
        setLoadingContent(false);
      }
      const [listResult, playlistResult] = await Promise.all([
        listAudioEntriesFromRoots(selectedLibraryDirectoryUris),
        listPlaylistEntriesFromRoots(selectedLibraryDirectoryUris),
      ]);
      if (!active) {
        return;
      }
      setPlaylistEntries(playlistResult.entries);
      const toItems = (rows: IAudioFileMetadata[]) => (
        libraryMode === 'playlists'
          ? mapPlaylistEntriesToItems(playlistResult.entries, rows)
          : mapMetadataToLibraryItems(rows, libraryMode, selectedLibraryDirectoryUris)
      );
      if (listResult.entries.length === 0 && listResult.visitedNodes === 0 && listResult.readErrors > 0) {
        const fallbackUris = await collectUrisWithSafFallback(selectedLibraryDirectoryUris);
        if (!active) {
          return;
        }
        const fallbackRows = await loadMetadataForUrisChunked(fallbackUris.slice(0, 2500));
        if (!active) {
          return;
        }
        const fallbackDebugLine = `Roots: ${selectedLibraryDirectoryUris.length} · Nodes: 0 · Leafs: ${fallbackUris.length} · ReadErrors: ${listResult.readErrors} · MetadataRows: ${fallbackRows.length} · Delta: fallback · LastError: ${listResult.lastError || '-'}`;
        console.log(`[PulseLibraryScan] ${fallbackDebugLine}`);
        setLibraryDebugInfo(fallbackDebugLine);
        setLibraryMetadataRows(fallbackRows);
        const fallbackBaseItems = toItems(fallbackRows);
        const fallbackFilteredItems = (libraryMode === 'titles' && albumSourceFolderFilter)
          ? fallbackBaseItems.filter((item) => {
            const uri = item.sourceUri || item.id;
            return isTrackInFolder(uri, albumSourceFolderFilter);
          })
          : (libraryMode === 'titles' && albumTitleFilter)
          ? fallbackBaseItems.filter((item) => item.meta === albumTitleFilter)
          : fallbackBaseItems;
        setLibraryItems(fallbackFilteredItems);
        setContentReason(undefined);
        return;
      }
      if (listResult.entries.length === 0 && listResult.leafNodes > 0) {
        const fallbackUris = await collectUrisWithSafFallback(selectedLibraryDirectoryUris);
        if (!active) {
          return;
        }
        const fallbackRows = await loadMetadataForUrisChunked(fallbackUris.slice(0, 2500));
        if (!active) {
          return;
        }
        const fallbackDebugLine = `Roots: ${selectedLibraryDirectoryUris.length} · Nodes: ${listResult.visitedNodes} · Leafs: ${listResult.leafNodes} · ReadErrors: ${listResult.readErrors} · MetadataRows: ${fallbackRows.length} · Delta: saf-leaf-fallback · LastError: ${listResult.lastError || '-'}`;
        console.log(`[PulseLibraryScan] ${fallbackDebugLine}`);
        setLibraryDebugInfo(fallbackDebugLine);
        setLibraryMetadataRows(fallbackRows);
        const fallbackBaseItems = toItems(fallbackRows);
        const fallbackFilteredItems = (libraryMode === 'titles' && albumSourceFolderFilter)
          ? fallbackBaseItems.filter((item) => {
            const uri = item.sourceUri || item.id;
            return isTrackInFolder(uri, albumSourceFolderFilter);
          })
          : (libraryMode === 'titles' && albumTitleFilter)
          ? fallbackBaseItems.filter((item) => item.meta === albumTitleFilter)
          : fallbackBaseItems;
        setLibraryItems(fallbackFilteredItems);
        setContentReason(undefined);
        return;
      }
      const currentLastModifiedByUri: Record<string, number> = {};
      listResult.entries.forEach((entry) => {
        currentLastModifiedByUri[entry.uri] = entry.lastModified || 0;
      });
      const changedUris = listResult.entries
        .filter((entry) => {
          const cachedRow = cachedRowsByUri[entry.uri];
          if (!cachedRow) {
            return true;
          }
          return (cachedLastModifiedByUri[entry.uri] || 0) !== (entry.lastModified || 0);
        })
        .map((entry) => entry.uri);
      const changedRows = changedUris.length > 0 ? await loadMetadataForUrisChunked(changedUris) : [];
      const changedRowsByUri = changedRows.reduce<Record<string, IAudioFileMetadata>>((acc, row) => {
        acc[row.uri] = row;
        return acc;
      }, {});
      const mergedRowsByUri: Record<string, IAudioFileMetadata> = {};
      listResult.entries.forEach((entry) => {
        const changedRow = changedRowsByUri[entry.uri];
        if (changedRow) {
          mergedRowsByUri[entry.uri] = changedRow;
          return;
        }
        const cachedRow = cachedRowsByUri[entry.uri];
        if (cachedRow) {
          mergedRowsByUri[entry.uri] = cachedRow;
          return;
        }
        mergedRowsByUri[entry.uri] = {
          uri: entry.uri,
          title: entry.displayName || entry.uri.split('/').pop() || 'Unbekannter Titel',
          artist: '',
          album: '',
          durationMs: '',
          mimeType: entry.mimeType || '',
          sourceLastModified: String(entry.lastModified || 0),
        };
      });
      const orderedRows = listResult.entries
        .map((entry) => mergedRowsByUri[entry.uri])
        .filter((row): row is IAudioFileMetadata => !!row);
      const debugLine = `Roots: ${selectedLibraryDirectoryUris.length} · Nodes: ${listResult.visitedNodes} · Leafs: ${listResult.leafNodes} · ReadErrors: ${listResult.readErrors} · MetadataRows: ${orderedRows.length} · Delta: ${changedUris.length} · LastError: ${listResult.lastError || '-'}`;
      console.log(`[PulseLibraryScan] ${debugLine}`);
      setLibraryDebugInfo(
        debugLine,
      );
      setLibraryMetadataRows(orderedRows);
      const baseItems = toItems(orderedRows);
      const filteredItems = (libraryMode === 'titles' && albumSourceFolderFilter)
        ? baseItems.filter((item) => {
          const uri = item.sourceUri || item.id;
          return isTrackInFolder(uri, albumSourceFolderFilter);
        })
        : (libraryMode === 'titles' && albumTitleFilter)
        ? baseItems.filter((item) => item.meta === albumTitleFilter)
        : baseItems;
      setLibraryItems(filteredItems);
      const cacheSnapshot: ILibraryCacheSnapshot = {
        rootsKey,
        rowsByUri: mergedRowsByUri,
        lastModifiedByUri: currentLastModifiedByUri,
        playlistEntries: playlistResult.entries,
      };
      AsyncStorage.setItem(MUSIC_LIBRARY_CACHE_STORAGE_KEY, JSON.stringify(cacheSnapshot)).catch(() => undefined);
      setContentReason(undefined);
    };
    loadData()
      .catch(() => {
        if (active) {
          setLibraryItems([]);
          setContentReason('module-error');
          setLibraryDebugInfo('Lese-/Metadatenfehler beim Scan');
        }
      })
      .finally(() => {
        if (active) {
          setLoadingContent(false);
        }
      });
    return () => {
      active = false;
    };
  }, [mainTab, selectedLibraryDirectoryUris, libraryReloadToken]);

  useEffect(() => {
    if (mainTab !== 'apps') {
      return;
    }
    if (appsLoadedOnce) {
      return;
    }
    let active = true;
    setLoadingApps(true);
    loadInstalledLauncherApps()
      .then((result) => {
        if (!active) {
          return;
        }
        setApps(result.apps);
        setAppsReason(result.reason);
        setAppsLoadedOnce(true);
      })
      .finally(() => {
        if (active) {
          setLoadingApps(false);
        }
      });
    return () => {
      active = false;
    };
  }, [mainTab, appsLoadedOnce]);

  useEffect(() => {
    if (!loadingContent && refreshingLibrary) {
      setRefreshingLibrary(false);
    }
  }, [loadingContent, refreshingLibrary]);

  useEffect(() => {
    playerTitleAnim.stopAnimation();
    const shouldScroll = playerTitleTextWidth > playerTitleContainerWidth && playerTitleContainerWidth > 0;
    if (!shouldScroll) {
      playerTitleAnim.setValue(0);
      return;
    }
    const travelDistance = Math.max(24, playerTitleTextWidth - playerTitleContainerWidth + 28);
    const duration = Math.max(4400, Math.round(travelDistance * 42));
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(520),
        Animated.timing(playerTitleAnim, {
          toValue: 1,
          duration,
          useNativeDriver: true,
        }),
        Animated.delay(360),
        Animated.timing(playerTitleAnim, {
          toValue: 0,
          duration,
          useNativeDriver: true,
        }),
        Animated.delay(420),
      ]),
    );
    playerTitleAnim.setValue(0);
    animation.start();
    return () => {
      animation.stop();
      playerTitleAnim.stopAnimation();
    };
  }, [playerTrack, playerTitleTextWidth, playerTitleContainerWidth, playerTitleAnim]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(NOTIFICATION_ALLOWLIST_STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) {
          return;
        }
        try {
          const parsed = JSON.parse(raw) as string[];
          if (Array.isArray(parsed)) {
            setNotificationAllowlistPackages(parsed.filter(Boolean));
          }
        } catch (_error) {
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    isNotificationAccessGranted()
      .then((granted) => setNotificationAccessGranted(granted))
      .catch(() => setNotificationAccessGranted(false));
    const postedSub = notificationEvents.addPostedListener?.((payload: ISystemNotificationNativeItem) => {
      setNotifications((current) => {
        if (
          notificationAllowlistPackages.length > 0
          && !notificationAllowlistPackages.includes(payload.packageName)
        ) {
          return current;
        }
        const next = current.filter((entry) => entry.id !== payload.notificationKey);
        next.unshift({
          id: payload.notificationKey,
          packageName: payload.packageName,
          appName: payload.appName,
          title: payload.title,
          message: payload.message,
        });
        return next.slice(0, 80);
      });
    });
    const removedSub = notificationEvents.addRemovedListener?.((payload: { notificationKey: string }) => {
      setNotifications((current) => current.filter((entry) => entry.id !== payload.notificationKey));
    });
    const snapshotSub = notificationEvents.addSnapshotListener?.((payload: { items: ISystemNotificationNativeItem[] }) => {
      const mapped = payload.items
        .filter((item) => notificationAllowlistPackages.length === 0 || notificationAllowlistPackages.includes(item.packageName))
        .map((item) => ({
          id: item.notificationKey,
          packageName: item.packageName,
          appName: item.appName,
          title: item.title,
          message: item.message,
        }));
      setNotifications(mapped);
    });
    return () => {
      postedSub?.remove();
      removedSub?.remove();
      snapshotSub?.remove();
    };
  }, [notificationAllowlistPackages]);

  useEffect(() => {
    const localPlaylistTrackSet = playlistUriFilter
      ? new Set((playlistEntries.find((entry) => entry.uri === playlistUriFilter)?.trackUris) || [])
      : undefined;
    const baseItems = libraryMode === 'playlists'
      ? mapPlaylistEntriesToItems(playlistEntries, libraryMetadataRows)
      : mapMetadataToLibraryItems(libraryMetadataRows, libraryMode, selectedLibraryDirectoryUris);
    const filteredItems = (libraryMode === 'titles' && localPlaylistTrackSet)
      ? baseItems.filter((item) => {
        const uri = item.sourceUri || item.id;
        return localPlaylistTrackSet.has(uri);
      })
      : (libraryMode === 'titles' && albumSourceFolderFilter)
        ? baseItems.filter((item) => {
          const uri = item.sourceUri || item.id;
          return isTrackInFolder(uri, albumSourceFolderFilter);
        })
        : (libraryMode === 'titles' && albumTitleFilter)
        ? baseItems.filter((item) => item.meta === albumTitleFilter)
        : baseItems;
    setLibraryItems(filteredItems);
  }, [libraryMetadataRows, libraryMode, albumTitleFilter, albumSourceFolderFilter, playlistEntries, playlistUriFilter, selectedLibraryDirectoryUris]);

  useEffect(() => {
    queueRef.current = playQueue;
    queueIndexRef.current = playQueueIndex;
  }, [playQueue, playQueueIndex]);

  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: false,
      staysActiveInBackground: false,
    }).catch(() => undefined);
    return () => {
      const cleanup = async () => {
        if (soundRef.current) {
          await soundRef.current.unloadAsync().catch(() => undefined);
          soundRef.current = null;
        }
      };
      void cleanup();
    };
  }, []);

  const filteredApps = useMemo(() => {
    const query = appsSearch.trim().toLowerCase();
    if (!query) {
      return apps;
    }
    return apps.filter((item) => item.appName.toLowerCase().includes(query));
  }, [apps, appsSearch]);

  const notificationSourceApps = useMemo(() => {
    const map = new Map<string, string>();
    apps.forEach((app) => {
      map.set(app.packageName, app.appName);
    });
    notifications.forEach((notification) => {
      if (!map.has(notification.packageName)) {
        map.set(notification.packageName, notification.appName || notification.packageName);
      }
    });
    return Array.from(map.entries())
      .map(([packageName, appName]) => ({ packageName, appName }))
      .sort((left, right) => left.appName.localeCompare(right.appName, 'de'));
  }, [apps, notifications]);

  const toggleNotificationAllowPackage = (packageName: string) => {
    setNotificationAllowlistPackages((current) => {
      const next = current.includes(packageName)
        ? current.filter((entry) => entry !== packageName)
        : [...current, packageName];
      AsyncStorage.setItem(NOTIFICATION_ALLOWLIST_STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  };

  const handleOpenNotificationAccessSettings = async () => {
    const opened = await openNotificationAccessSettings().catch(() => false);
    if (!opened) {
      setNotifications((current) => ([
        {
          id: `notification-settings-fallback-${Date.now()}`,
          packageName: 'system',
          appName: 'System',
          title: t('settings.notifications.disabled', 'Benachrichtigungszugriff nicht erlaubt'),
          message: t('settings.open', 'Öffnen'),
        },
        ...current,
      ]));
    }
  };

  const playlistTrackUrisByPlaylistUri = useMemo(() => {
    return playlistEntries.reduce<Record<string, string[]>>((acc, entry) => {
      acc[entry.uri] = entry.trackUris;
      return acc;
    }, {});
  }, [playlistEntries]);

  const activePlaylistTrackUriSet = useMemo(() => {
    if (!playlistUriFilter) {
      return undefined;
    }
    const uris = playlistTrackUrisByPlaylistUri[playlistUriFilter] || [];
    return new Set(uris);
  }, [playlistTrackUrisByPlaylistUri, playlistUriFilter]);

  const activePlaylistTitle = useMemo(() => {
    if (!playlistUriFilter) {
      return undefined;
    }
    const entry = playlistEntries.find((candidate) => candidate.uri === playlistUriFilter);
    if (!entry) {
      return undefined;
    }
    return decodeURIComponent(entry.displayName || '')
      .replace(/\.m3u8?$/i, '')
      .trim() || 'Playlist';
  }, [playlistEntries, playlistUriFilter]);

  const playTrackAtIndex = async (queue: ILauncherListItem[], index: number) => {
    if (queue.length === 0 || index < 0 || index >= queue.length) {
      return;
    }
    let resolvedQueue = queue;
    let resolvedIndex = index;
    const isIncomingDlnaQueue = queue.every((item) => String(item.id || '').startsWith('dlna:'));
    if (isIncomingDlnaQueue && queue.length === 1 && dlnaQueueRef.current.length > 1) {
      const targetUri = String(queue[index]?.sourceUri || queue[index]?.id || '');
      const preservedIndex = dlnaQueueRef.current.findIndex((item) => String(item.sourceUri || item.id) === targetUri);
      resolvedQueue = dlnaQueueRef.current;
      resolvedIndex = preservedIndex >= 0 ? preservedIndex : Math.max(0, Math.min(dlnaQueueRef.current.length - 1, dlnaQueueIndexRef.current));
      console.log('[DLNA][UI] PLAYQUEUE_PRESERVED', {
        incomingQueueSize: queue.length,
        preservedQueueSize: resolvedQueue.length,
        resolvedIndex,
      });
    }
    const current = resolvedQueue[resolvedIndex];
    const sourceUri = current.sourceUri || current.id;
    if (!sourceUri) {
      return;
    }
    dlnaPlaybackSwitchInFlightRef.current = true;
    currentPlayingUriRef.current = String(sourceUri);
    isDlnaSessionRef.current = String(current.id || '').startsWith('dlna:');
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => undefined);
        soundRef.current = null;
      }
      setPlayerPositionMs(0);
      setPlayerDurationMs(0);
      const { sound } = await Audio.Sound.createAsync(
        { uri: sourceUri },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) {
            return;
          }
          const durationMs = status.durationMillis || 0;
          const positionMs = Math.min(status.positionMillis || 0, durationMs || status.positionMillis || 0);
          setPlayerDurationMs(durationMs);
          setPlayerPositionMs(positionMs);
          const state = status.isPlaying ? 'playing' : 'paused';
          setPlayerState(state);
          updateDLNAPlaybackState(state, positionMs, durationMs).catch(() => undefined);

          if (!status.didJustFinish) {
            return;
          }
          const nextIndex = queueIndexRef.current + 1;
          if (nextIndex >= queueRef.current.length) {
            setPlayerState('paused');
            setPlayerPositionMs(durationMs);
            return;
          }
          void playTrackAtIndex(queueRef.current, nextIndex);
        },
      );
      soundRef.current = sound;
      setPlayQueue(resolvedQueue);
      setPlayQueueIndex(resolvedIndex);
      if (resolvedQueue.every((item) => String(item.id).startsWith('dlna:'))) {
        dlnaQueueRef.current = [...resolvedQueue];
        dlnaQueueIndexRef.current = resolvedIndex;
        updateDLNAPlaybackTrack(
          String(sourceUri),
          String(current.title || ''),
          String(current.subtitle || current.meta || ''),
          String(current.artworkUri || ''),
          resolvedIndex,
          resolvedQueue.length,
        ).catch(() => undefined);
      }
      console.log('[DLNA][UI] PLAY_TRACK_AT_INDEX', {
        sourceUri,
        queueSize: resolvedQueue.length,
        queueIndex: resolvedIndex,
        contextId: dlnaContextIdRef.current,
      });
      setPlayerTrack(current.title);
      setPlayerMeta(current.subtitle || current.meta || 'Aurora Pulse');
      setPlayerArtworkUri(current.artworkUri);
      setPlayerState('playing');
      setMainTab('player');
    } finally {
      dlnaPlaybackSwitchInFlightRef.current = false;
    }
  };

  const togglePlayPause = async () => {
    const sound = soundRef.current;
    if (!sound) {
      if (queueRef.current.length > 0 && queueIndexRef.current >= 0) {
        await playTrackAtIndex(queueRef.current, queueIndexRef.current);
        return;
      }
      const allTracks = mapMetadataToLibraryItems(libraryMetadataRows, 'titles', selectedLibraryDirectoryUris);
      if (allTracks.length > 0) {
        await playTrackAtIndex(shuffleItems(allTracks), 0);
      }
      return;
    }
    const status = await sound.getStatusAsync();
    if (!status.isLoaded) {
      return;
    }
    if (status.isPlaying) {
      await sound.pauseAsync();
      setPlayerState('paused');
    } else {
      await sound.playAsync();
      setPlayerState('playing');
    }
  };

  const playPlayer = async () => {
    const sound = soundRef.current;
    if (sound) {
      const status = await sound.getStatusAsync();
      if (status.isLoaded && !status.isPlaying) {
        await sound.playAsync();
        setPlayerState('playing');
      }
    } else {
      await togglePlayPause();
    }
  };

  const pausePlayer = async () => {
    const sound = soundRef.current;
    if (sound) {
      const status = await sound.getStatusAsync();
      if (status.isLoaded && status.isPlaying) {
        await sound.pauseAsync();
        setPlayerState('paused');
      }
    }
  };

  const nextTrack = async () => {
    if (queueRef.current.length > 0) {
      const nextIndex = queueRef.current.length === 1
        ? 0
        : ((queueIndexRef.current + 1) % queueRef.current.length);
      await playTrackAtIndex(queueRef.current, nextIndex);
    }
  };

  const prevTrack = async () => {
    if (queueRef.current.length > 0) {
      const prevIndex = queueRef.current.length === 1
        ? 0
        : ((queueIndexRef.current - 1 + queueRef.current.length) % queueRef.current.length);
      await playTrackAtIndex(queueRef.current, prevIndex);
    }
  };

  const getTabStyle = (tabKey: MainTab) => {
    if (mainTab !== tabKey) {
      return styles.tab;
    }
    return [styles.tab, styles.tabActive];
  };

  const progressRatio = playerDurationMs > 0
    ? Math.max(0, Math.min(1, playerPositionMs / playerDurationMs))
    : 0;

  const onProgressLayout = (event: LayoutChangeEvent) => {
    setPlayerProgressWidth(event.nativeEvent.layout.width);
  };

  const seekToPositionByTouch = async (event: GestureResponderEvent) => {
    if (!soundRef.current || playerDurationMs <= 0 || playerProgressWidth <= 0) {
      return;
    }
    const touchX = Math.max(0, Math.min(event.nativeEvent.locationX, playerProgressWidth));
    const nextPosition = Math.floor((touchX / playerProgressWidth) * playerDurationMs);
    await soundRef.current.setPositionAsync(nextPosition).catch(() => undefined);
    setPlayerPositionMs(nextPosition);
  };

  const onSelectLibraryItem = (item: ILauncherListItem) => {
    if (item.collectionType === 'album') {
      const folderPrefix = item.sourceUri || item.meta || '';
      const albumTracks = mapMetadataToLibraryItems(libraryMetadataRows, 'titles', selectedLibraryDirectoryUris)
        .filter((track) => {
          const uri = track.sourceUri || track.id;
          return isTrackInFolder(uri, folderPrefix);
        });
      void playTrackAtIndex(albumTracks, 0);
      return;
    }
    if (item.collectionType === 'playlist') {
      const playlistKey = item.sourceUri || item.meta || '';
      const playlistTrackSet = new Set(playlistTrackUrisByPlaylistUri[playlistKey] || []);
      const playlistTracks = mapMetadataToLibraryItems(libraryMetadataRows, 'titles', selectedLibraryDirectoryUris)
        .filter((track) => {
          const trackUri = track.sourceUri || track.id;
          return playlistTrackSet.has(trackUri);
        });
      void playTrackAtIndex(playlistTracks, 0);
      return;
    }
    if (item.collectionType === 'track') {
      const currentTitleTracks = mapMetadataToLibraryItems(libraryMetadataRows, 'titles', selectedLibraryDirectoryUris);
      const visibleTracks = libraryMode === 'titles' && activePlaylistTrackUriSet
        ? currentTitleTracks.filter((track) => {
          const uri = track.sourceUri || track.id;
          return activePlaylistTrackUriSet.has(uri);
        })
        : libraryMode === 'titles' && albumSourceFolderFilter
        ? currentTitleTracks.filter((track) => {
          const uri = track.sourceUri || track.id;
          return isTrackInFolder(uri, albumSourceFolderFilter);
        })
        : libraryMode === 'titles' && albumTitleFilter
        ? currentTitleTracks.filter((track) => track.meta === albumTitleFilter)
        : currentTitleTracks;
      const selectedIndex = visibleTracks.findIndex((track) => track.id === item.id);
      void playTrackAtIndex(visibleTracks, selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    void playTrackAtIndex([item], 0);
  };

  const onLongPressLibraryItem = (item: ILauncherListItem) => {
    if (item.collectionType === 'album') {
      const folderPrefix = item.sourceUri || item.meta || getParentLibraryPath(getLibraryPathFromUri(item.sourceUri || item.id));
      setAlbumSourceFolderFilter(folderPrefix);
      setAlbumFolderFilterLabel(item.title);
      setAlbumTitleFilter(undefined);
      setPlaylistUriFilter(undefined);
      setLibraryMode('titles');
      setMainTab('library');
      return;
    }
    if (item.collectionType === 'playlist') {
      setPlaylistUriFilter(item.sourceUri || item.meta);
      setAlbumTitleFilter(undefined);
      setAlbumSourceFolderFilter(undefined);
      setAlbumFolderFilterLabel(undefined);
      setLibraryMode('titles');
      setMainTab('library');
    }
  };

  const onSelectSetting = async (item: ILauncherListItem) => {
    if (item.id === 'set-equalizer') {
      setEqualizerOpen(true);
      return;
    }
    if (item.id === 'set-default-launcher') {
      await AsyncStorage.setItem(DEFAULT_LAUNCHER_PROMPT_STORAGE_KEY, '1').catch(() => undefined);
      setShowLauncherPrompt(false);
      await Linking.sendIntent('android.settings.HOME_SETTINGS').catch(() => undefined);
      return;
    }
    if (item.id === 'set-media-library') {
      const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!result.granted || !result.directoryUri) {
        return;
      }
      setSelectedLibraryDirectoryUris((currentUris) => {
        const nextUris = sanitizeDirectoryUris([...currentUris, result.directoryUri]);
        AsyncStorage.setItem(MUSIC_LIBRARY_DIRECTORY_STORAGE_KEY, JSON.stringify(nextUris)).catch(() => undefined);
        return nextUris;
      });
      setMainTab('library');
      setLibraryMode('titles');
      setLibraryReloadToken((token) => token + 1);
      return;
    }
    if (item.id === 'set-restart-app') {
      onRestartApp();
      return;
    }
  };

  const onRestartApp = () => {
    DevSettings.reload();
  };

  const applyEqualizerSettings = (next: IEqualizerSettings, message?: string) => {
    setEqualizerSettings(next);
    if (message) {
      setEqualizerMessage(message);
    }
    persistEqualizerSettings(next).catch(() => undefined);
  };

  const onImportAutoEq = async () => {
    try {
      const pickerResult = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: '*/*',
      });
      if (pickerResult.canceled || pickerResult.assets.length === 0) {
        return;
      }
      const selectedAsset = pickerResult.assets[0];
      const fileContent = await FileSystem.readAsStringAsync(selectedAsset.uri);
      const profileName = selectedAsset.name?.replace(/\.[^.]+$/, '') || 'AutoEQ';
      const { settings: nextSettings, error, profile } = importAutoEqProfileFromText(
        equalizerSettings,
        fileContent,
        profileName,
      );
      if (error) {
        setEqualizerMessage(error);
        return;
      }
      applyEqualizerSettings(nextSettings, `AutoEQ-Profil "${profile?.name || profileName}" importiert.`);
    } catch (_error) {
      setEqualizerMessage('AutoEQ-Datei konnte nicht importiert werden.');
    }
  };

  const onRefreshLibrary = () => {
    if (mainTab !== 'library') {
      return;
    }
    setRefreshingLibrary(true);
    setLibraryReloadToken((token) => token + 1);
  };

  const onRefreshApps = () => {
    if (mainTab !== 'apps') {
      return;
    }
    setRefreshingApps(true);
    refreshInstalledLauncherApps()
      .then((result) => {
        setApps(result.apps);
        setAppsReason(result.reason);
        setAppsLoadedOnce(true);
      })
      .finally(() => setRefreshingApps(false));
  };

  const onOpenNotification = (notification: ILauncherNotification) => {
    void launchInstalledLauncherApp(notification.packageName);
    setNotifications((current) => current.filter((entry) => entry.id !== notification.id));
  };

  const openNotifications = () => {
    setNotificationsVisible(true);
    setNotificationsOpen(true);
    notificationsAnim.stopAnimation();
    Animated.timing(notificationsAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: false,
    }).start();
  };

  const closeNotifications = () => {
    notificationsAnim.stopAnimation();
    Animated.timing(notificationsAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished) {
        return;
      }
      setNotificationsVisible(false);
      setNotificationsOpen(false);
    });
  };

  const toggleNotifications = () => {
    if (notificationsVisible) {
      closeNotifications();
      return;
    }
    openNotifications();
  };


  const notificationCount = notifications.length;
  const getSettingIconName = (itemId: string): keyof typeof FontAwesome.glyphMap => {
    if (itemId.includes('launcher')) return 'home';
    if (itemId.includes('media-library')) return 'folder-open';
    if (itemId.includes('equalizer') || itemId.includes('audio')) return 'sliders';
    if (itemId.includes('theme')) return 'paint-brush';
    if (itemId.includes('notifications')) return 'bell';
    if (itemId.includes('restart')) return 'refresh';
    return 'cog';
  };
  useEffect(() => {
    if (notificationCount === 0 && notificationsVisible) {
      closeNotifications();
    }
  }, [notificationCount, notificationsVisible]);
  const titleSections = useMemo(() => {
    if (libraryMode !== 'titles') {
      return [] as Array<{ key: string; title?: string; tracks: ILauncherListItem[] }>;
    }
    const sections: Array<{ key: string; title?: string; tracks: ILauncherListItem[] }> = [];
    let currentKey = 'cd:default';
    let currentTitle: string | undefined;
    let currentTracks: ILauncherListItem[] = [];
    libraryItems.forEach((item) => {
      if (item.collectionType === 'cd-header') {
        if (currentTracks.length > 0) {
          sections.push({ key: currentKey, title: currentTitle, tracks: currentTracks });
        }
        currentKey = item.id;
        currentTitle = item.title;
        currentTracks = [];
        return;
      }
      if (item.collectionType === 'track') {
        currentTracks.push(item);
      }
    });
    if (currentTracks.length > 0) {
      sections.push({ key: currentKey, title: currentTitle, tracks: currentTracks });
    }
    return sections;
  }, [libraryItems, libraryMode]);
  const notificationsFabRight = compact ? 14 : 18;
  const notificationsFabTop = topInset + (compact ? 20 : 24);
  const notificationsOverlayTop = Math.max(topInset + 8, notificationsFabTop - 2);
  const notificationsOverlayBottom = bottomInset + 76;
  const fabCenterX = dimensions.width - notificationsFabRight - 21;
  const fabCenterY = notificationsFabTop + 16;
  const notificationsEndLeft = 18;
  const notificationsEndWidth = dimensions.width - 36;
  const notificationsEndHeight = dimensions.height - notificationsOverlayTop - notificationsOverlayBottom;
  const overlayCenterX = notificationsEndLeft + (notificationsEndWidth / 2);
  const overlayCenterY = notificationsOverlayTop + (notificationsEndHeight / 2);
  const overlayFromFabX = fabCenterX - overlayCenterX;
  const overlayFromFabY = fabCenterY - overlayCenterY;
  const notificationsStartWidth = 42;
  const notificationsStartHeight = 32;
  const notificationsStartLeft = dimensions.width - notificationsFabRight - notificationsStartWidth;
  const notificationsStartTop = notificationsFabTop;
  const notificationsAnimatedLeft = notificationsAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [notificationsStartLeft, notificationsEndLeft],
  });
  const notificationsAnimatedTop = notificationsAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [notificationsStartTop, notificationsOverlayTop],
  });
  const notificationsAnimatedWidth = notificationsAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [notificationsStartWidth, notificationsEndWidth],
  });
  const notificationsAnimatedHeight = notificationsAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [notificationsStartHeight, notificationsEndHeight],
  });
  const notificationsAnimatedRadius = notificationsAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [16, 18],
  });
  const playerTitleShouldScroll = playerTitleTextWidth > playerTitleContainerWidth && playerTitleContainerWidth > 0;
  const playerTitleTranslateX = playerTitleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -(Math.max(24, playerTitleTextWidth - playerTitleContainerWidth + 28))],
  });

  return (
    <View style={styles.safe}>
      <StatusBar
        translucent
        backgroundColor={theme.mode === 'dark' ? '#0f131c' : '#ffffff'}
        barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'}
      />
      <View style={styles.screen}>
        {notificationCount > 0 && (
          <Animated.View
            style={[
              styles.notificationsFab,
              {
                opacity: notificationsAnim.interpolate({
                  inputRange: [0, 0.6, 1],
                  outputRange: [1, 0.22, 0],
                }),
                transform: [
                  {
                    scale: notificationsAnim.interpolate({
                      inputRange: [0, 0.7, 1],
                      outputRange: [1, 0.94, 0.86],
                    }),
                  },
                  {
                    translateY: notificationsAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -5],
                    }),
                  },
                ],
              },
            ]}
          >
            <Pressable style={styles.notificationsFabPressable} onPress={toggleNotifications}>
              <View style={styles.notificationsFabInner}>
                <FontAwesome name="bell" size={12} color={styles.notificationsBell.color} />
                <Text style={styles.notificationsText}>{String(notificationCount)}</Text>
              </View>
            </Pressable>
          </Animated.View>
        )}
        <Animated.View
          style={{
            flex: 1,
            opacity: notificationsAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0.78],
            }),
            transform: [
              {
                scale: notificationsAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 0.985],
                }),
              },
            ],
          }}
        >
          {mainTab === 'library' && (
            <View style={styles.libraryContent}>
              <Text style={styles.title}>{t('library.title', 'Bibliothek')}</Text>
              <View style={styles.segmented}>
                {libraryModes.map((mode) => (
                  <Pressable
                    key={mode.key}
                    style={[styles.segmentButton, mode.key === libraryMode ? styles.segmentButtonActive : undefined]}
                    onPress={() => {
                      setLibraryMode(mode.key);
                      if (mode.key !== 'titles') {
                        setAlbumTitleFilter(undefined);
                        setAlbumSourceFolderFilter(undefined);
                        setAlbumFolderFilterLabel(undefined);
                        setPlaylistUriFilter(undefined);
                      }
                    }}
                  >
                    <Text style={[styles.segmentText, mode.key === libraryMode ? styles.segmentTextActive : undefined]}>
                      {mode.key === 'albums'
                        ? t('mode.albums', 'Alben')
                        : mode.key === 'titles'
                          ? t('mode.titles', 'Titel')
                          : t('mode.playlists', 'Playlists')}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {loadingContent && libraryItems.length === 0 && (
                <View style={styles.loading}>
                  <ActivityIndicator color={theme.colors.accent} />
                  <Text style={styles.helperText}>{t('library.loading', 'Bibliothek wird geladen…')}</Text>
                </View>
              )}
              {libraryItems.length > 0 && libraryMode !== 'titles' && (
                <FlatList
                  data={libraryItems}
                  style={{ flex: 1 }}
                  keyExtractor={(item) => item.id}
                  numColumns={2}
                  columnWrapperStyle={{ justifyContent: 'space-between', paddingHorizontal: 16 }}
                  contentContainerStyle={{ paddingTop: 8, paddingBottom: bottomInset + 42 }}
                  initialNumToRender={8}
                  maxToRenderPerBatch={10}
                  windowSize={5}
                  removeClippedSubviews={true}
                  refreshControl={
                    <RefreshControl
                      refreshing={refreshingLibrary}
                      onRefresh={onRefreshLibrary}
                      tintColor={theme.colors.accent}
                    />
                  }
                  renderItem={({ item }) => (
                    <Pressable
                      style={styles.card}
                      onPress={() => onSelectLibraryItem(item)}
                      onLongPress={() => onLongPressLibraryItem(item)}
                      delayLongPress={260}
                    >
                      <View style={styles.cover}>
                        {item.mosaicArtworks && item.mosaicArtworks.length > 0 ? (
                          <View style={{ width: '100%', height: '100%', borderRadius: 18, overflow: 'hidden', flexDirection: 'row', flexWrap: 'wrap' }}>
                            {item.mosaicArtworks.map((uri, i) => (
                              <Image 
                                key={uri} 
                                source={{ uri }} 
                                style={{ 
                                  width: item.mosaicArtworks && item.mosaicArtworks.length > 1 ? '50%' : '100%', 
                                  height: item.mosaicArtworks && item.mosaicArtworks.length > 2 ? '50%' : '100%' 
                                }} 
                              />
                            ))}
                          </View>
                        ) : item.artworkUri ? (
                          <Image source={{ uri: item.artworkUri }} style={styles.coverImage} />
                        ) : (
                          <Text style={styles.coverIcon}>♪</Text>
                        )}
                      </View>
                      <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={libraryMode === 'albums' ? styles.itemSubtitleAlbum : styles.itemSubtitle} numberOfLines={1}>
                        {item.subtitle}
                      </Text>
                    </Pressable>
                  )}
                />
              )}
              {titleSections.length > 0 && libraryMode === 'titles' && (
                <FlatList
                  data={titleSections}
                  style={{ flex: 1 }}
                  keyExtractor={(item) => item.key}
                  contentContainerStyle={[styles.trackList, { paddingTop: 4, paddingBottom: bottomInset + 120 }]}
                  initialNumToRender={15}
                  maxToRenderPerBatch={20}
                  windowSize={7}
                  removeClippedSubviews={true}
                  refreshControl={
                    <RefreshControl
                      refreshing={refreshingLibrary}
                      onRefresh={onRefreshLibrary}
                      tintColor={theme.colors.accent}
                    />
                  }
                  renderItem={({ item }) => (
                    <View style={styles.trackGroup}>
                      {!!item.title && (
                        <View style={styles.trackGroupHeader}>
                          <Text style={styles.trackGroupHeaderText}>{item.title}</Text>
                        </View>
                      )}
                      {item.tracks.map((track, trackIndex) => (
                        <Pressable
                          key={track.id}
                          style={[styles.trackRow, trackIndex === item.tracks.length - 1 ? styles.trackRowLast : undefined]}
                          onPress={() => onSelectLibraryItem(track)}
                        >
                          <Text style={styles.trackNumber}>{track.trackNumber || trackIndex + 1}</Text>
                          <View style={styles.trackCover}>
                            {track.artworkUri ? (
                              <Image source={{ uri: track.artworkUri }} style={styles.coverImage} />
                            ) : (
                              <Text style={styles.coverIcon}>♪</Text>
                            )}
                          </View>
                          <View style={styles.trackBody}>
                            <Text style={styles.trackTitle} numberOfLines={1}>{track.title}</Text>
                            <Text style={styles.trackArtist} numberOfLines={1}>{track.subtitle}</Text>
                          </View>
                          <Text style={styles.trackDuration}>{formatClock(track.durationMs || 0)}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                />
              )}
              {loadingContent && libraryItems.length > 0 && (
                <Text style={styles.refreshHintText}>{t('library.refreshing', 'Bibliothek wird im Hintergrund aktualisiert…')}</Text>
              )}
              {!loadingContent && libraryItems.length === 0 && (
                <View style={styles.helper}>
                  <Text style={styles.helperText}>
                    {selectedLibraryDirectoryUris.length === 0
                      ? t('library.noFolder', 'Kein Bibliotheksordner ausgewählt. Füge in Settings mindestens einen Ordner hinzu.')
                      : libraryMode === 'titles' && !!activePlaylistTitle
                        ? t('library.noTracksPlaylist', 'Keine Titel für die Playlist "{name}" gefunden.', { name: activePlaylistTitle })
                        : libraryMode === 'titles' && !!albumSourceFolderFilter
                          ? t('library.noTracksFolder', 'Keine Titel für den Ordner "{name}" gefunden.', { name: albumFolderFilterLabel || t('playlistFilter.defaultFolder', 'Gemischter Ordner') })
                          : libraryMode === 'titles' && !!albumTitleFilter
                            ? t('library.noTracksAlbum', 'Keine Titel für das Album "{name}" gefunden.', { name: albumTitleFilter })
                        : t('library.noMedia', 'Keine Medien in den ausgewählten Bibliotheksordnern gefunden.')}
                  </Text>
                  <Text style={styles.debugText}>{libraryDebugInfo}</Text>
                </View>
              )}
              {contentReason === 'module-error' && (
                <View style={styles.helper}>
                  <Text style={styles.helperText}>{t('library.bridgeError', 'Media-Bridge Fehler aktiv. Fallback ist eingeschaltet.')}</Text>
                  <Text style={styles.debugText}>{libraryDebugInfo}</Text>
                </View>
              )}
            </View>
          )}
          {mainTab === 'player' && (
            <View style={styles.playerScreen}>
              <View style={styles.playerTopBlock}>
                <View style={styles.playerArt}>
                  {playerArtworkUri ? (
                    <Image source={{ uri: playerArtworkUri }} style={styles.coverImage} />
                  ) : (
                    <Image source={APP_LOGO} style={styles.playerArtImage} />
                  )}
                </View>
                <View
                  style={styles.playerTitleViewport}
                  onLayout={(event: LayoutChangeEvent) => setPlayerTitleContainerWidth(event.nativeEvent.layout.width)}
                >
                  <Text
                    style={[styles.playerTitle, styles.playerTitleMeasure]}
                    onLayout={(event: LayoutChangeEvent) => setPlayerTitleTextWidth(event.nativeEvent.layout.width)}
                  >
                    {playerTrack}
                  </Text>
                  {playerTitleShouldScroll ? (
                    <Animated.View
                      style={[
                        styles.playerTitleMarqueeRow,
                        {
                          transform: [{ translateX: playerTitleTranslateX }],
                        },
                      ]}
                    >
                      <Text
                        style={styles.playerTitle}
                        numberOfLines={1}
                        onLayout={(event: LayoutChangeEvent) => setPlayerTitleTextWidth(event.nativeEvent.layout.width)}
                      >
                        {playerTrack}
                      </Text>
                      <Text style={styles.playerTitle} numberOfLines={1}>{`     ${playerTrack}`}</Text>
                    </Animated.View>
                  ) : (
                    <Text
                      style={styles.playerTitle}
                      numberOfLines={1}
                    >
                      {playerTrack}
                    </Text>
                  )}
                </View>
                <Text style={styles.playerMeta}>{playerMeta}</Text>
              </View>
              <View style={styles.playerMiddleBlock}>
                <View style={styles.progressRow}>
                  <Text style={styles.progressTimeText}>{formatClock(playerPositionMs)}</Text>
                  <View
                    style={styles.progressTrack}
                    onLayout={onProgressLayout}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={(event) => {
                      void seekToPositionByTouch(event);
                    }}
                    onResponderMove={(event) => {
                      void seekToPositionByTouch(event);
                    }}
                    onResponderRelease={(event) => {
                      void seekToPositionByTouch(event);
                    }}
                  >
                    <View style={[styles.progressActive, { width: `${progressRatio * 100}%` }]} />
                  </View>
                  <Text style={styles.progressTimeText}>{formatClock(playerDurationMs)}</Text>
                </View>
                <Text style={styles.playerQueueIndex}>{`Track ${Math.max(1, playQueueIndex + 1)} / ${Math.max(1, playQueue.length)}`}</Text>
              </View>
              <View style={styles.playerBottomBlock}>
                <View style={styles.controls}>
                  <Pressable
                    style={styles.controlBtn}
                    onPress={() => void prevTrack()}
                  >
                    <Text style={styles.controlText}>⏮</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.controlBtn, styles.controlBtnMain]}
                    onPress={() => void togglePlayPause()}
                  >
                    <View style={styles.playPauseGlyphWrap}>
                      {playerState === 'playing' ? (
                        <View style={styles.playPauseGlyphPause}>
                          <View style={styles.playPauseBar} />
                          <View style={styles.playPauseBar} />
                        </View>
                      ) : (
                        <View style={styles.playPauseGlyphPlay} />
                      )}
                    </View>
                  </Pressable>
                  <Pressable
                    style={styles.controlBtn}
                    onPress={() => void nextTrack()}
                  >
                    <Text style={styles.controlText}>⏭</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}
          {mainTab === 'apps' && (
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              refreshControl={
                <RefreshControl
                  refreshing={refreshingApps}
                  onRefresh={onRefreshApps}
                  tintColor={theme.colors.accent}
                />
              }
            >
              <TextInput
                value={appsSearch}
                onChangeText={setAppsSearch}
                placeholder="Apps durchsuchen…"
                placeholderTextColor="#97a0b4"
                style={styles.search}
              />
              <Text style={styles.appsCaption}>Installierte Apps</Text>
              {loadingApps && (
                <View style={styles.loading}>
                  <ActivityIndicator color={theme.colors.accent} />
                  <Text style={styles.helperText}>{t('apps.loading', 'Apps werden geladen…')}</Text>
                </View>
              )}
              {!loadingApps && (
                <View style={styles.appsGrid}>
                  {filteredApps.map((app) => (
                    <Pressable key={app.packageName} style={styles.appCell} onPress={() => launchInstalledLauncherApp(app.packageName)}>
                      <View style={styles.appIcon}>
                        {app.iconUri ? (
                          <Image source={{ uri: app.iconUri }} style={styles.appIconImage} />
                        ) : (
                          <Text style={styles.appIconText}>{app.appName.slice(0, 1).toUpperCase()}</Text>
                        )}
                      </View>
                      <Text style={styles.appName} numberOfLines={2}>{app.appName}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {!loadingApps && filteredApps.length === 0 && (
                <View style={styles.helper}>
                  <Text style={styles.helperText}>{t('apps.none', 'Keine Apps gefunden. Bridge oder Berechtigungen prüfen.')}</Text>
                </View>
              )}
              {appsReason && (
                <View style={styles.helper}>
                  <Text style={styles.helperText}>{t('apps.source', 'Apps-Quelle: {source}', { source: String(appsReason) })}</Text>
                </View>
              )}
            </ScrollView>
          )}
          {mainTab === 'settings' && (
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <View style={styles.settingsHeaderRow}>
                <View style={styles.settingsHeaderTitleRow}>
                  <Text style={styles.title}>{t('settings.title', 'Konfiguration')}</Text>
                  <Pressable style={styles.settingsInfoButton} onPress={() => setSettingsInfoOpen((current) => !current)}>
                    <FontAwesome name="info" style={styles.settingIcon} />
                  </Pressable>
                </View>
                <Text style={styles.settingsVersionInline}>{`Version ${APP_VERSION_DISPLAY} (Build ${APP_BUILD_DISPLAY})`}</Text>
              </View>
              {settingsInfoOpen && (
                <View style={styles.settingsInfoPanel}>
                  <Image source={APP_LOGO} style={styles.settingsInfoLogo} />
                  <Text style={styles.settingsInfoTitle}>Aurora Pulse Launcher</Text>
                  <Text style={styles.helperText}>
                    Aurora Pulse ist ein Android Audio Launcher mit Bibliothek, Player, DLNA-Renderer und Systemintegrationen für DAP-Workflows.
                  </Text>
                </View>
              )}
              <View style={styles.panel}>
                <Text style={styles.panelHeading}>{t('settings.system', 'System')}</Text>
                {settingsItems.map((item) => (
                  <Pressable key={item.id} style={styles.settingRow} onPress={() => onSelectSetting(item)}>
                    <View style={styles.settingLeading}>
                      <View style={styles.settingIconWrap}>
                        <FontAwesome name={getSettingIconName(item.id)} style={styles.settingIcon} />
                      </View>
                      <View style={styles.settingTextWrap}>
                        <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
                        <Text style={styles.itemSubtitle} numberOfLines={1}>{item.subtitle}</Text>
                      </View>
                    </View>
                    <View style={styles.settingAction}>
                      <Text style={styles.settingActionText}>{item.meta || t('settings.open', 'Öffnen')}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelHeading}>{t('notifications.title', 'Benachrichtigungszentrale')}</Text>
                <Pressable
                  style={styles.settingRow}
                  onPress={() => {
                    void handleOpenNotificationAccessSettings();
                  }}
                >
                  <View style={styles.settingLeading}>
                    <View style={styles.settingIconWrap}>
                      <FontAwesome name="unlock-alt" style={styles.settingIcon} />
                    </View>
                    <View style={styles.settingTextWrap}>
                    <Text style={styles.itemTitle}>{t('settings.notifications.permission', 'Systemzugriff')}</Text>
                    <Text style={styles.itemSubtitle}>
                      {notificationAccessGranted
                        ? t('settings.notifications.enabled', 'Benachrichtigungszugriff erlaubt')
                        : t('settings.notifications.disabled', 'Benachrichtigungszugriff nicht erlaubt')}
                    </Text>
                    </View>
                  </View>
                  <View style={styles.settingAction}>
                    <Text style={styles.settingActionText}>{t('settings.open', 'Öffnen')}</Text>
                  </View>
                </Pressable>
                {notificationSourceApps.map((app) => {
                  const enabled = notificationAllowlistPackages.length === 0 || notificationAllowlistPackages.includes(app.packageName);
                  return (
                    <Pressable
                      key={`notif-${app.packageName}`}
                      style={styles.settingRow}
                      onPress={() => toggleNotificationAllowPackage(app.packageName)}
                    >
                      <View style={styles.settingLeading}>
                        <View style={styles.settingIconWrap}>
                          <FontAwesome name="bell" style={styles.settingIcon} />
                        </View>
                        <View style={styles.settingTextWrap}>
                          <Text style={styles.itemTitle} numberOfLines={1}>{app.appName}</Text>
                          <Text style={styles.itemSubtitle} numberOfLines={1}>{app.packageName}</Text>
                        </View>
                      </View>
                      <View style={styles.settingAction}>
                        <Text style={styles.settingActionText}>{enabled ? 'AN' : 'AUS'}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Pressable style={styles.bmcCard} onPress={() => void Linking.openURL('https://www.buymeacoffee.com/better_craft')}>
                <View style={styles.bmcLeft}>
                  <View style={styles.bmcIconWrap}>
                    <FontAwesome name="coffee" size={16} color={theme.colors.accent} />
                  </View>
                  <View>
                    <Text style={styles.bmcTitle}>{t('support.bmc.title', 'Buy me a coffee')}</Text>
                    <Text style={styles.bmcSubtitle}>{t('support.bmc.subtitle', 'Unterstütze better_craft')}</Text>
                  </View>
                </View>
                <Text style={styles.bmcAction}>{t('support.bmc.action', 'Öffnen')}</Text>
              </Pressable>
              {showLauncherPrompt && (
                <View style={styles.helper}>
                  <Text style={styles.helperText}>{t('settings.launcherPrompt', 'Aurora kann als Standard-Launcher gesetzt werden.')}</Text>
                </View>
              )}
            </ScrollView>
          )}
        </Animated.View>
        {notificationsVisible && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.notificationsBackdrop,
              {
                opacity: notificationsAnim,
              },
            ]}
          >
            <BlurView
              tint={theme.mode === 'dark' ? 'dark' : 'light'}
              intensity={100}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.notificationsBackdropTint} />
          </Animated.View>
        )}
        {equalizerOpen && (
          <Animated.View style={styles.equalizerScreen}>
            <ScrollView contentContainerStyle={styles.equalizerScreenScroll}>
              <View style={styles.equalizerPanel}>
                <View style={styles.equalizerHeader}>
                  <Text style={styles.equalizerTitle}>Equalizer</Text>
                </View>
                <View style={styles.equalizerRow}>
                  <Text style={styles.equalizerLabel}>Headroom Compensation</Text>
                  <Pressable
                    style={[styles.equalizerToggle, equalizerSettings.headroomCompensationEnabled ? styles.equalizerToggleActive : undefined]}
                    onPress={() => applyEqualizerSettings(setHeadroomCompensation(equalizerSettings, !equalizerSettings.headroomCompensationEnabled))}
                  >
                    <Text style={[styles.equalizerToggleText, equalizerSettings.headroomCompensationEnabled ? styles.equalizerToggleTextActive : undefined]}>
                      {equalizerSettings.headroomCompensationEnabled ? 'AN' : 'AUS'}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.equalizerRow}>
                  <Text style={styles.equalizerLabel}>Parametric EQ</Text>
                  <Pressable
                    style={[styles.equalizerToggle, equalizerSettings.autoEqEnabled ? styles.equalizerToggleActive : undefined]}
                    onPress={() => applyEqualizerSettings(setAutoEqEnabled(equalizerSettings, !equalizerSettings.autoEqEnabled))}
                  >
                    <Text style={[styles.equalizerToggleText, equalizerSettings.autoEqEnabled ? styles.equalizerToggleTextActive : undefined]}>
                      {equalizerSettings.autoEqEnabled ? 'AN' : 'AUS'}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.equalizerBands}>
                  {equalizerSettings.bands.map((band) => (
                    <View key={band.frequency} style={styles.equalizerBandRow}>
                      <Text style={styles.equalizerBandFreq}>{formatFrequencyLabel(band.frequency)}</Text>
                      <Pressable
                        style={styles.equalizerBandButton}
                        onPress={() => applyEqualizerSettings(setEqualizerBandGain(equalizerSettings, band.frequency, band.gain - 0.5))}
                      >
                        <Text style={styles.equalizerBandButtonText}>−</Text>
                      </Pressable>
                      <Text style={styles.equalizerBandValue}>{`${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB`}</Text>
                      <Pressable
                        style={styles.equalizerBandButton}
                        onPress={() => applyEqualizerSettings(setEqualizerBandGain(equalizerSettings, band.frequency, band.gain + 0.5))}
                      >
                        <Text style={styles.equalizerBandButtonText}>+</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
                <View style={styles.equalizerButtonRow}>
                  <Pressable style={styles.equalizerActionButton} onPress={() => void onImportAutoEq()}>
                    <Text style={styles.equalizerActionText}>AutoEQ-Datei importieren</Text>
                  </Pressable>
                  <Pressable
                    style={styles.equalizerActionButton}
                    onPress={() => applyEqualizerSettings(resetEqualizerBands(equalizerSettings), '10-Band-EQ zurückgesetzt.')}
                  >
                    <Text style={styles.equalizerActionText}>10-Band reset</Text>
                  </Pressable>
                </View>
                {equalizerSettings.autoEqProfile && (
                  <Text style={styles.equalizerMessage}>{`Aktives Profil: ${equalizerSettings.autoEqProfile.name} (${equalizerSettings.autoEqProfile.filters.length} Filter)`}</Text>
                )}
                {!!equalizerSettings.autoEqProfilesHistory.length && (
                  <View style={styles.equalizerHistory}>
                    {equalizerSettings.autoEqProfilesHistory.map((profile: AutoEqProfile) => (
                      <Pressable
                        key={profile.name}
                        style={styles.equalizerHistoryChip}
                        onPress={() => {
                          const { settings: nextSettings, error } = selectAutoEqProfile(equalizerSettings, profile.name);
                          if (error) {
                            setEqualizerMessage(error);
                            return;
                          }
                          applyEqualizerSettings(nextSettings, `Profil "${profile.name}" geladen.`);
                        }}
                      >
                        <Text style={styles.equalizerHistoryChipText}>{profile.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {!!equalizerMessage && <Text style={styles.equalizerMessage}>{equalizerMessage}</Text>}
                <View style={styles.equalizerFooter}>
                  <Pressable onPress={() => setEqualizerOpen(false)}>
                    <Text style={styles.equalizerClose}>Schließen</Text>
                  </Pressable>
                </View>
              </View>
            </ScrollView>
          </Animated.View>
        )}
        {notificationsVisible && (
          <Animated.View
            style={[
              styles.notificationsScreen,
              {
                opacity: notificationsAnim,
                left: notificationsAnimatedLeft,
                top: notificationsAnimatedTop,
                width: notificationsAnimatedWidth,
                height: notificationsAnimatedHeight,
                borderRadius: notificationsAnimatedRadius,
                transform: [
                  {
                    translateX: notificationsAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [overlayFromFabX * 0.06, 0],
                    }),
                  },
                  {
                    translateY: notificationsAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [overlayFromFabY * 0.06, 0],
                    }),
                  },
                  {
                    scale: notificationsAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 1],
                    }),
                  },
                ],
              },
            ]}
          >
            <BlurView
              tint={theme.mode === 'dark' ? 'dark' : 'light'}
              intensity={95}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.notificationsGlassTint} />
            <View style={styles.notificationsScreenContent}>
            <View style={styles.notificationsScreenHeader}>
              <Text style={styles.notificationsTitle}>{t('notifications.title', 'Benachrichtigungszentrale')}</Text>
            </View>
            {notifications.length === 0 && (
              <Text style={styles.notificationsEmpty}>{t('notifications.none', 'Keine Benachrichtigungen')}</Text>
            )}
            <ScrollView>
              {notifications.map((notification) => (
                <Pressable
                  key={notification.id}
                  style={styles.notificationsItem}
                  onPress={() => onOpenNotification(notification)}
                >
                  <View style={styles.notificationsItemRow}>
                    <View style={styles.notificationsItemContent}>
                      <Text style={styles.notificationsItemApp}>{notification.appName}</Text>
                      <Text style={styles.notificationsItemTitle}>{notification.title}</Text>
                      <Text style={styles.notificationsItemMessage}>{notification.message}</Text>
                    </View>
                    <Pressable
                      style={styles.notificationsDelete}
                      onPress={() => setNotifications((current) => current.filter((entry) => entry.id !== notification.id))}
                    >
                      <FontAwesome name="trash" size={14} color={styles.notificationsDeleteIcon.color} />
                    </Pressable>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.notificationsScreenFooter}>
              <Pressable onPress={closeNotifications}>
                <Text style={styles.notificationsClose}>{t('notifications.close', 'Schließen')}</Text>
              </Pressable>
            </View>
            </View>
          </Animated.View>
        )}
      </View>
      <View pointerEvents="none" style={styles.bottomNavBackdrop}>
        <BlurView
          tint={theme.mode === 'dark' ? 'dark' : 'light'}
          intensity={95}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.bottomNavBackdropTint} />
      </View>
      <View style={styles.bottomNav}>
        {tabs.map((tab) => (
          <Pressable
            key={tab.key}
            style={getTabStyle(tab.key)}
            onPress={() => {
              if (notificationsVisible) {
                closeNotifications();
              }
              setMainTab(tab.key);
            }}
          >
            <FontAwesome
              name={tab.icon}
              size={styles.tabIcon.fontSize}
              color={mainTab === tab.key ? styles.tabIconActive.color : styles.tabIcon.color}
            />
            <Text style={[styles.tabText, mainTab === tab.key ? styles.tabTextActive : undefined]}>
              {tab.key === 'library'
                ? t('tab.library', 'Bibliothek')
                : tab.key === 'player'
                  ? t('tab.player', 'Play')
                  : tab.key === 'apps'
                    ? t('tab.apps', 'Apps')
                    : t('tab.settings', 'Settings')}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
