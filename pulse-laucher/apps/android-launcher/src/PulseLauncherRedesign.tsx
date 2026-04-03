import * as React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Animated,
  DevSettings,
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PermissionsAndroid,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  FlatList,
  SectionList,
  Switch,
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
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Audio, AVPlaybackStatus, InterruptionModeAndroid } from 'expo-av';
import { FontAwesome } from '@expo/vector-icons';

import { ContentRoute, ILauncherListItem } from './models/launcher';
import {
  IInstalledLauncherApp,
  loadInstalledLauncherApps,
  launchInstalledLauncherApp,
  restartCurrentApp,
  refreshInstalledLauncherApps,
} from './services/launcher-apps';
import {
  IAudioFileMetadata,
  ILibrarySyncStatus,
  IPlaylistEntry,
  getLibraryCachedRows,
  getLibrarySyncStatus,
  listAudioEntriesFromRoots,
  listPlaylistEntriesFromRoots,
  loadMetadataForUris,
  scanMetadataFromRoots,
  startLibrarySync,
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
  setEqualizerPreampGain,
  setHeadroomCompensation,
} from './services/equalizer';
import {
  clearAllNotifications,
  ISystemNotificationNativeItem,
  getCurrentNotifications,
  isNotificationAccessGranted,
  notificationEvents,
  openNotificationAccessSettings,
} from './services/system-notifications';
import {
  DLNAControlEventEmitter,
  isDLNARendererEnabled,
  setDLNARendererEnabled,
  updateDLNAPlaybackState,
  updateDLNAPlaybackTrack,
} from './services/dlna-control';
import {
  MediaControlEventEmitter,
  setMediaControlSessionActive,
  updateMediaControlPlaybackState,
  updateMediaControlPlaybackTrack,
} from './services/media-controls';
import {
  applyAudioEffects,
  setAudioEffectsEnabled,
} from './services/audio-effects';
import { pickAutoEqFileNative } from './services/file-picker';
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
const MUSIC_LIBRARY_DIRECTORY_FILE_NAME = 'pulse-launcher-music-library-directories-v1.json';
const MUSIC_LIBRARY_CACHE_FILE_NAME = 'pulse-launcher-music-library-cache-v2.json';
const ALBUM_ITEMS_CACHE_VERSION = 4;
const TITLE_ITEMS_CACHE_VERSION = 1;
const APPS_PINNED_STORAGE_KEY = 'pulse-launcher:apps-pinned-v1';
const APP_VERSION_DISPLAY = '1.0.0-beta5';
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
  { key: 'library', label: 'Bibliothek', icon: 'music' },
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

      const segments = relativePath.split('/').filter(Boolean);
      const folderSegments = segments.slice(0, -1);
      const albumSegments = [...folderSegments];
      if (albumSegments.length > 1) {
        const lastSegment = albumSegments[albumSegments.length - 1] || '';
        if (/^(?:cd|disc)\s*0*\d+$/i.test(lastSegment)) {
          albumSegments.pop();
        }
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

const isPlaylistLikeUri = (uri?: string): boolean => {
  const normalized = decodeURIComponent(String(uri || '')).toLowerCase();
  return normalized.endsWith('.m3u') || normalized.endsWith('.m3u8');
};

const isAudioRow = (row: IAudioFileMetadata): boolean => {
  const mime = String(row.mimeType || '').toLowerCase();
  if (isPlaylistLikeUri(row.uri)) {
    return false;
  }
  if (!mime) {
    return true;
  }
  if (!mime.startsWith('audio/')) {
    return false;
  }
  if (mime.includes('mpegurl') || mime.includes('x-mpegurl') || mime.includes('vnd.apple.mpegurl')) {
    return false;
  }
  return true;
};

const sanitizeAlbumLabel = (value?: string): string => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const normalized = raw.toLowerCase();
  if (normalized.startsWith('content://')) {
    return '';
  }
  if (raw.includes(':') && raw.includes('/')) {
    return '';
  }
  if (raw.length > 64 && !raw.includes(' ')) {
    return '';
  }
  return raw;
};

const hashStableInt = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
};

const normalizeAlbumCollectionKey = (value: string): string => {
  let normalized = String(value || '').toLowerCase().trim();
  if (!normalized) {
    return '';
  }
  normalized = normalized
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:cd|disc)\s*0*\d{1,2}\b/gi, ' ')
    .replace(/[–—-]\s*(?:cd|disc)\s*0*\d{1,2}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized;
};

const extractFileArtistHint = (uri: string): string => {
  const fileName = decodeURIComponent(String(uri || '').split('/').pop() || '').replace(/\.[^.]+$/, '').trim();
  const strictMatch = fileName.match(/^\d{1,3}\.\s*(.*?)\s*-\s*(.+)$/);
  return strictMatch ? String(strictMatch[1] || '').trim() : '';
};

const evaluateCollectionClassification = (rows: IAudioFileMetadata[], folderKeyHint?: string) => {
  const hasDiscSubfolders = rows.some((row) => {
    const pathSegments = getLibraryPathFromUri(row.uri).split('/').filter(Boolean);
    return pathSegments.some((segment) => /^(?:cd|disc)\s*0*\d{1,2}$/i.test(segment));
  });
  const rawAlbumLabels = rows.map((row) => sanitizeAlbumLabel(row.album)).filter(Boolean);
  const normalizedAlbumLabels = rawAlbumLabels.map((label) => normalizeAlbumCollectionKey(label)).filter(Boolean);
  const albumCounts = new Map<string, number>();
  normalizedAlbumLabels.forEach((label) => {
    albumCounts.set(label, (albumCounts.get(label) || 0) + 1);
  });
  const uniqueAlbumCount = albumCounts.size;
  const dominantAlbumCount = Math.max(0, ...Array.from(albumCounts.values()));
  const dominantShare = rows.length > 0 ? (dominantAlbumCount / rows.length) : 1;
  // Important: Sammlungserkennung darf NICHT von Track-Features getrieben werden.
  // Stattdessen primär über die (Album-)Künstler (albumArtist) arbeiten.
  const resolvedAlbumArtists = rows
    .map((row) => {
      const tagAlbumArtist = String(row.albumArtist || '').trim();
      if (tagAlbumArtist) {
        return tagAlbumArtist;
      }
      // Fallback: wenn albumArtist fehlt, versuchen wir es aus dem Dateinamen abzuleiten.
      return extractFileArtistHint(row.uri);
    })
    .filter(Boolean);
  const albumArtistSet = new Set<string>();
  resolvedAlbumArtists.forEach((a) => {
    albumArtistSet.add(String(a).toLowerCase());
  });

  const albumArtistCounts = new Map<string, number>();
  resolvedAlbumArtists.forEach((a) => {
    const key = String(a).toLowerCase();
    albumArtistCounts.set(key, (albumArtistCounts.get(key) || 0) + 1);
  });
  const uniqueAlbumArtistCount = albumArtistCounts.size;
  let dominantAlbumArtistShare = 1;
  if (rows.length > 0 && uniqueAlbumArtistCount > 0) {
    const dominantAlbumArtistCount = Math.max(0, ...Array.from(albumArtistCounts.values()));
    dominantAlbumArtistShare = dominantAlbumArtistCount / rows.length;
  }

  // Nur für "Fallback/Noise-Erkennung" nutzen wir Track-Künstler (Features),
  // aber sie dürfen NICHT die Hauptklassifizierung von "Sammlungen" steuern.
  const trackArtists = new Set<string>();
  rows.forEach((row) => {
    const trackArtist = String(row.artist || '').trim();
    if (trackArtist) {
      trackArtists.add(trackArtist.toLowerCase());
    }
  });

  const distinctArtworkCount = new Set(rows.map((row) => String(row.artworkUri || '').trim()).filter(Boolean)).size;
  const folderHint = String(folderKeyHint || '').toLowerCase();
  const collectionNameHint = folderHint.includes('remember')
    || folderHint.includes('audiophile')
    || folderHint.includes('sampler')
    || folderHint.includes('collection')
    || folderHint.includes('mix');

  // Noise Guard: Wenn praktisch immer der gleiche Album-Künstler vorkommt,
  // ist es sehr wahrscheinlich ein "echtes" Album (auch wenn auf Track-Ebene Features vorkommen).
  const likelySingleAlbumAlbumArtistNoise = uniqueAlbumArtistCount <= 1
    || dominantAlbumArtistShare >= 0.90;

  const isCollection = !hasDiscSubfolders && !likelySingleAlbumAlbumArtistNoise && (
    // Sammlung: Ordnername deutet klar auf "gemischte Playlist/Sammlung" hin.
    (collectionNameHint && uniqueAlbumArtistCount >= 2)
    // Sammlung: Wenn der Ordner mehrere Album-Künstler enthält (auch wenn alle Tracks denselben album-Label haben).
    || (uniqueAlbumArtistCount >= 2 && dominantAlbumArtistShare < 0.90)
    // Zusätzlich: mehrere Album-Titel + mehrere Album-Künstler.
    || (uniqueAlbumCount >= 2 && uniqueAlbumArtistCount >= 2)
    // Optional: wenn es mehrere Album-Titel gibt und deutlich unterschiedliche Album-Artists.
    || (uniqueAlbumCount >= 3 && uniqueAlbumArtistCount >= 2)
  );

  return {
    isCollection,
    hasDiscSubfolders,
    uniqueAlbumCount,
    dominantShare,
    // Für bestehende Telemetrie/Debugging: verwende hier Track-Künstler, nicht Album-Artists.
    artistsCount: trackArtists.size,
    distinctArtworkCount,
  };
};

const normalizeDisplayText = (value?: string): string => {
  const input = String(value || '');
  if (!input) {
    return '';
  }
  const replacements: Array<[string, string]> = [
    ['Ã„', 'Ä'],
    ['Ã–', 'Ö'],
    ['Ãœ', 'Ü'],
    ['Ã¤', 'ä'],
    ['Ã¶', 'ö'],
    ['Ã¼', 'ü'],
    ['ÃŸ', 'ß'],
    ['â€“', '–'],
    ['â€”', '—'],
    ['â€ž', '„'],
    ['â€œ', '“'],
    ['â€\u009d', '”'],
    ['â€\u0099', '’'],
  ];
  let normalized = input;
  replacements.forEach(([source, target]) => {
    normalized = normalized.split(source).join(target);
  });
  return normalized;
};

const normalizeLauncherItemText = (item: ILauncherListItem): ILauncherListItem => ({
  ...item,
  title: normalizeDisplayText(item.title),
  subtitle: normalizeDisplayText(item.subtitle),
  meta: item.meta ? normalizeDisplayText(item.meta) : item.meta,
});

const extractAlbumYearForSorting = (item: ILauncherListItem): number | null => {
  const candidates = [item.title, item.sourceUri];
  for (const candidate of candidates) {
    const text = String(candidate || '');
    const matches = text.match(/\b(19\d{2}|20\d{2})\b/g);
    if (matches && matches.length > 0) {
      const year = Number.parseInt(matches[matches.length - 1], 10);
      if (Number.isFinite(year)) {
        return year;
      }
    }
  }
  return null;
};

const sortAlbumItems = (items: ILauncherListItem[]): ILauncherListItem[] => {
  return items.slice().sort((left, right) => {
    const artistCompare = String(left.subtitle || '').localeCompare(String(right.subtitle || ''), 'de', { sensitivity: 'base' });
    if (artistCompare !== 0) {
      return artistCompare;
    }
    const leftYear = extractAlbumYearForSorting(left);
    const rightYear = extractAlbumYearForSorting(right);
    if (leftYear !== null && rightYear !== null && leftYear !== rightYear) {
      return leftYear - rightYear;
    }
    return String(left.title || '').localeCompare(String(right.title || ''), 'de', { sensitivity: 'base' });
  });
};

const extractDiscNumberForSorting = (row: IAudioFileMetadata): number => {
  const path = getLibraryPathFromUri(String(row.uri || ''));
  const segments = path.split('/').filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const match = segment.match(/(?:^|[\s._-])(?:cd|disc)\s*0*(\d{1,2})(?:$|[\s._-])/i);
    if (match?.[1]) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }
  const fallback = String(row.trackNumber || '').match(/^\s*(\d{1,2})\s*[/.-]\s*\d{1,3}\s*$/);
  if (fallback?.[1]) {
    const value = Number.parseInt(fallback[1], 10);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 1;
};

