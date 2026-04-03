import { NativeModules, Platform } from 'react-native';

export interface IAudioFileMetadata {
  uri: string;
  title: string;
  artist: string;
  albumArtist?: string;
  album: string;
  trackNumber?: string;
  durationMs: string;
  mimeType?: string;
  sourceLastModified?: string;
  artworkUri?: string;
}

export interface IAudioEntry {
  uri: string;
  displayName: string;
  mimeType: string;
  lastModified: number;
}

export interface IPlaylistEntry {
  uri: string;
  displayName: string;
  lastModified: number;
  trackUris: string[];
}

export interface ILibraryCachedAlbumItem {
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  artworkUri?: string;
  sourceUri?: string;
  collectionType?: 'album';
  mosaicArtworks?: string[];
  trackCount?: number;
}

interface IMediaArtworkNativeModule {
  getMetadataForUris?: (uris: string[]) => Promise<IAudioFileMetadata[]>;
  listAudioEntriesFromRoots?: (rootUris: string[]) => Promise<{
    entries: IAudioEntry[];
    visitedNodes: number;
    leafNodes: number;
    readErrors: number;
    lastError: string;
    folderArtworkByFolderPath?: Record<string, string>;
  }>;
  listPlaylistEntriesFromRoots?: (rootUris: string[]) => Promise<{
    entries: IPlaylistEntry[];
    visitedNodes: number;
    readErrors: number;
    lastError: string;
  }>;
  scanMetadataFromRoots?: (rootUris: string[]) => Promise<{
    rows: IAudioFileMetadata[];
    visitedNodes: number;
    leafNodes: number;
    readErrors: number;
    lastError: string;
    metadataRows: number;
  }>;
  startLibrarySync?: (rootUris: string[]) => Promise<boolean>;
  cancelLibrarySync?: () => Promise<boolean>;
  getLibrarySyncStatus?: () => Promise<ILibrarySyncStatus>;
  getLibraryCachedRows?: (rootUris: string[]) => Promise<IAudioFileMetadata[]>;
  getLibraryCachedAlbums?: (rootUris: string[]) => Promise<{
    rowCount: number;
    items: ILibraryCachedAlbumItem[];
  }>;
}

export interface ILibrarySyncStatus {
  running: boolean;
  stage: string;
  total: number;
  processed: number;
  changed: number;
  cached: number;
  rootKey: string;
  lastError: string;
}

const getNativeModule = (): IMediaArtworkNativeModule | undefined => {
  const modules = NativeModules as Record<string, unknown>;
  return modules.PulseMediaArtworkModule as IMediaArtworkNativeModule | undefined;
};