const extractTrackNumberForSorting = (row: IAudioFileMetadata): number => {
  const raw = String(row.trackNumber || '').trim();
  if (raw) {
    const slash = raw.match(/^\s*\d{1,2}\s*[/.-]\s*(\d{1,3})\s*$/);
    if (slash?.[1]) {
      const parsed = Number.parseInt(slash[1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    const plain = raw.match(/(\d{1,3})/);
    if (plain?.[1]) {
      const parsed = Number.parseInt(plain[1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  const name = decodeURIComponent(getLibraryPathFromUri(String(row.uri || '')).split('/').pop() || '');
  const prefixed = name.match(/^\s*(\d{1,3})\D/);
  if (prefixed?.[1]) {
    const parsed = Number.parseInt(prefixed[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return Number.MAX_SAFE_INTEGER;
};

const resolveFolderArtworkForTrackUri = (trackUri: string, folderArtworkByFolderPath: Record<string, string>): string | undefined => {
  const trackParent = getParentLibraryPath(getLibraryPathFromUri(trackUri));
  if (!trackParent) {
    return undefined;
  }
  const direct = folderArtworkByFolderPath[trackParent];
  if (direct) {
    return direct;
  }
  const lastSegment = trackParent.split('/').filter(Boolean).pop() || '';
  if (/^(?:cd|disc)\s*0*\d+$/i.test(lastSegment)) {
    const parentAlbumPath = getParentLibraryPath(trackParent);
    if (parentAlbumPath && folderArtworkByFolderPath[parentAlbumPath]) {
      return folderArtworkByFolderPath[parentAlbumPath];
    }
  }
  return undefined;
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
  coverMosaicGrid: {
    width: '100%',
    height: '100%',
    borderRadius: 18,
    overflow: 'hidden',
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  coverMosaicTile: {
    width: '50%',
    height: '50%',
  },
  coverMosaicImage: {
    width: '100%',
    height: '100%',
  },
  coverMosaicPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: theme.mode === 'dark' ? '#2f3342' : '#d8deea',
  },
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
  appPinnedBadge: {
    marginTop: 6,
    minWidth: 22,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.mode === 'dark' ? '#1e3047' : '#dce9ff',
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#355379' : '#c2d7ff',
  },
  appPinnedBadgeIcon: {
    fontSize: 11,
    color: theme.mode === 'dark' ? '#8cc6ff' : '#2f57a8',
  },
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
  playerTitleMarqueeOverlay: { position: 'absolute', left: 0, right: 0 },
  playerTitleMarqueeText: { textAlign: 'left' },
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
  emptyStatePlain: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: bottomInset + 48,
  },
  emptyStateText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  debugTextCentered: { fontSize: 11, color: theme.colors.textMuted, marginTop: 8, textAlign: 'center' },
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
  notificationsScreenFooter: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  notificationsClearAll: { color: theme.colors.accent, fontSize: 12, fontWeight: '800' },
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
  equalizerBandFreq: { width: 84, fontSize: 11, fontWeight: '700', color: theme.colors.textSecondary },
  equalizerBandValue: { width: 54, textAlign: 'center', fontSize: 11, fontWeight: '800', color: theme.colors.textPrimary },
  equalizerBandButton: { minWidth: 30, minHeight: 30, borderRadius: 10, backgroundColor: theme.mode === 'dark' ? '#202a3f' : '#e9eef6', alignItems: 'center', justifyContent: 'center' },
  equalizerBandButtonDisabled: { opacity: 0.38 },
  equalizerBandButtonText: { fontSize: 16, fontWeight: '800', color: theme.colors.textPrimary },
  equalizerButtonRow: { flexDirection: 'column', gap: 8 },
  equalizerFooter: { marginTop: 10, alignItems: 'flex-end' },
  equalizerActionButton: { minHeight: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.colors.accent, alignItems: 'center', justifyContent: 'center', width: '100%' },
  equalizerActionButtonDisabled: { opacity: 0.45 },
  equalizerActionText: { color: '#f7fff9', fontSize: 11, fontWeight: '800' },
  equalizerMessage: { fontSize: 11, color: theme.colors.textMuted },
  equalizerHistory: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  equalizerHistoryChip: { paddingHorizontal: 10, minHeight: 28, borderRadius: 99, backgroundColor: theme.mode === 'dark' ? '#24304a' : '#e8eff8', alignItems: 'center', justifyContent: 'center' },
  equalizerHistoryChipText: { fontSize: 11, color: theme.colors.textPrimary, fontWeight: '700' },
  equalizerDropdownWrap: { gap: 6 },
  equalizerDropdownTrigger: {
    minHeight: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2d3a53' : '#d9e3f1',
    backgroundColor: theme.mode === 'dark' ? '#182438' : '#eef4fb',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  equalizerDropdownText: { fontSize: 12, color: theme.colors.textPrimary, fontWeight: '700', flex: 1 },
  equalizerDropdownCaret: { fontSize: 11, color: theme.colors.textMuted, marginLeft: 8 },
  equalizerDropdownList: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.mode === 'dark' ? '#2d3a53' : '#d9e3f1',
    backgroundColor: theme.mode === 'dark' ? '#141f31' : '#f7faff',
    overflow: 'hidden',
  },
  equalizerDropdownItem: { minHeight: 34, paddingHorizontal: 10, justifyContent: 'center' },
  equalizerDropdownItemText: { fontSize: 12, color: theme.colors.textPrimary, fontWeight: '700' },
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
    zIndex: 30,
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
  libraryProgressRail: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: bottomInset + 76,
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.mode === 'dark' ? 'rgba(66, 80, 104, 0.52)' : 'rgba(171, 186, 209, 0.46)',
    zIndex: 31,
    overflow: 'hidden',
  },
  libraryProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
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
  tabIcon: { color: theme.mode === 'dark' ? '#dde6f8' : '#606b81', fontSize: 30, fontWeight: '700' },
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

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, timeoutErrorMessage: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutErrorMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const loadMetadataForUrisChunked = async (
  uris: string[],
  chunkSize = 96,
  onProgress?: (processed: number, total: number) => void,
  onChunkRows?: (chunkRows: IAudioFileMetadata[]) => void,
): Promise<IAudioFileMetadata[]> => {
  const normalizedUris = Array.from(new Set(uris.filter(Boolean)));
  const rows: IAudioFileMetadata[] = [];
  const chunks: string[][] = [];
  for (let index = 0; index < normalizedUris.length; index += chunkSize) {
    chunks.push(normalizedUris.slice(index, index + chunkSize));
  }
  if (onProgress) {
    onProgress(0, normalizedUris.length);
  }
  const concurrency = 2;
  let pointer = 0;
  let processed = 0;
  while (pointer < chunks.length) {
    const batch = chunks.slice(pointer, pointer + concurrency);
    const batchRows = await Promise.all(batch.map((chunk) => loadMetadataForUris(chunk)));
    batchRows.forEach((chunkRows) => {
      rows.push(...chunkRows);
      if (onChunkRows) {
        onChunkRows(chunkRows);
      }
    });
    processed += batch.reduce((sum, chunk) => sum + chunk.length, 0);
    if (onProgress) {
      onProgress(processed, normalizedUris.length);
    }
    pointer += concurrency;
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

const shuffleLibraryItemsAvoidingAdjacentAlbumRepeats = (items: ILauncherListItem[]): ILauncherListItem[] => {
  const tracks = items.filter((track) => track.collectionType === 'track' && !!track.sourceUri);
  if (tracks.length <= 1) {
    return tracks;
  }
  const groupsByAlbum = new Map<string, ILauncherListItem[]>();
  tracks.forEach((track) => {
    const albumKey = String(track.meta || track.sourceUri || track.id);
    const existing = groupsByAlbum.get(albumKey);
    if (existing) {
      existing.push(track);
    } else {
      groupsByAlbum.set(albumKey, [track]);
    }
  });
  const groups = Array.from(groupsByAlbum.values()).map((group) => shuffleItems(group));
  let previousAlbumKey = '';
  const queue: ILauncherListItem[] = [];
  while (queue.length < tracks.length) {
    const candidates = groups
      .map((group, groupIndex) => ({ group, groupIndex }))
      .filter(({ group }) => group.length > 0)
      .filter(({ group }) => String(group[0]?.meta || group[0]?.sourceUri || group[0]?.id) !== previousAlbumKey);
    const fallbackCandidates = groups
      .map((group, groupIndex) => ({ group, groupIndex }))
      .filter(({ group }) => group.length > 0);
    const sourceCandidates = candidates.length > 0 ? candidates : fallbackCandidates;
    if (sourceCandidates.length === 0) {
      break;
    }
    const selected = sourceCandidates[Math.floor(Math.random() * sourceCandidates.length)];
    const nextTrack = selected.group.shift();
    if (!nextTrack) {
      continue;
    }
    queue.push(nextTrack);
    previousAlbumKey = String(nextTrack.meta || nextTrack.sourceUri || nextTrack.id);
  }
  return queue;
};

const mapMetadataToLibraryItems = (
  metadataRows: IAudioFileMetadata[],
  mode: LibraryMode,
  rootUris: string[],
): ILauncherListItem[] => {
  const audioRows = metadataRows.filter(isAudioRow);
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
    audioRows.forEach((row) => {
      const folderKey = getAlbumFolderKeyFromUri(row.uri, rootUris);
      const bucket = byFolder.get(folderKey);
      if (bucket) {
        bucket.push(row);
      } else {
        byFolder.set(folderKey, [row]);
      }
    });
    const unsortedItems = Array.from(byFolder.entries()).map(([folderKey, rows]) => {
      const first = rows[0];
      const folderLabel = decodeURIComponent(folderKey.split('/').pop() || 'Ordner');
      
      // Determine the most frequent artist to represent the "Album Artist"
      // instead of hardcoding 'Various Artists'
      const artistCounts = new Map<string, number>();
      const albumArtistCounts = new Map<string, number>();
      rows.forEach((row) => {
        const artist = String(row.artist || '').trim();
        if (artist) {
          artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
        }
        const albumArtist = String(row.albumArtist || '').trim();
        if (albumArtist) {
          albumArtistCounts.set(albumArtist, (albumArtistCounts.get(albumArtist) || 0) + 1);
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
      let bestAlbumArtist = '';
      let maxAlbumArtistCount = 0;
      albumArtistCounts.forEach((count, artist) => {
        if (count > maxAlbumArtistCount) {
          maxAlbumArtistCount = count;
          bestAlbumArtist = artist;
        }
      });
      const collectionEval = evaluateCollectionClassification(rows, folderKey);
      const isMixedAlbum = collectionEval.isCollection;
      const distinctArtworks = Array.from(new Set(
        rows
          .map((row) => String(row.artworkUri || '').trim())
          .filter((uri): uri is string => !!uri),
      ));
      const randomizedArtworks = distinctArtworks
        .slice()
        .sort((left, right) => hashStableInt(`${folderKey}|${left}`) - hashStableInt(`${folderKey}|${right}`));
      const fallbackArtwork = distinctArtworks[0] || first.artworkUri;
      const mosaicArtworks = isMixedAlbum
        ? (randomizedArtworks.length >= 2
          ? (() => {
            const selected = randomizedArtworks.slice(0, 4);
            while (selected.length < 4 && randomizedArtworks.length > 0) {
              selected.push(randomizedArtworks[selected.length % randomizedArtworks.length]);
            }
            return selected;
          })()
          : (fallbackArtwork
            ? [fallbackArtwork, fallbackArtwork, fallbackArtwork, fallbackArtwork]
            : ['tile://0', 'tile://1', 'tile://2', 'tile://3']))
        : undefined;
      
      const normalizedBestAlbumArtist = String(bestAlbumArtist || '').trim();
      const albumArtistIsVariousArtists = normalizedBestAlbumArtist.toLowerCase() === 'various artists';
      const shouldUseMosaicCover = isMixedAlbum;
      const subtitle = isMixedAlbum
        ? 'Various Artists'
        : (albumArtistIsVariousArtists
          ? 'Various Artists'
          : (normalizedBestAlbumArtist || bestArtist));

      // Attempt to get Album title from metadata of the first track
      // If it exists, use it, otherwise use folder name
      let albumTitle = sanitizeAlbumLabel(first.album);
      if (isMixedAlbum) {
        albumTitle = folderLabel || 'Sammlung';
      }
      if (!albumTitle) {
         albumTitle = folderLabel || 'Ordner';
      }

      return {
        id: `album:${folderKey}`,
        title: albumTitle,
        subtitle,
        meta: folderKey,
        artworkUri: shouldUseMosaicCover ? undefined : fallbackArtwork,
        mosaicArtworks: shouldUseMosaicCover ? mosaicArtworks : undefined,
        sourceUri: folderKey,
        collectionType: 'album' as const,
      } as ILauncherListItem;
    });
    return sortAlbumItems(unsortedItems);
  }
  if (mode === 'playlists') {
    return [];
  }
  const sortedRows = metadataRows
    .filter(isAudioRow)
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
  albumItemsVersion?: number;
  albumItems?: ILauncherListItem[];
  titleItemsVersion?: number;
  titleItems?: ILauncherListItem[];
  playlistEntries?: IPlaylistEntry[];
  scannedAt?: number;
}

const getMusicLibraryCacheFileUri = (): string | null => {
  const baseDir = FileSystem.documentDirectory || FileSystem.cacheDirectory || '';
  if (!baseDir) {
    return null;
  }
  return `${baseDir}${MUSIC_LIBRARY_CACHE_FILE_NAME}`;
};

const getMusicLibraryDirectoryFileUri = (): string | null => {
  const baseDir = FileSystem.documentDirectory || FileSystem.cacheDirectory || '';
  if (!baseDir) {
    return null;
  }
  return `${baseDir}${MUSIC_LIBRARY_DIRECTORY_FILE_NAME}`;
};

const readLibraryDirectoryUrisSnapshot = async (): Promise<string[] | null> => {
  const fileUri = getMusicLibraryDirectoryFileUri();
  if (!fileUri) {
    return null;
  }
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      return null;
    }
    const raw = await FileSystem.readAsStringAsync(fileUri);
    const parsed = sanitizeDirectoryUris(JSON.parse(raw) as string[]);
    return parsed.length > 0 ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const writeLibraryDirectoryUrisSnapshot = async (uris: string[]): Promise<void> => {
  const fileUri = getMusicLibraryDirectoryFileUri();
  if (!fileUri) {
    return;
  }
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(uris), {
    encoding: FileSystem.EncodingType.UTF8,
  });
};

const readMusicLibraryCacheSnapshot = async (): Promise<ILibraryCacheSnapshot | null> => {
  const fileUri = getMusicLibraryCacheFileUri();
  if (!fileUri) {
    return null;
  }
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      return null;
    }
    const raw = await FileSystem.readAsStringAsync(fileUri);
    const parsed = JSON.parse(raw) as ILibraryCacheSnapshot;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const writeMusicLibraryCacheSnapshot = async (snapshot: ILibraryCacheSnapshot): Promise<void> => {
  const fileUri = getMusicLibraryCacheFileUri();
  if (!fileUri) {
    return;
  }
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(snapshot), {
    encoding: FileSystem.EncodingType.UTF8,
  });
};

const mergeArtworkIntoMusicLibraryCacheSnapshot = async (
  rootsKey: string,
  artworkByUri: Record<string, string>,
): Promise<void> => {
  if (!rootsKey || Object.keys(artworkByUri).length === 0) {
    return;
  }
  const snapshot = await readMusicLibraryCacheSnapshot();
  if (!snapshot || snapshot.rootsKey !== rootsKey) {
    return;
  }
  const rowsByUri = { ...(snapshot.rowsByUri || {}) };
  Object.entries(artworkByUri).forEach(([uri, artworkUri]) => {
    const row = rowsByUri[uri];
    if (!row) {
      return;
    }
    rowsByUri[uri] = {
      ...row,
      artworkUri,
    };
  });
  const rootList = rootsKey.split('|').filter(Boolean);
  const rowValues = Object.values(rowsByUri);
  await writeMusicLibraryCacheSnapshot({
    ...snapshot,
    rowsByUri,
    albumItemsVersion: ALBUM_ITEMS_CACHE_VERSION,
    albumItems: mapMetadataToLibraryItems(rowValues, 'albums', rootList),
    titleItemsVersion: TITLE_ITEMS_CACHE_VERSION,
    titleItems: mapMetadataToLibraryItems(rowValues, 'titles', rootList),
  });
};

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
  const [cachedAlbumItems, setCachedAlbumItems] = useState<ILauncherListItem[]>([]);
  const [settingsItems, setSettingsItems] = useState<ILauncherListItem[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [contentReason, setContentReason] = useState<'not-android' | 'module-missing' | 'module-error' | undefined>(undefined);

  const [apps, setApps] = useState<IInstalledLauncherApp[]>([]);
  const [appsSearch, setAppsSearch] = useState('');
  const [pinnedAppPackages, setPinnedAppPackages] = useState<string[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [appsReason, setAppsReason] = useState<'not-android' | 'module-missing' | 'module-error' | undefined>(undefined);
  const [appsLoadedOnce, setAppsLoadedOnce] = useState(false);
  const [refreshingApps, setRefreshingApps] = useState(false);

  const [showLauncherPrompt, setShowLauncherPrompt] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsVisible, setNotificationsVisible] = useState(false);
  const [notifications, setNotifications] = useState<ILauncherNotification[]>([]);
  const [notificationAccessGranted, setNotificationAccessGranted] = useState(false);
  const [dlnaRendererEnabled, setDlnaRendererEnabled] = useState(true);
  const [selectedLibraryDirectoryUris, setSelectedLibraryDirectoryUris] = useState<string[]>([]);
  const libraryDirectoryUrisReadyRef = useRef(false);
  const [refreshingLibrary, setRefreshingLibrary] = useState(false);
  const [libraryReloadToken, setLibraryReloadToken] = useState(0);
  const [libraryMetadataRows, setLibraryMetadataRows] = useState<IAudioFileMetadata[]>([]);
  const [preAggregatedAlbumItems, setPreAggregatedAlbumItems] = useState<{ rowCount: number; items: ILauncherListItem[] } | null>(null);
  const [preAggregatedTitleItems, setPreAggregatedTitleItems] = useState<{ rowCount: number; items: ILauncherListItem[] } | null>(null);
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
  const [libraryLoadProgress, setLibraryLoadProgress] = useState(0);
  const [librarySyncInProgress, setLibrarySyncInProgress] = useState(false);
  const [equalizerOpen, setEqualizerOpen] = useState(false);
  const [equalizerSettings, setEqualizerSettings] = useState<IEqualizerSettings>(createDefaultEqualizerSettings());
  const [equalizerMessage, setEqualizerMessage] = useState('');
  const [equalizerProfileDropdownOpen, setEqualizerProfileDropdownOpen] = useState(false);
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
  const playerStatusLastUiUpdateAtRef = useRef(0);
  const playerStatusLastDlnaSyncAtRef = useRef(0);
  const lastDlnaTrackSyncKeyRef = useRef('');
  const notificationsAnim = useRef(new Animated.Value(0)).current;
  const playerTitleAnim = useRef(new Animated.Value(0)).current;
  const mainTabRef = useRef<MainTab>('library');
  const lastUserInteractionAtRef = useRef(0);
  const startupT0Ref = useRef(0);
  const startupAlbumsVisibleLoggedRef = useRef(false);
  const collectionArtworkHydrationInFlightRef = useRef(false);
  const attemptedCollectionArtworkUrisRef = useRef<Set<string>>(new Set());
  const albumRenderStartAtRef = useRef(0);
  const albumRenderedIdsRef = useRef<Set<string>>(new Set());
  const albumFirstTenLoggedRef = useRef(false);
  const albumAllLoggedRef = useRef(false);
  const albumTargetCountRef = useRef(0);
  const playbackOperationTailRef = useRef<Promise<void>>(Promise.resolve());
  const playbackRequestVersionRef = useRef(0);
  const playbackRequestStartedAtRef = useRef(0);
  const albumTracksByFolderRef = useRef<Record<string, ILauncherListItem[]>>({});
  const albumListRef = useRef<FlatList<ILauncherListItem> | null>(null);
  const titlesListRef = useRef<SectionList<ILauncherListItem> | null>(null);
  const albumScrollOffsetRef = useRef(0);
  const titlesScrollOffsetRef = useRef(0);
  /** Last user positions while on Bibliothek — not overwritten by remount scroll y=0 */
  const albumScrollOffsetSavedRef = useRef(0);
  const titlesScrollOffsetSavedRef = useRef(0);
  const libraryTabTransitionRef = useRef<{ tab: MainTab; mode: LibraryMode }>({ tab: 'library', mode: 'albums' });
  const pendingRestoreModeRef = useRef<LibraryMode | null>(null);
  const pendingRestoreRetriesRef = useRef(0);
  const pendingRestoreTargetYRef = useRef(0);
  const pendingRestoreLastActualYRef = useRef(-1);
  const isProgrammaticScrollRef = useRef(false);
  /** Album opened from grid (short press) — used to scroll back when returning to Alben. */
  const lastOpenedAlbumFolderKeyRef = useRef<string | undefined>(undefined);
  const pendingAlbumGridScrollFolderKeyRef = useRef<string | undefined>(undefined);
  const titleViewTransitionStartRef = useRef(0);
  const titleViewReadyLoggedRef = useRef(false);
  const albumToTitlesTransitionStartRef = useRef(0);
  const titlesToAlbumsTransitionStartRef = useRef(0);
  const albumListRenderProfile = useMemo(() => {
    const totalMemory = Number(Device.totalMemory || 0);
    const isLowMemoryDevice = totalMemory > 0 && totalMemory <= (3 * 1024 * 1024 * 1024);
    const isMidMemoryDevice = totalMemory > (3 * 1024 * 1024 * 1024) && totalMemory <= (6 * 1024 * 1024 * 1024);
    if (isLowMemoryDevice) {
      return {
        initialNumToRender: 10,
        maxToRenderPerBatch: 12,
        windowSize: 5,
        updateCellsBatchingPeriod: 60,
      };
    }
    if (isMidMemoryDevice) {
      return {
        initialNumToRender: 12,
        maxToRenderPerBatch: 16,
        windowSize: 6,
        updateCellsBatchingPeriod: 48,
      };
    }
    return {
      initialNumToRender: 16,
      maxToRenderPerBatch: 20,
      windowSize: 7,
      updateCellsBatchingPeriod: 40,
    };
  }, []);

  const albumGridRowHeight = useMemo(() => {
    const contentW = Math.max(0, dimensions.width - 32);
    const cell = contentW * 0.48;
    return cell + 8 + 15 + 2 + 13 + 24;
  }, [dimensions.width]);

  const getAlbumItemLayout = useCallback(
    (_data: ArrayLike<ILauncherListItem> | null | undefined, index: number) => {
      const row = Math.floor(index / 2);
      return { length: albumGridRowHeight, offset: row * albumGridRowHeight, index };
    },
    [albumGridRowHeight],
  );

  useEffect(() => {
    mainTabRef.current = mainTab;
  }, [mainTab]);

  useLayoutEffect(() => {
    const prev = libraryTabTransitionRef.current;
    if (prev.tab === 'library' && mainTab === 'player') {
      if (prev.mode === 'titles') {
        titlesScrollOffsetSavedRef.current = Math.max(0, titlesScrollOffsetRef.current);
      } else {
        albumScrollOffsetSavedRef.current = Math.max(0, albumScrollOffsetRef.current);
      }
    }
    libraryTabTransitionRef.current = { tab: mainTab, mode: libraryMode };
  }, [mainTab, libraryMode]);

  const restoreLibraryScrollPosition = useCallback((mode: LibraryMode) => {
    if (mainTabRef.current !== 'library') {
      return;
    }
    if (pendingRestoreModeRef.current !== mode) {
      return;
    }
    const targetY = mode === 'titles'
      ? Math.max(0, titlesScrollOffsetSavedRef.current)
      : Math.max(0, albumScrollOffsetSavedRef.current);
    if (targetY <= 1) {
      pendingRestoreModeRef.current = null;
      pendingRestoreRetriesRef.current = 0;
      pendingRestoreLastActualYRef.current = -1;
      return;
    }
    pendingRestoreTargetYRef.current = targetY;
    pendingRestoreLastActualYRef.current = -1;
    isProgrammaticScrollRef.current = true;
    if (mode === 'titles') {
      titlesListRef.current?.getScrollResponder()?.scrollTo({ x: 0, y: targetY, animated: false });
    } else {
      albumListRef.current?.scrollToOffset({ offset: targetY, animated: false });
    }
    setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 140);

    const verify = () => {
      if (mainTabRef.current !== 'library' || pendingRestoreModeRef.current !== mode) {
        return;
      }
      const actual = mode === 'titles'
        ? titlesScrollOffsetRef.current
        : albumScrollOffsetRef.current;
      const target = pendingRestoreTargetYRef.current;
      const delta = Math.abs(actual - target);
      if (delta <= 128) {
        pendingRestoreModeRef.current = null;
        pendingRestoreRetriesRef.current = 0;
        pendingRestoreLastActualYRef.current = -1;
        return;
      }
      if (
        pendingRestoreRetriesRef.current >= 5
        && pendingRestoreLastActualYRef.current >= 0
        && Math.abs(actual - pendingRestoreLastActualYRef.current) < 2
      ) {
        pendingRestoreModeRef.current = null;
        pendingRestoreRetriesRef.current = 0;
        pendingRestoreLastActualYRef.current = -1;
        return;
      }
      pendingRestoreLastActualYRef.current = actual;
      if (pendingRestoreRetriesRef.current >= 28) {
        pendingRestoreModeRef.current = null;
        pendingRestoreRetriesRef.current = 0;
        pendingRestoreLastActualYRef.current = -1;
        return;
      }
      pendingRestoreRetriesRef.current += 1;
      isProgrammaticScrollRef.current = true;
      if (mode === 'titles') {
        titlesListRef.current?.getScrollResponder()?.scrollTo({ x: 0, y: target, animated: false });
      } else {
        albumListRef.current?.scrollToOffset({ offset: target, animated: false });
      }
      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 140);
      setTimeout(verify, 72);
    };
    setTimeout(verify, 56);
  }, []);

  useEffect(() => {
    if (mainTab !== 'library') {
      return;
    }
    pendingRestoreModeRef.current = libraryMode;
    pendingRestoreRetriesRef.current = 0;
    restoreLibraryScrollPosition(libraryMode);
    return () => undefined;
  }, [mainTab, libraryMode, restoreLibraryScrollPosition]);

  const onAlbumListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = Math.max(0, event.nativeEvent.contentOffset.y || 0);
    albumScrollOffsetRef.current = y;
    lastUserInteractionAtRef.current = Date.now();
    if (!isProgrammaticScrollRef.current && mainTabRef.current === 'library') {
      albumScrollOffsetSavedRef.current = y;
      pendingRestoreModeRef.current = null;
      pendingRestoreRetriesRef.current = 0;
      pendingRestoreLastActualYRef.current = -1;
    }
  };

  const onTitlesListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = Math.max(0, event.nativeEvent.contentOffset.y || 0);
    titlesScrollOffsetRef.current = y;
    lastUserInteractionAtRef.current = Date.now();
    if (!isProgrammaticScrollRef.current && mainTabRef.current === 'library') {
      titlesScrollOffsetSavedRef.current = y;
      pendingRestoreModeRef.current = null;
      pendingRestoreRetriesRef.current = 0;
      pendingRestoreLastActualYRef.current = -1;
    }
  };

  const onAlbumListContentSizeChange = () => {
    if (mainTabRef.current === 'library' && pendingRestoreModeRef.current === 'albums') {
      restoreLibraryScrollPosition('albums');
    }
  };

  const onTitlesListContentSizeChange = () => {
    if (mainTabRef.current === 'library' && pendingRestoreModeRef.current === 'titles') {
      restoreLibraryScrollPosition('titles');
    }
  };

  useEffect(() => {
    attemptedCollectionArtworkUrisRef.current.clear();
    collectionArtworkHydrationInFlightRef.current = false;
    albumTracksByFolderRef.current = {};
    setCachedAlbumItems([]);
    setPreAggregatedAlbumItems(null);
    setPreAggregatedTitleItems(null);
  }, [selectedLibraryDirectoryUris, libraryReloadToken]);

  useEffect(() => {
    startupT0Ref.current = Date.now();
    startupAlbumsVisibleLoggedRef.current = false;
    console.log('[StartupMetric] APP_MOUNT');
  }, []);

  useEffect(() => {
    if (startupAlbumsVisibleLoggedRef.current) {
      return;
    }
    if (mainTab !== 'library' || libraryMode !== 'albums' || libraryItems.length === 0) {
      return;
    }
    startupAlbumsVisibleLoggedRef.current = true;
    const elapsedMs = Math.max(0, Date.now() - startupT0Ref.current);
    console.log(`[StartupMetric] ALBUMS_VISIBLE elapsedMs=${elapsedMs} count=${libraryItems.length}`);
  }, [mainTab, libraryMode, libraryItems.length]);

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
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33) {
      return;
    }
    const postNotificationsPermission = ((PermissionsAndroid.PERMISSIONS as Record<string, string>).POST_NOTIFICATIONS
      || 'android.permission.POST_NOTIFICATIONS') as any;
    PermissionsAndroid.check(postNotificationsPermission)
      .then((granted) => {
        if (granted) {
          return;
        }
        return PermissionsAndroid.request(postNotificationsPermission);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    let cancelled = false;
    const syncPlaybackState = () => {
      if (cancelled || !dlnaRendererEnabled) {
        return;
      }
      const sound = soundRef.current;
      if (!sound) {
        return;
      }
      sound.getStatusAsync()
        .then((status) => {
          if (cancelled || !status.isLoaded) {
            return;
          }
          const positionMs = Math.max(0, Number(status.positionMillis || 0));
          const durationMs = Math.max(0, Number(status.durationMillis || 0));
          const playbackState: 'playing' | 'paused' | 'stopped' = status.isPlaying ? 'playing' : 'paused';
          updateDLNAPlaybackState(playbackState, positionMs, durationMs).catch(() => undefined);
          const activeQueue = queueRef.current;
          const activeIndex = queueIndexRef.current;
          if (activeIndex < 0 || activeIndex >= activeQueue.length) {
            return;
          }
          const activeTrack = activeQueue[activeIndex];
          const sourceUri = String(activeTrack?.sourceUri || activeTrack?.id || '');
          if (!sourceUri) {
            return;
          }
          const nextTrackSyncKey = `${sourceUri}|${activeIndex}|${activeQueue.length}`;
          if (nextTrackSyncKey === lastDlnaTrackSyncKeyRef.current) {
            return;
          }
          lastDlnaTrackSyncKeyRef.current = nextTrackSyncKey;
          updateDLNAPlaybackTrack(
            sourceUri,
            String(activeTrack?.title || ''),
            String(activeTrack?.subtitle || activeTrack?.meta || ''),
            String(activeTrack?.artworkUri || ''),
            activeIndex,
            activeQueue.length,
          ).catch(() => undefined);
        })
        .catch(() => undefined);
    };
    syncPlaybackState();
    const heartbeat = setInterval(syncPlaybackState, 2500);
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
    };
  }, [dlnaRendererEnabled]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    setMediaControlSessionActive(true).catch(() => undefined);
    const subs = [
      MediaControlEventEmitter.addListener('MEDIA_CONTROL_COMMAND', (payload: { command?: string }) => {
        const command = String(payload?.command || '').toLowerCase();
        if (command === 'play_pause') {
          void togglePlayPause();
          return;
        }
        if (command === 'play') {
          void playPlayer();
          return;
        }
        if (command === 'pause') {
          void pausePlayer();
          return;
        }
        if (command === 'next') {
          void nextTrack();
          return;
        }
        if (command === 'previous') {
          void prevTrack();
        }
      }),
    ];
    return () => {
      subs.forEach((sub) => sub.remove());
      setMediaControlSessionActive(false).catch(() => undefined);
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
    const manualEqEnabled = !equalizerSettings.autoEqEnabled;
    applyAudioEffects(equalizerSettings.bands, equalizerSettings.preampDb, manualEqEnabled).catch(() => undefined);
    setAudioEffectsEnabled(manualEqEnabled).catch(() => undefined);
  }, [equalizerSettings]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    updateMediaControlPlaybackTrack(
      String(playerTrack || 'Aurora Pulse'),
      String(playerMeta || 'Aurora Pulse'),
      String(playQueue[playQueueIndex]?.meta || 'Aurora Pulse'),
      String(playerArtworkUri || ''),
      Math.max(0, playQueueIndex),
      Math.max(1, playQueue.length),
      Math.max(0, playerDurationMs),
      equalizerSettings.autoEqEnabled ? String(equalizerSettings.autoEqProfile?.name || '') : '',
    ).catch(() => undefined);
    updateMediaControlPlaybackState(
      playerState === 'playing' ? 'playing' : 'paused',
      Math.max(0, playerPositionMs),
      Math.max(0, playerDurationMs),
    ).catch(() => undefined);
  }, [
    playerTrack,
    playerMeta,
    playerArtworkUri,
    playQueue,
    playQueueIndex,
    playerDurationMs,
    playerPositionMs,
    playerState,
    equalizerSettings.autoEqEnabled,
    equalizerSettings.autoEqProfile?.name,
  ]);

  useEffect(() => {
    let active = true;
    const loadDirectoryUris = async () => {
      try {
        const fileUris = await readLibraryDirectoryUrisSnapshot();
        if (active && fileUris && fileUris.length > 0) {
          setSelectedLibraryDirectoryUris(fileUris);
          console.log(`[StartupMetric] DIRS_FROM_FILE count=${fileUris.length}`);
          return;
        }
        const value = await AsyncStorage.getItem(MUSIC_LIBRARY_DIRECTORY_STORAGE_KEY).catch(() => null);
        if (!active || !value) {
          return;
        }
        try {
          const parsedUris = sanitizeDirectoryUris(JSON.parse(value) as string[]);
          if (parsedUris.length > 0) {
            setSelectedLibraryDirectoryUris(parsedUris);
            writeLibraryDirectoryUrisSnapshot(parsedUris).catch(() => undefined);
            console.log(`[StartupMetric] DIRS_FROM_ASYNC_STORAGE count=${parsedUris.length}`);
            return;
          }
        } catch (_error) {
        }
        if (value.startsWith('content://')) {
          const migrated = [value];
          setSelectedLibraryDirectoryUris(migrated);
          writeLibraryDirectoryUrisSnapshot(migrated).catch(() => undefined);
          console.log('[StartupMetric] DIRS_FROM_ASYNC_STORAGE_LEGACY count=1');
        }
      } finally {
        libraryDirectoryUrisReadyRef.current = true;
      }
    };
    void loadDirectoryUris();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    isDLNARendererEnabled()
      .then((enabled) => {
        if (active) {
          setDlnaRendererEnabled(enabled);
          if (enabled) {
            setDLNARendererEnabled(true).catch(() => undefined);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (mainTab !== 'settings') {
      return;
    }
    let active = true;
    setLoadingContent(true);
    loadRouteSections(resolveRoute(mainTab, libraryMode))
      .then((result) => {
        if (!active) {
          return;
        }
        const flatItems = result.sections.flatMap((section) => section.items);
        const mappedSettings = flatItems
          .filter(isSettingItem)
          .map((item) => (
            item.id === 'set-audio'
              ? {
                ...item,
                subtitle: dlnaRendererEnabled
                  ? 'Lokale Ausgabe und DLNA aktiv'
                  : 'Lokale Ausgabe aktiv, DLNA deaktiviert',
                meta: dlnaRendererEnabled ? 'AN' : 'AUS',
              }
              : item
          ));
        const hasAudioToggle = mappedSettings.some((item) => item.id === 'set-audio');
        const baseSettings: ILauncherListItem[] = hasAudioToggle
          ? mappedSettings
          : [
            ...mappedSettings,
            {
              id: 'set-audio',
              title: 'Audioausgabe',
              subtitle: dlnaRendererEnabled
                ? 'Lokale Ausgabe und DLNA aktiv'
                : 'Lokale Ausgabe aktiv, DLNA deaktiviert',
              meta: dlnaRendererEnabled ? 'AN' : 'AUS',
              collectionType: 'setting' as const,
            },
          ];
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
      })
      .catch(() => {
        if (active) {
          setSettingsItems([]);
          setContentReason('module-error');
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
  }, [mainTab, libraryMode, dlnaRendererEnabled]);

  useEffect(() => {
    let active = true;
    console.log(`[StartupMetric] LOAD_EFFECT_TRIGGER uris=${selectedLibraryDirectoryUris.length} reload=${libraryReloadToken}`);
    const loadData = async () => {
      console.log('[StartupMetric] LOAD_DATA_START');
      const setProgress = (value: number) => {
        if (!active) {
          return;
        }
        setLibraryLoadProgress(Math.max(0, Math.min(1, value)));
      };
      try {
        if (!libraryDirectoryUrisReadyRef.current) {
          return;
        }
        if (selectedLibraryDirectoryUris.length === 0) {
          if (active) {
            setLibraryItems([]);
            setLibraryMetadataRows([]);
            setPlaylistEntries([]);
            setContentReason('module-error');
            setLibraryDebugInfo('Keine Bibliotheksordner ausgewählt');
            setLoadingContent(false);
            setLibrarySyncInProgress(false);
          }
          return;
        }
        if (active) {
          setLibrarySyncInProgress(false);
        }
        const rootsKey = [...selectedLibraryDirectoryUris].sort().join('|');
        const syncRequested = refreshingLibrary || libraryReloadToken > 0;
        const startupSnapshot = await readMusicLibraryCacheSnapshot();
        const startupRowsByUri = startupSnapshot?.rootsKey === rootsKey ? (startupSnapshot.rowsByUri || {}) : {};
        const startupRows = Object.values(startupRowsByUri);
        console.log(`[StartupMetric] SNAPSHOT_PARSED rows=${startupRows.length}`);
        if (active && startupRows.length > 0) {
          setLibraryMetadataRows(startupRows);
          const cachedAlbumItems = startupSnapshot?.albumItemsVersion === ALBUM_ITEMS_CACHE_VERSION
            ? (startupSnapshot?.albumItems || [])
            : [];
          if (cachedAlbumItems.length > 0) {
            setPreAggregatedAlbumItems({ rowCount: startupRows.length, items: cachedAlbumItems });
            if (mainTab === 'library' && libraryMode === 'albums') {
              albumRenderStartAtRef.current = Date.now();
              albumRenderedIdsRef.current = new Set();
              albumFirstTenLoggedRef.current = false;
              albumAllLoggedRef.current = false;
              albumTargetCountRef.current = cachedAlbumItems.length;
              setLibraryItems(cachedAlbumItems);
              console.log(`[StartupMetric] ALBUM_DATA_READY count=${cachedAlbumItems.length} source=snapshot`);
            }
          }
          const cachedTitleItems = startupSnapshot?.titleItemsVersion === TITLE_ITEMS_CACHE_VERSION
            ? (startupSnapshot?.titleItems || [])
            : [];
          if (cachedTitleItems.length > 0) {
            setPreAggregatedTitleItems({ rowCount: startupRows.length, items: cachedTitleItems });
          }
          setLoadingContent(false);
          setProgress(1);
          const elapsedMs = Math.max(0, Date.now() - startupT0Ref.current);
          console.log(`[StartupMetric] SNAPSHOT_VISIBLE elapsedMs=${elapsedMs} rows=${startupRows.length}`);
          if ((startupSnapshot?.playlistEntries || []).length > 0) {
            setPlaylistEntries(startupSnapshot?.playlistEntries || []);
          }
          if (!syncRequested) {
            setLibraryDebugInfo(`CacheSnapshot · Rows: ${startupRows.length} · Kein Auto-Sync`);
            setLibrarySyncInProgress(false);
            return;
          }
        }
        const nativeCachedRows = startupRows.length > 0 ? [] : await getLibraryCachedRows(selectedLibraryDirectoryUris);
        if (active && nativeCachedRows.length > 0) {
          setLibraryMetadataRows(nativeCachedRows);
          setLoadingContent(false);
          setProgress(1);
          const elapsedMs = Math.max(0, Date.now() - startupT0Ref.current);
          console.log(`[StartupMetric] NATIVE_CACHE_VISIBLE elapsedMs=${elapsedMs} rows=${nativeCachedRows.length}`);
          if (!syncRequested) {
            setLibraryDebugInfo(`NativeCache · Rows: ${nativeCachedRows.length} · Kein Auto-Sync`);
            setLibrarySyncInProgress(false);
            return;
          }
        }
        const shouldRunInitialSync = !syncRequested && startupRows.length === 0 && nativeCachedRows.length === 0;
        if (!syncRequested && !shouldRunInitialSync) {
          return;
        }
        if (active) {
          setLibrarySyncInProgress(true);
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
              setLibrarySyncInProgress(false);
            }
            return;
          }
        }
        const nativeSyncStarted = await startLibrarySync(selectedLibraryDirectoryUris);
        if (nativeSyncStarted) {
          console.log(`[StartupMetric] SYNC_START background=${shouldRunInitialSync ? 'true' : 'false'}`);
          if (active) {
            setLibrarySyncInProgress(true);
          }
          let lastProcessed = -1;
          let lastTotal = 0;
          let lastRowsRefreshAt = 0;
          let lastRowsRefreshProcessed = 0;
          const syncStartedAt = Date.now();
          for (let tick = 0; tick < 1800; tick += 1) {
            if (!active) {
              break;
            }
            const status: ILibrarySyncStatus = await getLibrarySyncStatus();
            if (!status.rootKey || status.rootKey === rootsKey) {
              if (status.total > 0) {
                const effectiveProcessed = Math.max(0, Math.min(status.total, status.cached + status.processed));
                const ratio = Math.max(0, Math.min(1, effectiveProcessed / status.total));
                setProgress(0.05 + ratio * 0.92);
                lastTotal = status.total;
                const elapsedSec = Math.max(1, Math.floor((Date.now() - syncStartedAt) / 1000));
                const parseRate = status.processed > 0 ? (status.processed / elapsedSec) : 0;
                const remaining = Math.max(0, status.changed - status.processed);
                const etaSec = parseRate > 0 ? Math.ceil(remaining / parseRate) : 0;
                const stageLabel = status.stage || 'parse';
                const etaText = etaSec > 0 ? ` · ETA ${etaSec}s` : '';
                const rateText = parseRate > 0 ? ` · ${parseRate.toFixed(1)}/s` : '';
                setLibraryDebugInfo(
                  `NativeSync · Stage: ${stageLabel} · Total: ${status.total} · Processed: ${status.processed} · Changed: ${status.changed} · Cached: ${status.cached}${rateText}${etaText} · LastError: ${status.lastError || '-'}`,
                );
              }
              const now = Date.now();
              const shouldRefreshRows = status.stage === 'persist'
                || status.stage === 'done'
                || (status.processed - lastRowsRefreshProcessed >= 192)
                || (now - lastRowsRefreshAt >= 3000 && status.processed > 0);
              const userIsInteracting = now - lastUserInteractionAtRef.current < 4500;
              if (status.processed !== lastProcessed && shouldRefreshRows && !userIsInteracting) {
                lastProcessed = status.processed;
                lastRowsRefreshProcessed = status.processed;
                lastRowsRefreshAt = now;
                const rows = await getLibraryCachedRows(selectedLibraryDirectoryUris);
                if (active && rows.length > 0) {
                  setLibraryMetadataRows(rows);
                  setLoadingContent(false);
                }
              }
              if (!status.running) {
                const finalRows = await getLibraryCachedRows(selectedLibraryDirectoryUris);
                if (active && finalRows.length > 0) {
                  setLibraryMetadataRows(finalRows);
                }
                const playlistResult = await listPlaylistEntriesFromRoots(selectedLibraryDirectoryUris);
                if (active) {
                  setPlaylistEntries(playlistResult.entries);
                  const debugLine = `NativeSync · Total: ${status.total} · Processed: ${status.processed} · Changed: ${status.changed} · Cached: ${status.cached} · LastError: ${status.lastError || '-'}`;
                  setLibraryDebugInfo(debugLine);
                  setContentReason(undefined);
                  setProgress(1);
                }
                if (active) {
                  const rowsByUri = (finalRows.length > 0 ? finalRows : startupRows).reduce<Record<string, IAudioFileMetadata>>((acc, row) => {
                    acc[row.uri] = row;
                    return acc;
                  }, {});
                  const lastModifiedByUri = Object.values(rowsByUri).reduce<Record<string, number>>((acc, row) => {
                    acc[row.uri] = Number(row.sourceLastModified || 0);
                    return acc;
                  }, {});
                  const snapshotRows = Object.values(rowsByUri);
                  const albumItems = mapMetadataToLibraryItems(snapshotRows, 'albums', selectedLibraryDirectoryUris);
                  const titleItems = mapMetadataToLibraryItems(snapshotRows, 'titles', selectedLibraryDirectoryUris);
                  const cacheSnapshot: ILibraryCacheSnapshot = {
                    rootsKey,
                    rowsByUri,
                    lastModifiedByUri,
                    albumItems,
                    albumItemsVersion: ALBUM_ITEMS_CACHE_VERSION,
                    titleItems,
                    titleItemsVersion: TITLE_ITEMS_CACHE_VERSION,
                    playlistEntries: playlistResult.entries,
                    scannedAt: Date.now(),
                  };
                  writeMusicLibraryCacheSnapshot(cacheSnapshot).catch(() => undefined);
                  setPreAggregatedAlbumItems({ rowCount: snapshotRows.length, items: albumItems });
                  setPreAggregatedTitleItems({ rowCount: snapshotRows.length, items: titleItems });
                }
                return;
              }
            }
            await sleep(lastTotal > 0 ? 450 : 650);
          }
          if (active) {
            setLibraryDebugInfo('NativeSync läuft weiter im Hintergrund');
            setLibrarySyncInProgress(false);
          }
          return;
        }
        if (active) {
          setLibraryDebugInfo('NativeSync konnte nicht gestartet werden');
          setLibrarySyncInProgress(false);
        }
        return;
        const cachedSnapshot = await readMusicLibraryCacheSnapshot();
        let cachedRowsByUri: Record<string, IAudioFileMetadata> = {};
        let cachedLastModifiedByUri: Record<string, number> = {};
        let cachedPlaylistEntries: IPlaylistEntry[] = [];
        let cachedScannedAt = 0;
        if (cachedSnapshot?.rootsKey === rootsKey) {
          cachedRowsByUri = cachedSnapshot?.rowsByUri || {};
          cachedLastModifiedByUri = cachedSnapshot?.lastModifiedByUri || {};
          cachedPlaylistEntries = cachedSnapshot?.playlistEntries || [];
          cachedScannedAt = Number(cachedSnapshot?.scannedAt || 0);
        }
        if (active && cachedPlaylistEntries.length > 0) {
          setPlaylistEntries(cachedPlaylistEntries);
        }
        const hasCachedRows = Object.keys(cachedRowsByUri).length > 0;
        if (!hasCachedRows) {
          setLoadingContent(true);
          setProgress(0.03);
        }
        if (active && hasCachedRows) {
          const cachedRows = Object.values(cachedRowsByUri);
          setLibraryMetadataRows(cachedRows);
          setLoadingContent(false);
          setProgress(0.2);
        }
        const skipScanBecauseCacheIsFresh = hasCachedRows
          && !refreshingLibrary
          && libraryReloadToken === 0
          && cachedScannedAt > 0
          && (Date.now() - cachedScannedAt) < (15 * 60 * 1000);
        if (skipScanBecauseCacheIsFresh) {
          setProgress(1);
          return;
        }
        setProgress(hasCachedRows ? 0.35 : 0.15);
        let phaseProgress = hasCachedRows ? 0.35 : 0.15;
        const phaseCeiling = hasCachedRows ? 0.55 : 0.45;
        const progressPulse = setInterval(() => {
          phaseProgress = Math.min(phaseCeiling, phaseProgress + 0.012);
          setProgress(phaseProgress);
        }, 280);
        const [listResult, playlistResult] = await Promise.all([
          withTimeout(
            listAudioEntriesFromRoots(selectedLibraryDirectoryUris),
            45000,
            'list-audio-timeout',
          ).catch(() => ({
            entries: [],
            visitedNodes: 0,
            leafNodes: 0,
            readErrors: 1,
            lastError: 'list-audio-timeout',
          folderArtworkByFolderPath: {},
          })),
          withTimeout(
            listPlaylistEntriesFromRoots(selectedLibraryDirectoryUris),
            25000,
            'list-playlist-timeout',
          ).catch(() => ({
            entries: [],
            visitedNodes: 0,
            readErrors: 1,
            lastError: 'list-playlist-timeout',
          })),
        ]).finally(() => {
          clearInterval(progressPulse);
        });
        setProgress(hasCachedRows ? 0.55 : 0.45);
        if (!active) {
          return;
        }
        setPlaylistEntries(playlistResult.entries);
        const folderArtworkByFolderPath = listResult.folderArtworkByFolderPath || {};
        if (listResult.entries.length === 0 && listResult.visitedNodes === 0 && listResult.readErrors > 0) {
          const fallbackUris = await collectUrisWithSafFallback(selectedLibraryDirectoryUris);
          if (!active) {
            return;
          }
          const fallbackRows = await loadMetadataForUrisChunked(
            fallbackUris.slice(0, 2500),
            96,
            (processed, total) => {
              const ratio = total > 0 ? processed / total : 1;
              setProgress(0.55 + (ratio * 0.4));
            },
            (chunkRows) => {
              if (!active || chunkRows.length === 0) {
                return;
              }
              setLibraryMetadataRows((current) => [...current, ...chunkRows]);
            },
          );
          if (!active) {
            return;
          }
          const fallbackDebugLine = `Roots: ${selectedLibraryDirectoryUris.length} · Nodes: 0 · Leafs: ${fallbackUris.length} · ReadErrors: ${listResult.readErrors} · MetadataRows: ${fallbackRows.length} · Delta: fallback · LastError: ${listResult.lastError || '-'}`;
          console.log(`[PulseLibraryScan] ${fallbackDebugLine}`);
          setLibraryDebugInfo(fallbackDebugLine);
          setLibraryMetadataRows(fallbackRows);
          setContentReason(undefined);
          setProgress(1);
          return;
        }
        if (listResult.entries.length === 0 && listResult.leafNodes > 0) {
          const fallbackUris = await collectUrisWithSafFallback(selectedLibraryDirectoryUris);
          if (!active) {
            return;
          }
          const fallbackRows = await loadMetadataForUrisChunked(
            fallbackUris.slice(0, 2500),
            96,
            (processed, total) => {
              const ratio = total > 0 ? processed / total : 1;
              setProgress(0.55 + (ratio * 0.4));
            },
            (chunkRows) => {
              if (!active || chunkRows.length === 0) {
                return;
              }
              setLibraryMetadataRows((current) => [...current, ...chunkRows]);
            },
          );
          if (!active) {
            return;
          }
          const fallbackDebugLine = `Roots: ${selectedLibraryDirectoryUris.length} · Nodes: ${listResult.visitedNodes} · Leafs: ${listResult.leafNodes} · ReadErrors: ${listResult.readErrors} · MetadataRows: ${fallbackRows.length} · Delta: saf-leaf-fallback · LastError: ${listResult.lastError || '-'}`;
          console.log(`[PulseLibraryScan] ${fallbackDebugLine}`);
          setLibraryDebugInfo(fallbackDebugLine);
          setLibraryMetadataRows(fallbackRows);
          setContentReason(undefined);
          setProgress(1);
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
        const entryByUri = listResult.entries.reduce<Record<string, { displayName: string; uri: string }>>((acc, entry) => {
          acc[entry.uri] = entry;
          return acc;
        }, {});
        const mergedRowsByUri: Record<string, IAudioFileMetadata> = {};
        listResult.entries.forEach((entry) => {
          const folderArtworkUri = resolveFolderArtworkForTrackUri(entry.uri, folderArtworkByFolderPath);
          const cachedRow = cachedRowsByUri[entry.uri];
          if (cachedRow) {
            mergedRowsByUri[entry.uri] = {
              ...cachedRow,
              artworkUri: String(cachedRow.artworkUri || '').trim() || folderArtworkUri,
            };
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
            artworkUri: folderArtworkUri,
          };
        });
        if (active && mainTabRef.current === 'library') {
          const warmRows = listResult.entries
            .map((entry) => mergedRowsByUri[entry.uri])
            .filter((row): row is IAudioFileMetadata => !!row);
          setLibraryMetadataRows(warmRows);
        }
        let emittedAt = 0;
        const emitProgressiveRows = (force = false) => {
          if (!active) {
            return;
          }
          const now = Date.now();
          if (!force && now - emittedAt < 1300) {
            return;
          }
          if (!force && (now - lastUserInteractionAtRef.current) < 900) {
            return;
          }
          if (mainTabRef.current !== 'library' && !force) {
            return;
          }
          emittedAt = now;
          const progressiveRows = listResult.entries
            .map((entry) => mergedRowsByUri[entry.uri])
            .filter((row): row is IAudioFileMetadata => !!row);
          setLibraryMetadataRows(progressiveRows);
        };
        const changedRows = changedUris.length > 0
          ? await loadMetadataForUrisChunked(
            changedUris,
            96,
            (processed, total) => {
              const ratio = total > 0 ? processed / total : 1;
              setProgress(0.62 + (ratio * 0.3));
            },
            (chunkRows) => {
              if (chunkRows.length === 0) {
                return;
              }
              chunkRows.forEach((changedRow) => {
                const entry = entryByUri[changedRow.uri];
                const folderArtworkUri = resolveFolderArtworkForTrackUri(changedRow.uri, folderArtworkByFolderPath);
                mergedRowsByUri[changedRow.uri] = {
                  ...changedRow,
                  title: String(changedRow.title || entry?.displayName || '').trim(),
                  artist: String(changedRow.artist || '').trim(),
                  album: String(changedRow.album || '').trim(),
                  artworkUri: String(changedRow.artworkUri || '').trim() || folderArtworkUri,
                };
              });
              emitProgressiveRows();
            },
          )
          : [];
        if (changedUris.length === 0) {
          setProgress(0.92);
        }
        emitProgressiveRows(true);
        const changedRowsByUri = changedRows.reduce<Record<string, IAudioFileMetadata>>((acc, row) => {
          acc[row.uri] = row;
          return acc;
        }, {});
        listResult.entries.forEach((entry) => {
          const folderArtworkUri = resolveFolderArtworkForTrackUri(entry.uri, folderArtworkByFolderPath);
          const changedRow = changedRowsByUri[entry.uri];
          if (changedRow) {
            mergedRowsByUri[entry.uri] = {
              ...changedRow,
              title: String(changedRow.title || entry.displayName || '').trim(),
              artist: String(changedRow.artist || '').trim(),
              album: String(changedRow.album || '').trim(),
              artworkUri: String(changedRow.artworkUri || '').trim() || folderArtworkUri,
            };
            return;
          }
          const cachedRow = cachedRowsByUri[entry.uri];
          if (cachedRow) {
            mergedRowsByUri[entry.uri] = {
              ...cachedRow,
              artworkUri: String(cachedRow.artworkUri || '').trim() || folderArtworkUri,
            };
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
            artworkUri: folderArtworkUri,
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
        if (active) {
          const albumItems = mapMetadataToLibraryItems(orderedRows, 'albums', selectedLibraryDirectoryUris);
          const titleItems = mapMetadataToLibraryItems(orderedRows, 'titles', selectedLibraryDirectoryUris);
          const cacheSnapshot: ILibraryCacheSnapshot = {
            rootsKey,
            rowsByUri: mergedRowsByUri,
            lastModifiedByUri: currentLastModifiedByUri,
            albumItems,
            albumItemsVersion: ALBUM_ITEMS_CACHE_VERSION,
            titleItems,
            titleItemsVersion: TITLE_ITEMS_CACHE_VERSION,
            playlistEntries: playlistResult.entries,
            scannedAt: Date.now(),
          };
          writeMusicLibraryCacheSnapshot(cacheSnapshot).catch(() => undefined);
          setPreAggregatedAlbumItems({ rowCount: orderedRows.length, items: albumItems });
          setPreAggregatedTitleItems({ rowCount: orderedRows.length, items: titleItems });
        }
        setContentReason(undefined);
        setProgress(1);
      } finally {
        if (active) {
          setLibrarySyncInProgress(false);
        }
      }
    };
    if (active) {
      void loadData()
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
    }
    return () => {
      console.log('[StartupMetric] LOAD_EFFECT_CLEANUP');
      active = false;
    };
  }, [selectedLibraryDirectoryUris, libraryReloadToken]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(APPS_PINNED_STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) {
          return;
        }
        try {
          const parsed = JSON.parse(raw) as string[];
          if (Array.isArray(parsed)) {
            setPinnedAppPackages(parsed.filter(Boolean));
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
    const titleText = String(playerTrack || '').trim();
    const measuredTextWidth = playerTitleTextWidth > 0
      ? playerTitleTextWidth
      : Math.round(titleText.length * 16.5);
    const overflowPx = playerTitleContainerWidth > 0
      ? (measuredTextWidth - playerTitleContainerWidth)
      : 0;
    const shouldScroll = playerTitleContainerWidth > 0 && overflowPx > 28 && titleText.length > 14;
    if (!shouldScroll) {
      playerTitleAnim.setValue(0);
      return;
    }
    const travelDistance = Math.max(24, overflowPx + 24);
    const duration = Math.max(5200, Math.round(travelDistance * 48));
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(850),
        Animated.timing(playerTitleAnim, {
          toValue: 1,
          duration,
          useNativeDriver: true,
        }),
        Animated.delay(420),
        Animated.timing(playerTitleAnim, {
          toValue: 0,
          duration,
          useNativeDriver: true,
        }),
        Animated.delay(30000),
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
    const refreshNotificationState = async () => {
      const granted = await isNotificationAccessGranted().catch(() => false);
      if (!active) {
        return;
      }
      setNotificationAccessGranted(granted);
      if (!granted) {
        setNotifications([]);
        return;
      }
      const nativeItems = await getCurrentNotifications().catch(() => [] as ISystemNotificationNativeItem[]);
      if (!active || !Array.isArray(nativeItems)) {
        return;
      }
      const mapped = nativeItems
        .map((item) => ({
          id: item.notificationKey,
          packageName: item.packageName,
          appName: item.appName,
          title: item.title,
          message: item.message,
        }));
      setNotifications(mapped.slice(0, 80));
    };
    void refreshNotificationState();
    const refreshInterval = setInterval(() => {
      void refreshNotificationState();
    }, 4500);
    const postedSub = notificationEvents.addPostedListener?.((payload: ISystemNotificationNativeItem) => {
      setNotifications((current) => {
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
      active = false;
      clearInterval(refreshInterval);
      postedSub?.remove();
      removedSub?.remove();
      snapshotSub?.remove();
    };
  }, []);

  const albumFolderOnlyTitleItems = useMemo(() => {
    if (!albumSourceFolderFilter) {
      return null;
    }
    const rows = libraryMetadataRows
      .filter(isAudioRow)
      .filter((row) => getAlbumFolderKeyFromUri(String(row.uri || ''), selectedLibraryDirectoryUris) === albumSourceFolderFilter);
    if (rows.length === 0) {
      return [] as ILauncherListItem[];
    }
    return mapMetadataToLibraryItems(rows, 'titles', selectedLibraryDirectoryUris);
  }, [albumSourceFolderFilter, libraryMetadataRows, selectedLibraryDirectoryUris]);

  useEffect(() => {
    const localPlaylistTrackSet = playlistUriFilter
      ? new Set((playlistEntries.find((entry) => entry.uri === playlistUriFilter)?.trackUris) || [])
      : undefined;
    const canUsePreAggregatedAlbums = libraryMode === 'albums'
      && !albumTitleFilter
      && !albumSourceFolderFilter
      && !playlistUriFilter
      && !!preAggregatedAlbumItems
      && preAggregatedAlbumItems.items.length > 0;
    const canUsePreAggregatedTitles = libraryMode === 'titles'
      && !albumTitleFilter
      && !albumSourceFolderFilter
      && !playlistUriFilter
      && !!preAggregatedTitleItems
      && preAggregatedTitleItems.items.length > 0;
    const baseItems = libraryMode === 'playlists'
      ? mapPlaylistEntriesToItems(playlistEntries, libraryMetadataRows)
      : canUsePreAggregatedAlbums
        ? preAggregatedAlbumItems.items
        : (libraryMode === 'titles' && albumSourceFolderFilter && albumFolderOnlyTitleItems)
          ? albumFolderOnlyTitleItems
          : canUsePreAggregatedTitles
            ? preAggregatedTitleItems.items
            : mapMetadataToLibraryItems(libraryMetadataRows, libraryMode, selectedLibraryDirectoryUris);
    const filteredItems = (() => {
      if (libraryMode !== 'titles') {
        return baseItems;
      }
      if (localPlaylistTrackSet) {
        return baseItems.filter((item) => {
          const uri = item.sourceUri || item.id;
          return localPlaylistTrackSet.has(uri);
        });
      }
      if (albumSourceFolderFilter) {
        return baseItems;
      }
      if (albumTitleFilter) {
        return baseItems.filter((item) => item.meta === albumTitleFilter);
      }
      return baseItems;
    })();
    const titlesAllTracksAlpha =
      libraryMode === 'titles'
      && !albumSourceFolderFilter
      && !playlistUriFilter
      && !albumTitleFilter
      && !localPlaylistTrackSet;
    const afterTitlesSort = titlesAllTracksAlpha
      ? (() => {
        const tracks = filteredItems.filter((item) => item.collectionType === 'track');
        tracks.sort((left, right) => String(left.title || '').localeCompare(String(right.title || ''), 'de', { sensitivity: 'base' }));
        return tracks;
      })()
      : filteredItems;
    const nextItems = (libraryMode === 'albums' ? sortAlbumItems(afterTitlesSort) : afterTitlesSort)
      .map(normalizeLauncherItemText);
    if (libraryMode === 'albums' && nextItems.length > 0) {
      albumRenderStartAtRef.current = Date.now();
      albumRenderedIdsRef.current = new Set();
      albumFirstTenLoggedRef.current = false;
      albumAllLoggedRef.current = false;
      albumTargetCountRef.current = nextItems.length;
      console.log(`[StartupMetric] ALBUM_DATA_READY count=${nextItems.length}`);
    }
    setLibraryItems(nextItems);
  }, [libraryMode, albumTitleFilter, albumSourceFolderFilter, playlistEntries, playlistUriFilter, libraryMetadataRows, selectedLibraryDirectoryUris, preAggregatedAlbumItems, preAggregatedTitleItems, albumFolderOnlyTitleItems]);

  /**
   * Keep UI mode-consistent during transitions, so stale items from a previous mode
   * are never rendered in the current mode.
   */
  const modeCompatibleLibraryItems = useMemo(() => {
    if (libraryMode === 'albums') {
      return libraryItems.filter((item) => item.collectionType === 'album');
    }
    if (libraryMode === 'playlists') {
      return libraryItems.filter((item) => item.collectionType === 'playlist');
    }
    return libraryItems.filter((item) => item.collectionType === 'track' || item.collectionType === 'cd-header');
  }, [libraryItems, libraryMode]);

  // Keep last valid album grid to avoid blank/loading flashes while albums are recomputed.
  useEffect(() => {
    if (libraryMode === 'albums' && modeCompatibleLibraryItems.length > 0) {
      setCachedAlbumItems(modeCompatibleLibraryItems);
    }
  }, [libraryMode, modeCompatibleLibraryItems]);

  const albumModeVisibleItems = useMemo(() => {
    if (libraryMode !== 'albums') {
      return [] as ILauncherListItem[];
    }
    if (modeCompatibleLibraryItems.length > 0) {
      return modeCompatibleLibraryItems;
    }
    if (cachedAlbumItems.length > 0) {
      return cachedAlbumItems;
    }
    if (preAggregatedAlbumItems && preAggregatedAlbumItems.items.length > 0) {
      return preAggregatedAlbumItems.items.map(normalizeLauncherItemText);
    }
    return [] as ILauncherListItem[];
  }, [libraryMode, modeCompatibleLibraryItems, cachedAlbumItems, preAggregatedAlbumItems]);

  const visibleLibraryItems = libraryMode === 'albums' ? albumModeVisibleItems : modeCompatibleLibraryItems;
  const hasLibraryModeDataMismatch = libraryItems.length > 0 && modeCompatibleLibraryItems.length === 0;
  const shouldShowLibraryTransitionLoader = (loadingContent || hasLibraryModeDataMismatch) && visibleLibraryItems.length === 0;

  useEffect(() => {
    if (mainTab !== 'library' || libraryMode !== 'albums') {
      return;
    }
    const folderKey = pendingAlbumGridScrollFolderKeyRef.current;
    if (!folderKey) {
      return;
    }
    const idx = albumModeVisibleItems.findIndex(
      (i) => i.collectionType === 'album' && (i.sourceUri === folderKey || i.meta === folderKey),
    );
    if (idx < 0) {
      if (albumModeVisibleItems.length > 0) {
        pendingAlbumGridScrollFolderKeyRef.current = undefined;
      }
      return;
    }
    pendingAlbumGridScrollFolderKeyRef.current = undefined;
    const frame = requestAnimationFrame(() => {
      const row = Math.floor(idx / 2);
      albumListRef.current?.scrollToOffset({
        offset: Math.max(0, row * albumGridRowHeight),
        animated: false,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [mainTab, libraryMode, albumModeVisibleItems, albumGridRowHeight]);

  useEffect(() => {
    if (mainTab !== 'library' || libraryMode !== 'albums') {
      return;
    }
    if (collectionArtworkHydrationInFlightRef.current) {
      return;
    }
    const rows = libraryMetadataRows.filter(isAudioRow);
    if (rows.length === 0) {
      return;
    }
    const grouped = new Map<string, IAudioFileMetadata[]>();
    rows.forEach((row) => {
      const folderKey = getAlbumFolderKeyFromUri(row.uri, selectedLibraryDirectoryUris);
      const bucket = grouped.get(folderKey);
      if (bucket) {
        bucket.push(row);
      } else {
        grouped.set(folderKey, [row]);
      }
    });
    const candidateUris: string[] = [];
    grouped.forEach((folderRows, folderKey) => {
      const collectionEval = evaluateCollectionClassification(folderRows, folderKey);
      const isCollection = collectionEval.isCollection;
      if (!isCollection) {
        return;
      }
      const missingRows = folderRows.filter((row) => !String(row.artworkUri || '').trim());
      for (const row of missingRows) {
        if (!attemptedCollectionArtworkUrisRef.current.has(row.uri)) {
          candidateUris.push(row.uri);
        }
        if (candidateUris.length >= 400) {
          break;
        }
      }
    });
    if (candidateUris.length === 0) {
      return;
    }
    const rootsKey = [...selectedLibraryDirectoryUris].sort().join('|');
    candidateUris.forEach((uri) => attemptedCollectionArtworkUrisRef.current.add(uri));
    collectionArtworkHydrationInFlightRef.current = true;
    void withTimeout(loadMetadataForUris(candidateUris), 25000, 'collection-artwork-hydration-timeout')
      .then((resolvedRows) => {
        const updates = new Map<string, string>();
        resolvedRows.forEach((row) => {
          const artwork = String(row.artworkUri || '').trim();
          if (artwork) {
            updates.set(row.uri, artwork);
          }
        });
        if (updates.size === 0) {
          console.log(`[CoverProbe] hydrate requested=${candidateUris.length} resolved=0`);
          return;
        }
        setLibraryMetadataRows((current) => current.map((row) => {
          const nextArtwork = updates.get(row.uri);
          if (!nextArtwork) {
            return row;
          }
          return { ...row, artworkUri: nextArtwork };
        }));
        setPreAggregatedAlbumItems(null);
        setPreAggregatedTitleItems(null);
        const artworkPayload: Record<string, string> = {};
        updates.forEach((artworkUri, uri) => {
          artworkPayload[uri] = artworkUri;
        });
        mergeArtworkIntoMusicLibraryCacheSnapshot(rootsKey, artworkPayload).catch(() => undefined);
        console.log(`[CoverProbe] hydrate requested=${candidateUris.length} resolved=${updates.size}`);
      })
      .catch(() => undefined)
      .finally(() => {
        collectionArtworkHydrationInFlightRef.current = false;
      });
  }, [mainTab, libraryMode, libraryMetadataRows, selectedLibraryDirectoryUris]);

  useEffect(() => {
    queueRef.current = playQueue;
    queueIndexRef.current = playQueueIndex;
  }, [playQueue, playQueueIndex]);

  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: false,
      staysActiveInBackground: true,
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
    const pinnedOrder = new Map<string, number>();
    pinnedAppPackages.forEach((packageName, index) => {
      pinnedOrder.set(packageName, index);
    });
    return apps
      .filter((item) => !query || item.appName.toLowerCase().includes(query))
      .sort((left, right) => {
        const leftPinned = pinnedOrder.has(left.packageName);
        const rightPinned = pinnedOrder.has(right.packageName);
        if (leftPinned && rightPinned) {
          return Number(pinnedOrder.get(left.packageName) || 0) - Number(pinnedOrder.get(right.packageName) || 0);
        }
        if (leftPinned !== rightPinned) {
          return leftPinned ? -1 : 1;
        }
        return left.appName.localeCompare(right.appName, 'de');
      });
  }, [apps, appsSearch, pinnedAppPackages]);

  const pinnedVisibleApps = useMemo(
    () => filteredApps.filter((app) => pinnedAppPackages.includes(app.packageName)),
    [filteredApps, pinnedAppPackages],
  );

  const regularVisibleApps = useMemo(
    () => filteredApps.filter((app) => !pinnedAppPackages.includes(app.packageName)),
    [filteredApps, pinnedAppPackages],
  );

  const togglePinnedApp = (packageName: string) => {
    setPinnedAppPackages((current) => {
      const next = current.includes(packageName)
        ? current.filter((entry) => entry !== packageName)
        : [...current, packageName];
      AsyncStorage.setItem(APPS_PINNED_STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  };

  /** Full title list for filters — not when only an album-folder drilldown (that uses a small mapped list). */
  const shouldPrepareTitleTracks = mainTab === 'library'
    && libraryMode === 'titles'
    && !albumSourceFolderFilter
    && (!!albumTitleFilter || !!playlistUriFilter);
  const allTitleTracks = useMemo(
    () => (shouldPrepareTitleTracks
      ? mapMetadataToLibraryItems(libraryMetadataRows, 'titles', selectedLibraryDirectoryUris)
      : []),
    [shouldPrepareTitleTracks, libraryMetadataRows, selectedLibraryDirectoryUris],
  );

  const getTitleTracksForActions = (): ILauncherListItem[] => {
    if (mainTab === 'library' && libraryMode === 'titles') {
      if (albumSourceFolderFilter || playlistUriFilter || albumTitleFilter) {
        const tracks = libraryItems.filter((item) => item.collectionType === 'track');
        if (tracks.length > 0) {
          return tracks;
        }
      }
    }
    if (allTitleTracks.length > 0) {
      return allTitleTracks;
    }
    if (preAggregatedTitleItems && preAggregatedTitleItems.items.length > 0) {
      return preAggregatedTitleItems.items;
    }
    return mapMetadataToLibraryItems(libraryMetadataRows, 'titles', selectedLibraryDirectoryUris);
  };
  const getAlbumTracksByFolder = (folderKey: string): ILauncherListItem[] => {
    const cached = albumTracksByFolderRef.current[folderKey];
    if (cached) {
      return cached;
    }
    const tracks = libraryMetadataRows
      .filter(isAudioRow)
      .filter((row) => getAlbumFolderKeyFromUri(String(row.uri || ''), selectedLibraryDirectoryUris) === folderKey)
      .sort((left, right) => {
        const leftDisc = extractDiscNumberForSorting(left);
        const rightDisc = extractDiscNumberForSorting(right);
        if (leftDisc !== rightDisc) {
          return leftDisc - rightDisc;
        }
        const leftTrack = extractTrackNumberForSorting(left);
        const rightTrack = extractTrackNumberForSorting(right);
        if (leftTrack !== rightTrack) {
          return leftTrack - rightTrack;
        }
        return String(left.title || '').localeCompare(String(right.title || ''), 'de', { sensitivity: 'base' });
      })
      .map((row) => ({
        id: row.uri,
        title: row.title || decodeURIComponent(getLibraryPathFromUri(row.uri).split('/').pop() || 'Track'),
        subtitle: row.artist || row.album || 'Aurora Pulse',
        meta: row.album || undefined,
        artworkUri: row.artworkUri || undefined,
        sourceUri: row.uri,
        collectionType: 'track' as const,
      }));
    albumTracksByFolderRef.current[folderKey] = tracks;
    return tracks;
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

  const handleClearAllNotifications = async () => {
    const cleared = await clearAllNotifications().catch(() => false);
    if (cleared) {
      setNotifications([]);
      return;
    }
    setNotifications((current) => ([
      {
        id: `notification-clear-fallback-${Date.now()}`,
        packageName: 'system',
        appName: 'System',
        title: t('notifications.title', 'Benachrichtigungszentrale'),
        message: t('settings.notifications.disabled', 'Benachrichtigungszugriff nicht erlaubt'),
      },
      ...current,
    ]));
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
    playbackRequestStartedAtRef.current = Date.now();
    const requestVersion = playbackRequestVersionRef.current + 1;
    playbackRequestVersionRef.current = requestVersion;
    const waitForPrevious = playbackOperationTailRef.current;
    let releaseCurrent: () => void = () => {};
    playbackOperationTailRef.current = new Promise<void>((resolve) => {
      releaseCurrent = () => resolve();
    });
    await Promise.race([
      waitForPrevious.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (queue.length === 0 || index < 0 || index >= queue.length) {
      releaseCurrent();
      return;
    }
    const playableFlags = queue.map((item) => item.collectionType !== 'cd-header' && !!item.sourceUri);
    const playableQueue = queue.filter((item) => item.collectionType !== 'cd-header' && !!item.sourceUri);
    if (playableQueue.length === 0) {
      releaseCurrent();
      return;
    }
    const targetKey = String(queue[index]?.sourceUri || queue[index]?.id || '');
    let resolvedIndex = playableQueue.findIndex((item) => String(item.sourceUri || item.id) === targetKey);
    if (resolvedIndex < 0) {
      for (let pointer = index; pointer < queue.length; pointer += 1) {
        if (!playableFlags[pointer]) {
          continue;
        }
        const nextKey = String(queue[pointer]?.sourceUri || queue[pointer]?.id || '');
        resolvedIndex = playableQueue.findIndex((item) => String(item.sourceUri || item.id) === nextKey);
        if (resolvedIndex >= 0) {
          break;
        }
      }
    }
    if (resolvedIndex < 0) {
      for (let pointer = index - 1; pointer >= 0; pointer -= 1) {
        if (!playableFlags[pointer]) {
          continue;
        }
        const prevKey = String(queue[pointer]?.sourceUri || queue[pointer]?.id || '');
        resolvedIndex = playableQueue.findIndex((item) => String(item.sourceUri || item.id) === prevKey);
        if (resolvedIndex >= 0) {
          break;
        }
      }
    }
    if (resolvedIndex < 0) {
      resolvedIndex = 0;
    }
    let resolvedQueue = playableQueue;
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
      releaseCurrent();
      return;
    }
    dlnaPlaybackSwitchInFlightRef.current = true;
    currentPlayingUriRef.current = String(sourceUri);
    isDlnaSessionRef.current = String(current.id || '').startsWith('dlna:');
    try {
      setPlayerTrack(current.title);
      setPlayerMeta(current.subtitle || current.meta || 'Aurora Pulse');
      setPlayerArtworkUri(current.artworkUri);
      setPlayerPositionMs(0);
      setPlayerDurationMs(0);
      setPlayerState('paused');
      setMainTab('player');
      if (soundRef.current) {
        await withTimeout(
          soundRef.current.unloadAsync().catch(() => undefined),
          1500,
          'unload-timeout',
        ).catch(() => undefined);
        soundRef.current = null;
      }
      const statusHandler = (status: AVPlaybackStatus) => {
        if (requestVersion !== playbackRequestVersionRef.current) {
          return;
        }
        if (!status.isLoaded) {
          return;
        }
        const durationMs = status.durationMillis || 0;
        const positionMs = Math.min(status.positionMillis || 0, durationMs || status.positionMillis || 0);
        const now = Date.now();
        if (now - playerStatusLastUiUpdateAtRef.current >= 140 || status.didJustFinish) {
          setPlayerDurationMs(durationMs);
          setPlayerPositionMs(positionMs);
          playerStatusLastUiUpdateAtRef.current = now;
        }
        const state = status.isPlaying ? 'playing' : 'paused';
        setPlayerState(state);
        if ((now - playerStatusLastDlnaSyncAtRef.current) >= 900 || status.didJustFinish) {
          updateDLNAPlaybackState(state, positionMs, durationMs).catch(() => undefined);
          updateMediaControlPlaybackState(state as 'playing' | 'paused', positionMs, durationMs).catch(() => undefined);
          playerStatusLastDlnaSyncAtRef.current = now;
        }

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
      };
      let createdSound: Audio.Sound | null = null;
      const firstAttempt = await withTimeout(
        Audio.Sound.createAsync(
          { uri: sourceUri },
          { shouldPlay: true },
          statusHandler,
        ),
        4500,
        'create-sound-timeout',
      ).catch(() => null);
      if (firstAttempt?.sound) {
        createdSound = firstAttempt.sound;
      } else {
        const secondAttempt = await withTimeout(
          Audio.Sound.createAsync(
            { uri: sourceUri },
            { shouldPlay: true },
            statusHandler,
          ),
          4500,
          'create-sound-timeout-retry',
        ).catch(() => null);
        if (secondAttempt?.sound) {
          createdSound = secondAttempt.sound;
        }
      }
      if (!createdSound) {
        setPlayerState('paused');
        return;
      }
      const sound = createdSound;
      if (requestVersion !== playbackRequestVersionRef.current) {
        await sound.unloadAsync().catch(() => undefined);
        return;
      }
      soundRef.current = sound;
      applyAudioEffects(equalizerSettings.bands, equalizerSettings.preampDb, !equalizerSettings.autoEqEnabled).catch(() => undefined);
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
      updateMediaControlPlaybackTrack(
        String(current.title || ''),
        String(current.subtitle || current.meta || 'Aurora Pulse'),
        String(current.meta || 'Aurora Pulse'),
        String(current.artworkUri || ''),
        resolvedIndex,
        resolvedQueue.length,
        0,
        equalizerSettings.autoEqEnabled ? String(equalizerSettings.autoEqProfile?.name || '') : '',
      ).catch(() => undefined);
      updateMediaControlPlaybackState('playing', 0, 0).catch(() => undefined);
      console.log(`[InteractionMetric] PLAY_READY elapsedMs=${Math.max(0, Date.now() - playbackRequestStartedAtRef.current)} queueSize=${resolvedQueue.length}`);
    } finally {
      dlnaPlaybackSwitchInFlightRef.current = false;
      releaseCurrent();
    }
  };

  const togglePlayPause = async () => {
    const sound = soundRef.current;
    if (!sound) {
      if (queueRef.current.length > 0 && queueIndexRef.current >= 0) {
        await playTrackAtIndex(queueRef.current, queueIndexRef.current);
        return;
      }
      const tracks = getTitleTracksForActions();
      if (tracks.length > 0) {
        await playTrackAtIndex(
          shuffleLibraryItemsAvoidingAdjacentAlbumRepeats(tracks),
          0,
        );
      }
      return;
    }
    const status = await sound.getStatusAsync();
    if (!status.isLoaded) {
      soundRef.current = null;
      const fallbackIndex = Math.max(0, Math.min(queueRef.current.length - 1, queueIndexRef.current));
      if (queueRef.current.length > 0) {
        await playTrackAtIndex(queueRef.current, fallbackIndex);
        return;
      }
      const tracks = getTitleTracksForActions();
      if (tracks.length > 0) {
        await playTrackAtIndex(
          shuffleLibraryItemsAvoidingAdjacentAlbumRepeats(tracks),
          0,
        );
      }
      return;
    }
    if (status.isPlaying) {
      await sound.pauseAsync();
      setPlayerState('paused');
      updateMediaControlPlaybackState('paused', playerPositionMs, playerDurationMs).catch(() => undefined);
    } else {
      await sound.playAsync();
      setPlayerState('playing');
      updateMediaControlPlaybackState('playing', playerPositionMs, playerDurationMs).catch(() => undefined);
    }
  };

  const playPlayer = async () => {
    const sound = soundRef.current;
    if (sound) {
      const status = await sound.getStatusAsync();
      if (!status.isLoaded) {
        soundRef.current = null;
        await togglePlayPause();
        return;
      }
      if (status.isLoaded && !status.isPlaying) {
        await sound.playAsync();
        setPlayerState('playing');
        updateMediaControlPlaybackState('playing', playerPositionMs, playerDurationMs).catch(() => undefined);
      }
    } else {
      const tracks = getTitleTracksForActions();
      if (tracks.length > 0) {
        await playTrackAtIndex(
          shuffleLibraryItemsAvoidingAdjacentAlbumRepeats(tracks),
          0,
        );
        return;
      }
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
        updateMediaControlPlaybackState('paused', playerPositionMs, playerDurationMs).catch(() => undefined);
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

  const renderAlbumCover = (item: ILauncherListItem) => {
    if (item.artworkUri) {
      return <Image source={{ uri: item.artworkUri }} style={styles.coverImage} />;
    }
    const mosaic = (item.mosaicArtworks || []).map(uri => String(uri || '').trim()).filter(Boolean);
    if (mosaic.length >= 2) {
      const tiles = mosaic.slice(0, 4);
      while (tiles.length < 4) {
        tiles.push(tiles[tiles.length % mosaic.length]);
      }
      return (
        <View style={styles.coverMosaicGrid}>
          {tiles.map((uri, index) => (
            <View key={`${item.id}-mosaic-${index}`} style={styles.coverMosaicTile}>
              {uri.startsWith('tile://') ? (
                <View style={styles.coverMosaicPlaceholder} />
              ) : (
                <Image source={{ uri }} style={styles.coverMosaicImage} />
              )}
            </View>
          ))}
        </View>
      );
    }
    if (mosaic.length === 1) {
      return <Image source={{ uri: mosaic[0] }} style={styles.coverImage} />;
    }
    return <Text style={styles.coverIcon}>♪</Text>;
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
    lastUserInteractionAtRef.current = Date.now();
    if (item.collectionType === 'album') {
      const transitionStart = Date.now();
      titleViewTransitionStartRef.current = transitionStart;
      albumToTitlesTransitionStartRef.current = transitionStart;
      titlesToAlbumsTransitionStartRef.current = 0;
      titleViewReadyLoggedRef.current = false;
      const folderKey = item.sourceUri || item.meta || '';
      lastOpenedAlbumFolderKeyRef.current = folderKey;
      setAlbumSourceFolderFilter(folderKey);
      setAlbumFolderFilterLabel(item.title);
      setAlbumTitleFilter(undefined);
      setPlaylistUriFilter(undefined);
      setLibraryMode('titles');
      setMainTab('library');
      return;
    }
    if (item.collectionType === 'playlist') {
      const playlistKey = item.sourceUri || item.meta || '';
      const playlistTrackSet = new Set(playlistTrackUrisByPlaylistUri[playlistKey] || []);
      const titleTracks = getTitleTracksForActions();
      const playlistTracks = titleTracks
        .filter((track) => {
          const trackUri = track.sourceUri || track.id;
          return playlistTrackSet.has(trackUri);
        });
      setMainTab('player');
      void playTrackAtIndex(playlistTracks, 0);
      return;
    }
    if (item.collectionType === 'track') {
      const titleTracks = getTitleTracksForActions();
      const visibleTracks = libraryMode === 'titles' && activePlaylistTrackUriSet
        ? titleTracks.filter((track) => {
          if (track.collectionType !== 'track') {
            return false;
          }
          const uri = track.sourceUri || track.id;
          return activePlaylistTrackUriSet.has(uri);
        })
        : libraryMode === 'titles' && albumSourceFolderFilter
        ? titleTracks.filter((track) => {
          if (track.collectionType !== 'track') {
            return false;
          }
          const uri = track.sourceUri || track.id;
          return isTrackInFolder(uri, albumSourceFolderFilter);
        })
        : libraryMode === 'titles' && albumTitleFilter
        ? titleTracks.filter((track) => track.collectionType === 'track' && track.meta === albumTitleFilter)
        : titleTracks.filter((track) => track.collectionType === 'track');
      const selectedIndex = visibleTracks.findIndex((track) => track.id === item.id);
      setMainTab('player');
      void playTrackAtIndex(visibleTracks, selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    setMainTab('player');
    void playTrackAtIndex([item], 0);
  };

  const onLongPressLibraryItem = (item: ILauncherListItem) => {
    lastUserInteractionAtRef.current = Date.now();
    if (item.collectionType === 'album') {
      const folderKey = item.sourceUri || item.meta || '';
      const albumTracks = getAlbumTracksByFolder(folderKey);
      console.log(`[InteractionMetric] ALBUM_LONG_PRESS title="${item.title}" tracks=${albumTracks.length}`);
      setMainTab('player');
      void playTrackAtIndex(albumTracks, 0);
      return;
    }
    if (item.collectionType === 'playlist') {
      titleViewTransitionStartRef.current = Date.now();
      albumToTitlesTransitionStartRef.current = 0;
      titleViewReadyLoggedRef.current = false;
      setPlaylistUriFilter(item.sourceUri || item.meta);
      setAlbumTitleFilter(undefined);
      setAlbumSourceFolderFilter(undefined);
      setAlbumFolderFilterLabel(undefined);
      setLibraryMode('titles');
      setMainTab('library');
      return;
    }
    if (item.collectionType === 'track') {
      titleViewTransitionStartRef.current = Date.now();
      albumToTitlesTransitionStartRef.current = 0;
      titleViewReadyLoggedRef.current = false;
      const folderKey = item.meta
        || getAlbumFolderKeyFromUri(String(item.sourceUri || item.id), selectedLibraryDirectoryUris);
      setAlbumSourceFolderFilter(folderKey || undefined);
      setAlbumFolderFilterLabel(undefined);
      setAlbumTitleFilter(undefined);
      setPlaylistUriFilter(undefined);
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
    if (item.id === 'set-audio') {
      const nextEnabled = !dlnaRendererEnabled;
      const applied = await setDLNARendererEnabled(nextEnabled).catch(() => false);
      if (applied) {
        setDlnaRendererEnabled(nextEnabled);
      }
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
        writeLibraryDirectoryUrisSnapshot(nextUris).catch(() => undefined);
        return nextUris;
      });
      setLibraryMode('albums');
      setAlbumTitleFilter(undefined);
      setAlbumSourceFolderFilter(undefined);
      setAlbumFolderFilterLabel(undefined);
      setPlaylistUriFilter(undefined);
      setLibraryReloadToken((token) => token + 1);
      return;
    }
    if (item.id === 'set-restart-app') {
      onRestartApp();
      return;
    }
  };

  const onRestartApp = async () => {
    const restarted = await restartCurrentApp();
    if (restarted) {
      return;
    }
    if (__DEV__) {
      DevSettings.reload();
      return;
    }
    setEqualizerMessage('Neustart konnte nicht ausgelöst werden.');
  };

  const applyEqualizerSettings = (next: IEqualizerSettings, message?: string) => {
    setEqualizerSettings(next);
    if (message) {
      setEqualizerMessage(message);
    }
    persistEqualizerSettings(next).catch(() => undefined);
    const manualEqEnabled = !next.autoEqEnabled;
    applyAudioEffects(next.bands, next.preampDb, manualEqEnabled)
      .then((applied) => {
        if (!applied) {
          setEqualizerMessage('EQ-Engine reagiert nicht (Native-Apply fehlgeschlagen).');
        }
      })
      .catch(() => {
        setEqualizerMessage('EQ-Engine reagiert nicht (Native-Apply Fehler).');
      });
    setAudioEffectsEnabled(manualEqEnabled).catch(() => undefined);
  };

  const onImportAutoEq = async () => {
    try {
      setEqualizerMessage('');
      const nativePicked = await pickAutoEqFileNative().catch(() => null);
      let fileUri = String(nativePicked?.uri || '');
      let fileName = String(nativePicked?.name || '');
      let fileContent = String(nativePicked?.content || '');
      if (!fileUri) {
        let pickerResult: DocumentPicker.DocumentPickerResult;
        try {
          pickerResult = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: true,
            multiple: false,
            type: '*/*',
          });
        } catch (_primaryError) {
          pickerResult = await DocumentPicker.getDocumentAsync();
        }
        const modernAssets = 'assets' in pickerResult
          ? (pickerResult.assets || [])
          : [];
        const legacyResult = pickerResult as { uri?: string; name?: string };
        const legacyAsset = legacyResult.uri
          ? [{
            uri: legacyResult.uri,
            name: legacyResult.name,
          }]
          : [];
        const selectedAssets = modernAssets.length > 0 ? modernAssets : legacyAsset;
        if (('canceled' in pickerResult && pickerResult.canceled) || selectedAssets.length === 0) {
          return;
        }
        const selectedAsset = selectedAssets[0];
        fileUri = String(selectedAsset.uri || '');
        fileName = String(selectedAsset.name || fileName);
      }
      if (!fileUri) {
        setEqualizerMessage('AutoEQ-Datei wurde nicht ausgewählt.');
        return;
      }
      const selectedName = String(fileName || '').toLowerCase();
      if (selectedName && !selectedName.endsWith('.peq') && !selectedName.endsWith('.txt')) {
        setEqualizerMessage('Bitte eine AutoEQ-Datei mit .peq oder .txt auswählen.');
        return;
      }
      if (!fileContent) {
        fileContent = await FileSystem.readAsStringAsync(fileUri);
      }
      const profileName = String(fileName || '').replace(/\.[^.]+$/, '') || 'AutoEQ';
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
      setEqualizerMessage('AutoEQ-Dateidialog konnte nicht geöffnet werden.');
    }
  };

  const markAlbumCardRendered = (itemId: string) => {
    if (mainTab !== 'library' || libraryMode !== 'albums' || libraryItems.length === 0) {
      return;
    }
    const rendered = albumRenderedIdsRef.current;
    if (rendered.has(itemId)) {
      return;
    }
    rendered.add(itemId);
    const elapsedMs = Math.max(0, Date.now() - albumRenderStartAtRef.current);
    if (!albumFirstTenLoggedRef.current && rendered.size >= Math.min(10, libraryItems.length)) {
      albumFirstTenLoggedRef.current = true;
      console.log(`[StartupMetric] ALBUM_RENDER_FIRST_10 elapsedMs=${elapsedMs} rendered=${rendered.size}`);
    }
    if (!albumAllLoggedRef.current && rendered.size >= libraryItems.length) {
      albumAllLoggedRef.current = true;
      console.log(`[StartupMetric] ALBUM_RENDER_ALL elapsedMs=${elapsedMs} rendered=${rendered.size}`);
    }
  };

  const onAlbumViewableItemsChangedRef = useRef(({ viewableItems }: { viewableItems: Array<{ item: ILauncherListItem }> }) => {
    if (albumFirstTenLoggedRef.current) {
      return;
    }
    const visibleUnique = new Set(viewableItems.map((entry) => entry.item?.id).filter(Boolean));
    if (visibleUnique.size >= Math.min(10, Math.max(1, albumTargetCountRef.current))) {
      albumFirstTenLoggedRef.current = true;
      const elapsedMs = Math.max(0, Date.now() - albumRenderStartAtRef.current);
      console.log(`[StartupMetric] ALBUM_RENDER_FIRST_10 elapsedMs=${elapsedMs} rendered=${visibleUnique.size}`);
    }
  });

  const onRefreshLibrary = () => {
    if (mainTab !== 'library') {
      return;
    }
    attemptedCollectionArtworkUrisRef.current.clear();
    collectionArtworkHydrationInFlightRef.current = false;
    setPreAggregatedAlbumItems(null);
    setPreAggregatedTitleItems(null);
    setRefreshingLibrary(true);
    setLibraryReloadToken((token) => token + 1);
  };

  const triggerLibraryDeltaReload = () => {
    setMainTab('library');
    setLibraryMode('albums');
    setAlbumTitleFilter(undefined);
    setAlbumSourceFolderFilter(undefined);
    setPlaylistUriFilter(undefined);
    setLibraryLoadProgress((current) => Math.max(current, 0.02));
    setLibrarySyncInProgress(true);
    attemptedCollectionArtworkUrisRef.current.clear();
    collectionArtworkHydrationInFlightRef.current = false;
    setPreAggregatedAlbumItems(null);
    setPreAggregatedTitleItems(null);
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

  /** One SectionList section per CD block (or a single section for flat title lists). Rows are virtualized per track. */
  const titleListSections = useMemo(() => {
    if (libraryMode !== 'titles') {
      return [] as Array<{ key: string; title?: string; data: ILauncherListItem[] }>;
    }
    const sections: Array<{ key: string; title?: string; data: ILauncherListItem[] }> = [];
    let currentKey = 'cd:default';
    let currentTitle: string | undefined;
    let currentTracks: ILauncherListItem[] = [];
    modeCompatibleLibraryItems.forEach((item) => {
      if (item.collectionType === 'cd-header') {
        if (currentTracks.length > 0) {
          sections.push({ key: currentKey, title: currentTitle, data: currentTracks });
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
      sections.push({ key: currentKey, title: currentTitle, data: currentTracks });
    }
    return sections;
  }, [modeCompatibleLibraryItems, libraryMode]);

  useEffect(() => {
    if (libraryMode !== 'titles' || mainTab !== 'library') {
      titleViewReadyLoggedRef.current = false;
      return;
    }
    if (loadingContent || modeCompatibleLibraryItems.length === 0) {
      return;
    }
    const trackCount = modeCompatibleLibraryItems.filter((i) => i.collectionType === 'track').length;
    if (trackCount <= 0) {
      return;
    }
    if (titleViewReadyLoggedRef.current) {
      return;
    }
    titleViewReadyLoggedRef.current = true;
    const start = titleViewTransitionStartRef.current;
    const elapsedMs = start > 0 ? Math.max(0, Date.now() - start) : 0;
    console.log(`[InteractionMetric] TITLE_VIEW_READY elapsedMs=${elapsedMs} items=${modeCompatibleLibraryItems.length} tracks=${trackCount}`);
    titleViewTransitionStartRef.current = 0;
  }, [libraryMode, mainTab, loadingContent, modeCompatibleLibraryItems]);

  useEffect(() => {
    if (mainTab !== 'library' || libraryMode !== 'titles') {
      return;
    }
    const startedAt = albumToTitlesTransitionStartRef.current;
    if (startedAt <= 0 || loadingContent) {
      return;
    }
    const trackCount = modeCompatibleLibraryItems.filter((item) => item.collectionType === 'track').length;
    if (trackCount <= 0) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    console.log(`[InteractionMetric] ALBUM_TO_TITLES_COMPLETE elapsedMs=${elapsedMs} tracks=${trackCount} items=${modeCompatibleLibraryItems.length}`);
    albumToTitlesTransitionStartRef.current = 0;
  }, [mainTab, libraryMode, loadingContent, modeCompatibleLibraryItems]);

  useEffect(() => {
    if (mainTab !== 'library' || libraryMode !== 'albums') {
      return;
    }
    const startedAt = titlesToAlbumsTransitionStartRef.current;
    if (startedAt <= 0 || loadingContent) {
      return;
    }
    const albumCount = modeCompatibleLibraryItems.filter((item) => item.collectionType === 'album').length;
    if (albumCount <= 0) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    console.log(`[InteractionMetric] TITLES_TO_ALBUMS_COMPLETE elapsedMs=${elapsedMs} albums=${albumCount}`);
    titlesToAlbumsTransitionStartRef.current = 0;
  }, [mainTab, libraryMode, loadingContent, modeCompatibleLibraryItems]);
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
  const playerTitleNormalized = String(playerTrack || '').trim();
  const playerTitleEffectiveWidth = playerTitleTextWidth > 0
    ? playerTitleTextWidth
    : Math.round(playerTitleNormalized.length * 16.5);
  const playerTitleOverflowPx = playerTitleContainerWidth > 0
    ? Math.max(0, playerTitleEffectiveWidth - playerTitleContainerWidth)
    : 0;
  const playerTitleShouldScroll = playerTitleContainerWidth > 0 && playerTitleOverflowPx > 28 && playerTitleNormalized.length > 14;
  const playerTitleTravelDistance = Math.max(24, playerTitleOverflowPx + 24);
  const playerTitleTranslateX = playerTitleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -playerTitleTravelDistance],
  });
  const playerTitleMarqueeOpacity = playerTitleAnim.interpolate({
    inputRange: [0, 0.02, 0.98, 1],
    outputRange: [0, 1, 1, 0],
  });
  const manualEqEditable = !equalizerSettings.autoEqEnabled;

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
                      if (mode.key === 'albums') {
                        pendingAlbumGridScrollFolderKeyRef.current = lastOpenedAlbumFolderKeyRef.current;
                        if (libraryMode === 'titles') {
                          titlesToAlbumsTransitionStartRef.current = Date.now();
                        } else {
                          titlesToAlbumsTransitionStartRef.current = 0;
                        }
                      }
                      if (mode.key === 'titles') {
                        titleViewTransitionStartRef.current = Date.now();
                        albumToTitlesTransitionStartRef.current = 0;
                        titleViewReadyLoggedRef.current = false;
                      }
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
              {shouldShowLibraryTransitionLoader && (
                <View style={styles.loading}>
                  <ActivityIndicator color={theme.colors.accent} />
                  <Text style={styles.helperText}>{t('library.loading', 'Bibliothek wird geladen…')}</Text>
                </View>
              )}
              {visibleLibraryItems.length > 0 && libraryMode !== 'titles' && (
                <FlatList
                  ref={albumListRef}
                  data={visibleLibraryItems}
                  style={{ flex: 1 }}
                  keyExtractor={(item) => item.id}
                  numColumns={2}
                  columnWrapperStyle={{ justifyContent: 'space-between', paddingHorizontal: 16 }}
                  contentContainerStyle={{ paddingTop: 8, paddingBottom: bottomInset + 124 }}
                  initialNumToRender={albumListRenderProfile.initialNumToRender}
                  maxToRenderPerBatch={albumListRenderProfile.maxToRenderPerBatch}
                  windowSize={albumListRenderProfile.windowSize}
                  updateCellsBatchingPeriod={albumListRenderProfile.updateCellsBatchingPeriod}
                  removeClippedSubviews={false}
                  getItemLayout={getAlbumItemLayout}
                  onScrollToIndexFailed={({ index }) => {
                    const row = Math.floor(index / 2);
                    albumListRef.current?.scrollToOffset({ offset: row * albumGridRowHeight, animated: false });
                  }}
                  onScroll={onAlbumListScroll}
                  scrollEventThrottle={16}
                  viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
                  onViewableItemsChanged={onAlbumViewableItemsChangedRef.current}
                  onContentSizeChange={() => {
                    onAlbumListContentSizeChange();
                    if (albumAllLoggedRef.current || albumTargetCountRef.current <= 0) {
                      return;
                    }
                    albumAllLoggedRef.current = true;
                    const elapsedMs = Math.max(0, Date.now() - albumRenderStartAtRef.current);
                    console.log(`[StartupMetric] ALBUM_RENDER_ALL elapsedMs=${elapsedMs} rendered=${albumTargetCountRef.current}`);
                  }}
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
                      delayLongPress={170}
                    >
                      <View style={styles.cover}>
                        {renderAlbumCover(item)}
                      </View>
                      <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={libraryMode === 'albums' ? styles.itemSubtitleAlbum : styles.itemSubtitle} numberOfLines={1}>
                        {item.subtitle}
                      </Text>
                    </Pressable>
                  )}
                />
              )}
              {visibleLibraryItems.length > 0 && libraryMode === 'titles' && (
                <SectionList
                  ref={titlesListRef}
                  sections={titleListSections}
                  style={{ flex: 1 }}
                  keyExtractor={(item) => item.id}
                  renderSectionHeader={({ section }) => (
                    section.title ? (
                      <View style={styles.trackGroup}>
                        <View style={styles.trackGroupHeader}>
                          <Text style={styles.trackGroupHeaderText}>{section.title}</Text>
                        </View>
                      </View>
                    ) : null
                  )}
                  SectionSeparatorComponent={() => <View style={{ height: 12 }} />}
                  contentContainerStyle={[styles.trackList, { paddingTop: 4, paddingBottom: bottomInset + 120 }]}
                  initialNumToRender={18}
                  maxToRenderPerBatch={16}
                  windowSize={9}
                  removeClippedSubviews={Platform.OS === 'android'}
                  stickySectionHeadersEnabled={false}
                  onScroll={onTitlesListScroll}
                  scrollEventThrottle={16}
                  onContentSizeChange={onTitlesListContentSizeChange}
                  refreshControl={
                    <RefreshControl
                      refreshing={refreshingLibrary}
                      onRefresh={onRefreshLibrary}
                      tintColor={theme.colors.accent}
                    />
                  }
                  renderItem={({ item, index, section }) => {
                    if (item.collectionType !== 'track') {
                      return null;
                    }
                    const isLastInSection = index === section.data.length - 1;
                    return (
                      <Pressable
                        style={[styles.trackRow, isLastInSection ? styles.trackRowLast : undefined]}
                        onPress={() => onSelectLibraryItem(item)}
                        onLongPress={() => onLongPressLibraryItem(item)}
                        delayLongPress={170}
                      >
                        <Text style={styles.trackNumber}>{item.trackNumber || index + 1}</Text>
                        <View style={styles.trackCover}>
                          {item.artworkUri ? (
                            <Image source={{ uri: item.artworkUri }} style={styles.coverImage} />
                          ) : (
                            <Text style={styles.coverIcon}>♪</Text>
                          )}
                        </View>
                        <View style={styles.trackBody}>
                          <Text style={styles.trackTitle} numberOfLines={1}>{item.title}</Text>
                          <Text style={styles.trackArtist} numberOfLines={1}>{item.subtitle}</Text>
                        </View>
                        <Text style={styles.trackDuration}>{formatClock(item.durationMs || 0)}</Text>
                      </Pressable>
                    );
                  }}
                />
              )}
              {!shouldShowLibraryTransitionLoader && visibleLibraryItems.length === 0 && (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={styles.emptyStatePlain}
                  refreshControl={
                    <RefreshControl
                      refreshing={refreshingLibrary}
                      onRefresh={onRefreshLibrary}
                      tintColor={theme.colors.accent}
                    />
                  }
                >
                  <Text style={styles.emptyStateText}>
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
                </ScrollView>
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
                  <Text
                    style={styles.playerTitle}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {playerTrack}
                  </Text>
                  {playerTitleShouldScroll && (
                    <Animated.View
                      style={[
                        styles.playerTitleMarqueeRow,
                        styles.playerTitleMarqueeOverlay,
                        {
                          opacity: playerTitleMarqueeOpacity,
                          transform: [{ translateX: playerTitleTranslateX }],
                        },
                      ]}
                    >
                      <Text
                        style={[styles.playerTitle, styles.playerTitleMarqueeText, { width: playerTitleEffectiveWidth + 8 }]}
                      >
                        {playerTrack}
                      </Text>
                    </Animated.View>
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
              {!loadingApps && pinnedVisibleApps.length > 0 && (
                <>
                  <Text style={styles.appsCaption}>Angepinnt</Text>
                  <View style={styles.appsGrid}>
                    {pinnedVisibleApps.map((app) => (
                      <Pressable
                        key={`pinned-${app.packageName}`}
                        style={styles.appCell}
                        onPress={() => launchInstalledLauncherApp(app.packageName)}
                        onLongPress={() => togglePinnedApp(app.packageName)}
                        delayLongPress={260}
                      >
                        <View style={styles.appIcon}>
                          {app.iconUri ? (
                            <Image source={{ uri: app.iconUri }} style={styles.appIconImage} />
                          ) : (
                            <Text style={styles.appIconText}>{app.appName.slice(0, 1).toUpperCase()}</Text>
                          )}
                        </View>
                        <Text style={styles.appName} numberOfLines={2}>{app.appName}</Text>
                        <View style={styles.appPinnedBadge}>
                          <FontAwesome name="thumb-tack" style={styles.appPinnedBadgeIcon} />
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
              <Text style={styles.appsCaption}>Installierte Apps</Text>
              {loadingApps && (
                <View style={styles.loading}>
                  <ActivityIndicator color={theme.colors.accent} />
                  <Text style={styles.helperText}>{t('apps.loading', 'Apps werden geladen…')}</Text>
                </View>
              )}
              {!loadingApps && (
                <View style={styles.appsGrid}>
                  {regularVisibleApps.map((app) => (
                    <Pressable
                      key={app.packageName}
                      style={styles.appCell}
                      onPress={() => launchInstalledLauncherApp(app.packageName)}
                      onLongPress={() => togglePinnedApp(app.packageName)}
                      delayLongPress={260}
                    >
                      <View style={styles.appIcon}>
                        {app.iconUri ? (
                          <Image source={{ uri: app.iconUri }} style={styles.appIconImage} />
                        ) : (
                          <Text style={styles.appIconText}>{app.appName.slice(0, 1).toUpperCase()}</Text>
                        )}
                      </View>
                      <Text style={styles.appName} numberOfLines={2}>{app.appName}</Text>
                      {pinnedAppPackages.includes(app.packageName) && (
                        <View style={styles.appPinnedBadge}>
                          <FontAwesome name="thumb-tack" style={styles.appPinnedBadgeIcon} />
                        </View>
                      )}
                    </Pressable>
                  ))}
                </View>
              )}
              {!loadingApps && pinnedVisibleApps.length === 0 && regularVisibleApps.length === 0 && (
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
                <Text style={styles.settingsVersionInline}>{`Version ${APP_VERSION_DISPLAY} (${APP_BUILD_DISPLAY})`}</Text>
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
                {settingsItems.map((item) => {
                  if (item.id === 'set-audio') {
                    return (
                      <View key={item.id} style={styles.settingRow}>
                        <View style={styles.settingLeading}>
                          <View style={styles.settingIconWrap}>
                            <FontAwesome name={getSettingIconName(item.id)} style={styles.settingIcon} />
                          </View>
                          <View style={styles.settingTextWrap}>
                            <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
                            <Text style={styles.itemSubtitle} numberOfLines={2}>{item.subtitle}</Text>
                          </View>
                        </View>
                        <View style={styles.settingAction}>
                          <Switch
                            value={dlnaRendererEnabled}
                            onValueChange={(nextValue) => {
                              void setDLNARendererEnabled(nextValue)
                                .then((applied) => {
                                  if (applied) {
                                    setDlnaRendererEnabled(nextValue);
                                  }
                                })
                                .catch(() => undefined);
                            }}
                          />
                        </View>
                      </View>
                    );
                  }
                  return (
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
                  );
                })}
                <Pressable
                  style={styles.settingRow}
                  onPress={() => {
                    triggerLibraryDeltaReload();
                  }}
                >
                  <View style={styles.settingLeading}>
                    <View style={styles.settingIconWrap}>
                      <FontAwesome name="refresh" style={styles.settingIcon} />
                    </View>
                    <View style={styles.settingTextWrap}>
                      <Text style={styles.itemTitle} numberOfLines={1}>
                        {t('settings.libraryDeltaReload.title', 'Bibliothek einlesen')}
                      </Text>
                      <Text style={styles.itemSubtitle} numberOfLines={2}>
                        {t('settings.libraryDeltaReload.subtitle', 'Nur Delta-Änderungen werden aktualisiert')}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.settingAction}>
                    <Text style={styles.settingActionText}>
                      {loadingContent ? t('library.loading', 'Lädt…') : t('settings.open', 'Starten')}
                    </Text>
                  </View>
                </Pressable>
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
            {Platform.OS === 'android' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.mode === 'dark' ? '#060a12' : '#f2f6fb' }]} />
            ) : (
              <BlurView
                tint={theme.mode === 'dark' ? 'dark' : 'light'}
                intensity={100}
                style={StyleSheet.absoluteFill}
              />
            )}
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
                    onPress={() => {
                      if (!equalizerSettings.autoEqEnabled && (!equalizerSettings.autoEqProfile || equalizerSettings.autoEqProfile.filters.length === 0)) {
                        setEqualizerMessage('Kein AutoEQ-Profil geladen. Bitte zuerst eine .peq oder .txt Datei importieren.');
                        return;
                      }
                      applyEqualizerSettings(setAutoEqEnabled(equalizerSettings, !equalizerSettings.autoEqEnabled));
                    }}
                  >
                    <Text style={[styles.equalizerToggleText, equalizerSettings.autoEqEnabled ? styles.equalizerToggleTextActive : undefined]}>
                      {equalizerSettings.autoEqEnabled ? 'AN' : 'AUS'}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.equalizerBandRow}>
                  <Text style={styles.equalizerBandFreq}>Pre-Amp</Text>
                  <Pressable
                    style={[styles.equalizerBandButton, !manualEqEditable ? styles.equalizerBandButtonDisabled : undefined]}
                    disabled={!manualEqEditable}
                    onPress={() => {
                      if (!manualEqEditable) {
                        return;
                      }
                      applyEqualizerSettings(setEqualizerPreampGain(equalizerSettings, equalizerSettings.preampDb - 0.5));
                    }}
                  >
                    <Text style={styles.equalizerBandButtonText}>−</Text>
                  </Pressable>
                  <Text style={styles.equalizerBandValue}>{`${equalizerSettings.preampDb > 0 ? '+' : ''}${equalizerSettings.preampDb.toFixed(1)} dB`}</Text>
                  <Pressable
                    style={[styles.equalizerBandButton, !manualEqEditable ? styles.equalizerBandButtonDisabled : undefined]}
                    disabled={!manualEqEditable}
                    onPress={() => {
                      if (!manualEqEditable) {
                        return;
                      }
                      applyEqualizerSettings(setEqualizerPreampGain(equalizerSettings, equalizerSettings.preampDb + 0.5));
                    }}
                  >
                    <Text style={styles.equalizerBandButtonText}>+</Text>
                  </Pressable>
                </View>
                <View style={styles.equalizerBands}>
                  {equalizerSettings.bands.map((band) => (
                    <View key={band.frequency} style={styles.equalizerBandRow}>
                      <Text style={styles.equalizerBandFreq}>{formatFrequencyLabel(band.frequency)}</Text>
                      <Pressable
                        style={[styles.equalizerBandButton, !manualEqEditable ? styles.equalizerBandButtonDisabled : undefined]}
                        disabled={!manualEqEditable}
                        onPress={() => {
                          if (!manualEqEditable) {
                            return;
                          }
                          applyEqualizerSettings(setEqualizerBandGain(equalizerSettings, band.frequency, band.gain - 0.5));
                        }}
                      >
                        <Text style={styles.equalizerBandButtonText}>−</Text>
                      </Pressable>
                      <Text style={styles.equalizerBandValue}>{`${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB`}</Text>
                      <Pressable
                        style={[styles.equalizerBandButton, !manualEqEditable ? styles.equalizerBandButtonDisabled : undefined]}
                        disabled={!manualEqEditable}
                        onPress={() => {
                          if (!manualEqEditable) {
                            return;
                          }
                          applyEqualizerSettings(setEqualizerBandGain(equalizerSettings, band.frequency, band.gain + 0.5));
                        }}
                      >
                        <Text style={styles.equalizerBandButtonText}>+</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
                {!manualEqEditable && (
                  <Text style={styles.equalizerMessage}>AutoEQ ist aktiv. 10-Band-EQ und manueller Pre-Amp sind deaktiviert.</Text>
                )}
                <View style={styles.equalizerButtonRow}>
                  <Pressable style={styles.equalizerActionButton} onPress={() => void onImportAutoEq()}>
                    <Text style={styles.equalizerActionText}>AutoEQ-Datei importieren</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.equalizerActionButton, !manualEqEditable ? styles.equalizerActionButtonDisabled : undefined]}
                    disabled={!manualEqEditable}
                    onPress={() => {
                      if (!manualEqEditable) {
                        return;
                      }
                      applyEqualizerSettings(resetEqualizerBands(equalizerSettings), '10-Band-EQ zurückgesetzt.');
                    }}
                  >
                    <Text style={styles.equalizerActionText}>10-Band reset</Text>
                  </Pressable>
                </View>
                {equalizerSettings.autoEqProfile && (
                  <Text style={styles.equalizerMessage}>{`Aktives Profil: ${equalizerSettings.autoEqProfile.name} (${equalizerSettings.autoEqProfile.filters.length} Filter)`}</Text>
                )}
                {!!equalizerSettings.autoEqProfilesHistory.length && (
                  <View style={styles.equalizerDropdownWrap}>
                    <Text style={styles.equalizerLabel}>AutoEQ Profil</Text>
                    <Pressable
                      style={styles.equalizerDropdownTrigger}
                      onPress={() => setEqualizerProfileDropdownOpen((current) => !current)}
                    >
                      <Text style={styles.equalizerDropdownText}>
                        {equalizerSettings.autoEqProfile?.name || 'Profil auswählen'}
                      </Text>
                      <Text style={styles.equalizerDropdownCaret}>{equalizerProfileDropdownOpen ? '▲' : '▼'}</Text>
                    </Pressable>
                    {equalizerProfileDropdownOpen && (
                      <View style={styles.equalizerDropdownList}>
                        {equalizerSettings.autoEqProfilesHistory.map((profile: AutoEqProfile) => (
                          <Pressable
                            key={profile.name}
                            style={styles.equalizerDropdownItem}
                            onPress={() => {
                              const { settings: nextSettings, error } = selectAutoEqProfile(equalizerSettings, profile.name);
                              if (error) {
                                setEqualizerMessage(error);
                                return;
                              }
                              setEqualizerProfileDropdownOpen(false);
                              applyEqualizerSettings(nextSettings, `Profil "${profile.name}" geladen.`);
                            }}
                          >
                            <Text style={styles.equalizerDropdownItemText}>{profile.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
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
            {Platform.OS === 'android' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.mode === 'dark' ? '#060a12' : '#f2f6fb' }]} />
            ) : (
              <BlurView
                tint={theme.mode === 'dark' ? 'dark' : 'light'}
                intensity={95}
                style={StyleSheet.absoluteFill}
              />
            )}
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
                      <Text style={styles.notificationsItemMessage} numberOfLines={2}>{notification.message}</Text>
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
              <Pressable
                onPress={() => {
                  void handleClearAllNotifications();
                }}
              >
                <Text style={styles.notificationsClearAll}>Alle Löschen</Text>
              </Pressable>
              <Pressable onPress={closeNotifications}>
                <Text style={styles.notificationsClose}>{t('notifications.close', 'Schließen')}</Text>
              </Pressable>
            </View>
            </View>
          </Animated.View>
        )}
      </View>
      <View pointerEvents="none" style={styles.bottomNavBackdrop}>
        {Platform.OS === 'android' ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.mode === 'dark' ? '#060a12' : '#f2f6fb' }]} />
        ) : (
          <BlurView
            tint={theme.mode === 'dark' ? 'dark' : 'light'}
            intensity={95}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={styles.bottomNavBackdropTint} />
      </View>
      {mainTab === 'library' && (loadingContent || librarySyncInProgress) && (
        <View pointerEvents="none" style={styles.libraryProgressRail}>
          <View style={[styles.libraryProgressFill, { width: `${Math.round(libraryLoadProgress * 100)}%` }]} />
        </View>
      )}
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
          </Pressable>
        ))}
      </View>
    </View>
  );
}