export const loadMetadataForUris = async (uris: string[]): Promise<IAudioFileMetadata[]> => {
  if (Platform.OS !== 'android') {
    return [];
  }
  const normalizedUris = Array.from(new Set(uris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedUris.length === 0) {
    return [];
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.getMetadataForUris) {
    return [];
  }
  try {
    return await nativeModule.getMetadataForUris(normalizedUris);
  } catch (_error) {
    return [];
  }
};

export interface IAudioScanResult {
  rows: IAudioFileMetadata[];
  visitedNodes: number;
  leafNodes: number;
  readErrors: number;
  lastError: string;
  metadataRows: number;
}

export interface IAudioListResult {
  entries: IAudioEntry[];
  visitedNodes: number;
  leafNodes: number;
  readErrors: number;
  lastError: string;
  folderArtworkByFolderPath?: Record<string, string>;
}

export interface IPlaylistListResult {
  entries: IPlaylistEntry[];
  visitedNodes: number;
  readErrors: number;
  lastError: string;
}

export const listAudioEntriesFromRoots = async (rootUris: string[]): Promise<IAudioListResult> => {
  if (Platform.OS !== 'android') {
    return { entries: [], visitedNodes: 0, leafNodes: 0, readErrors: 0, lastError: '', folderArtworkByFolderPath: {} };
  }
  const normalizedRootUris = Array.from(new Set(rootUris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedRootUris.length === 0) {
    return { entries: [], visitedNodes: 0, leafNodes: 0, readErrors: 0, lastError: '', folderArtworkByFolderPath: {} };
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.listAudioEntriesFromRoots) {
    if (nativeModule?.scanMetadataFromRoots) {
      try {
        const scanResult = await nativeModule.scanMetadataFromRoots(normalizedRootUris);
        const entries: IAudioEntry[] = scanResult.rows.map((row) => ({
          uri: row.uri,
          displayName: row.title || row.uri.split('/').pop() || '',
          mimeType: row.mimeType || '',
          lastModified: Number(row.sourceLastModified || 0),
        }));
        return {
          entries,
          visitedNodes: scanResult.visitedNodes,
          leafNodes: scanResult.leafNodes,
          readErrors: scanResult.readErrors,
          lastError: scanResult.lastError || 'legacy scan fallback',
          folderArtworkByFolderPath: {},
        };
      } catch (_error) {
        return { entries: [], visitedNodes: 0, leafNodes: 0, readErrors: 1, lastError: 'legacy scan failed', folderArtworkByFolderPath: {} };
      }
    }
    return { entries: [], visitedNodes: 0, leafNodes: 0, readErrors: 1, lastError: 'native module missing', folderArtworkByFolderPath: {} };
  }
  try {
    return await nativeModule.listAudioEntriesFromRoots(normalizedRootUris);
  } catch (_error) {
    return { entries: [], visitedNodes: 0, leafNodes: 0, readErrors: 1, lastError: 'native call failed', folderArtworkByFolderPath: {} };
  }
};

export const listPlaylistEntriesFromRoots = async (rootUris: string[]): Promise<IPlaylistListResult> => {
  if (Platform.OS !== 'android') {
    return { entries: [], visitedNodes: 0, readErrors: 0, lastError: '' };
  }
  const normalizedRootUris = Array.from(new Set(rootUris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedRootUris.length === 0) {
    return { entries: [], visitedNodes: 0, readErrors: 0, lastError: '' };
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.listPlaylistEntriesFromRoots) {
    return { entries: [], visitedNodes: 0, readErrors: 0, lastError: 'native module missing' };
  }
  try {
    return await nativeModule.listPlaylistEntriesFromRoots(normalizedRootUris);
  } catch (_error) {
    return { entries: [], visitedNodes: 0, readErrors: 1, lastError: 'native call failed' };
  }
};

export const scanMetadataFromRoots = async (rootUris: string[]): Promise<IAudioScanResult> => {
  if (Platform.OS !== 'android') {
    return { rows: [], visitedNodes: 0, leafNodes: 0, readErrors: 0, lastError: '', metadataRows: 0 };
  }
  const normalizedRootUris = Array.from(new Set(rootUris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedRootUris.length === 0) {
    return { rows: [], visitedNodes: 0, leafNodes: 0, readErrors: 0, lastError: '', metadataRows: 0 };
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.scanMetadataFromRoots) {
    const rows = await loadMetadataForUris(normalizedRootUris);
    return {
      rows,
      visitedNodes: normalizedRootUris.length,
      leafNodes: normalizedRootUris.length,
      readErrors: 0,
      lastError: '',
      metadataRows: rows.length,
    };
  }
  try {
    return await nativeModule.scanMetadataFromRoots(normalizedRootUris);
  } catch (_error) {
    return { rows: [], visitedNodes: 0, leafNodes: 0, readErrors: 1, lastError: 'native call failed', metadataRows: 0 };
  }
};

export const startLibrarySync = async (rootUris: string[]): Promise<boolean> => {
  if (Platform.OS !== 'android') return false;
  const normalizedRootUris = Array.from(new Set(rootUris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedRootUris.length === 0) return false;
  const nativeModule = getNativeModule();
  if (!nativeModule?.startLibrarySync) return false;
  try {
    return await nativeModule.startLibrarySync(normalizedRootUris);
  } catch (_error) {
    return false;
  }
};

export const cancelLibrarySync = async (): Promise<boolean> => {
  if (Platform.OS !== 'android') return false;
  const nativeModule = getNativeModule();
  if (!nativeModule?.cancelLibrarySync) return false;
  try {
    return await nativeModule.cancelLibrarySync();
  } catch (_error) {
    return false;
  }
};

export const getLibrarySyncStatus = async (): Promise<ILibrarySyncStatus> => {
  if (Platform.OS !== 'android') {
    return { running: false, stage: 'idle', total: 0, processed: 0, changed: 0, cached: 0, rootKey: '', lastError: '' };
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.getLibrarySyncStatus) {
    return { running: false, stage: 'idle', total: 0, processed: 0, changed: 0, cached: 0, rootKey: '', lastError: '' };
  }
  try {
    const status = await nativeModule.getLibrarySyncStatus();
    return {
      running: Boolean(status.running),
      stage: String(status.stage || 'idle'),
      total: Number(status.total || 0),
      processed: Number(status.processed || 0),
      changed: Number(status.changed || 0),
      cached: Number(status.cached || 0),
      rootKey: String(status.rootKey || ''),
      lastError: String(status.lastError || ''),
    };
  } catch (_error) {
    return { running: false, stage: 'idle', total: 0, processed: 0, changed: 0, cached: 0, rootKey: '', lastError: '' };
  }
};

export const getLibraryCachedRows = async (rootUris: string[]): Promise<IAudioFileMetadata[]> => {
  if (Platform.OS !== 'android') return [];
  const normalizedRootUris = Array.from(new Set(rootUris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedRootUris.length === 0) return [];
  const nativeModule = getNativeModule();
  if (!nativeModule?.getLibraryCachedRows) return [];
  try {
    return await nativeModule.getLibraryCachedRows(normalizedRootUris);
  } catch (_error) {
    return [];
  }
};

export const getLibraryCachedAlbums = async (rootUris: string[]): Promise<{ rowCount: number; items: ILibraryCachedAlbumItem[] }> => {
  if (Platform.OS !== 'android') return { rowCount: 0, items: [] };
  const normalizedRootUris = Array.from(new Set(rootUris.map((uri) => String(uri || '').trim()).filter(Boolean)));
  if (normalizedRootUris.length === 0) return { rowCount: 0, items: [] };
  const nativeModule = getNativeModule();
  if (!nativeModule?.getLibraryCachedAlbums) return { rowCount: 0, items: [] };
  try {
    const result = await nativeModule.getLibraryCachedAlbums(normalizedRootUris);
    return {
      rowCount: Number(result?.rowCount || 0),
      items: Array.isArray(result?.items) ? result.items : [],
    };
  } catch (_error) {
    return { rowCount: 0, items: [] };
  }
};
