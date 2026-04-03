import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import { NativeModules, Platform } from 'react-native';

import { routeSections } from '../data/launcher-content';
import { ContentRoute, ILauncherPinnedRecord, ILauncherSection } from '../models/launcher';

interface IMediaLibraryNativeModule {
  getSections?: (route: ContentRoute) => Promise<ILauncherSection[]>;
  getPinnedItems?: () => Promise<string[]>;
  getPinnedRecords?: () => Promise<ILauncherPinnedRecord[]>;
  togglePinnedItem?: (itemId: string, itemType: string, title: string) => Promise<boolean>;
  updatePinnedOrder?: (orderedKeys: string[]) => Promise<boolean>;
  getPodcastUpdates?: () => Promise<number>;
}

const FALLBACK_PINNED_STORAGE_KEY = 'pulse-launcher:pinned-records';

export interface IBridgeLoadResult {
  sections: ILauncherSection[];
  source: 'native-module' | 'fallback';
  reason?: 'not-android' | 'module-missing' | 'module-error';
}

export interface IBridgePinnedResult {
  pinnedItems: ILauncherPinnedRecord[];
  source: 'native-module' | 'fallback';
  reason?: 'not-android' | 'module-missing' | 'module-error';
}

const getNativeModule = (): IMediaLibraryNativeModule | undefined => {
  const modules = NativeModules as Record<string, unknown>;
  return modules.PulseMediaLibraryModule as IMediaLibraryNativeModule | undefined;
};

const normalizeSections = (sections: ILauncherSection[]): ILauncherSection[] =>
  sections.map((section) => ({
    id: section.id,
    title: section.title,
    items: section.items
      .filter((item) => item.id && item.title)
      .map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle || '',
        meta: item.meta,
        collectionType: item.collectionType,
      })),
  }));

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const toMediaItemType = (
  value: ILauncherPinnedRecord['collection_item_type'] | ILauncherSection['items'][number]['collectionType'] | undefined,
): ILauncherPinnedRecord['collection_item_type'] => {
  if (value === 'album' || value === 'artist' || value === 'playlist' || value === 'podcast') {
    return value;
  }
  return 'track';
};

const ensureAudioLibraryPermission = async (): Promise<boolean> => {
  const current = await MediaLibrary.getPermissionsAsync();
  if (current.granted) {
    return true;
  }
  const requested = await MediaLibrary.requestPermissionsAsync();
  return !!requested.granted;
};

const normalizeText = (value: string | undefined) => String(value || '').trim();
const getAssetMetadataField = (asset: MediaLibrary.Asset, key: 'artist' | 'album'): string => {
  const metadata = asset as unknown as Record<string, unknown>;
  return normalizeText(typeof metadata[key] === 'string' ? metadata[key] as string : '');
};
const makeTrackSubtitle = (asset: MediaLibrary.Asset) => {
  const artist = getAssetMetadataField(asset, 'artist');
  const album = getAssetMetadataField(asset, 'album');
  if (artist && album) {
    return `${artist} • ${album}`;
  }
  return artist || album || 'Unbekannter Titel';
};

const mapTrackAssetToItem = (
  asset: MediaLibrary.Asset,
  itemType: ILauncherSection['items'][number]['collectionType'] = 'track',
): ILauncherSection['items'][number] => ({
  id: asset.id,
  title: normalizeText(asset.filename) || 'Track',
  subtitle: makeTrackSubtitle(asset),
  meta: normalizeText(asset.duration ? `${Math.round(asset.duration / 1000)}s` : ''),
  collectionType: itemType,
});

const loadFallbackPinnedRecords = async (): Promise<ILauncherPinnedRecord[]> => {
  const raw = await AsyncStorage.getItem(FALLBACK_PINNED_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as ILauncherPinnedRecord[];
    return (parsed || [])
      .filter((entry) => !!entry?.collection_item_id && !!entry?.collection_item_type)
      .map((entry, index) => ({
        collection_item_id: String(entry.collection_item_id),
        collection_item_type: toMediaItemType(entry.collection_item_type),
        order: Number.isFinite(entry.order) ? entry.order : index,
        pinned_at: Number.isFinite(entry.pinned_at) ? entry.pinned_at : Date.now(),
        title: normalizeText(entry.title) || entry.collection_item_id,
      }))
      .sort((left, right) => left.order - right.order);
  } catch (_error) {
    await AsyncStorage.removeItem(FALLBACK_PINNED_STORAGE_KEY);
    return [];
  }
};

const saveFallbackPinnedRecords = async (records: ILauncherPinnedRecord[]): Promise<void> => {
  await AsyncStorage.setItem(
    FALLBACK_PINNED_STORAGE_KEY,
    JSON.stringify(records.map((entry, index) => ({
      ...entry,
      order: index,
    }))),
  );
};

const loadSectionsFromExpoMediaLibrary = async (route: ContentRoute): Promise<ILauncherSection[]> => {
  if (route === 'settings' || route === 'equalizer') {
    return routeSections(route);
  }
  const hasPermission = await ensureAudioLibraryPermission();
  if (!hasPermission) {
    return routeSections(route);
  }

  if (route === 'albums' || route === 'playlists') {
    const albums: MediaLibrary.Album[] = await MediaLibrary.getAlbumsAsync({
      includeSmartAlbums: true,
    });
    const sortedAlbums = [...albums]
      .filter((album: MediaLibrary.Album) => (album.assetCount || 0) > 0)
      .sort((left: MediaLibrary.Album, right: MediaLibrary.Album) => String(left.title).localeCompare(String(right.title), 'de'));
    const limitedAlbums = sortedAlbums.slice(0, route === 'albums' ? 80 : 24);
    return [{
      id: route === 'albums' ? 'albums-device' : 'playlists-device',
      title: route === 'albums' ? 'Alben auf dem Gerät' : 'Geräte-Playlists',
      items: limitedAlbums.map((album: MediaLibrary.Album) => ({
        id: album.id,
        title: normalizeText(album.title) || 'Album',
        subtitle: 'Audio',
        meta: `${Math.max(0, album.assetCount || 0)} Tracks`,
        collectionType: route === 'albums' ? 'album' : 'playlist',
      })),
    }];
  }

  const assetsResponse = await MediaLibrary.getAssetsAsync({
    first: route === 'artists' ? 500 : route === 'library' ? 120 : 160,
    mediaType: [MediaLibrary.MediaType.audio],
    sortBy: [MediaLibrary.SortBy.modificationTime],
  });
  const assets: MediaLibrary.Asset[] = assetsResponse.assets || [];
  if (route === 'artists') {
    const artistCounter = new Map<string, number>();
    assets.forEach((asset: MediaLibrary.Asset) => {
      const artist = getAssetMetadataField(asset, 'artist') || 'Unbekannter Artist';
      artistCounter.set(artist, (artistCounter.get(artist) || 0) + 1);
    });
    const artistItems = Array.from(artistCounter.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 80)
      .map(([artistName, count]) => ({
        id: `artist:${artistName}`,
        title: artistName,
        subtitle: 'Interpret',
        meta: `${count} Tracks`,
        collectionType: 'artist' as const,
      }));
    return [{
      id: 'artists-device',
      title: 'Künstler auf dem Gerät',
      items: artistItems,
    }];
  }

  if (route === 'podcasts') {
    const podcastTerms = ['podcast', 'episode', 'folge', 'chapter'];
    const podcastAssets = assets.filter((asset: MediaLibrary.Asset) => {
      const haystack = `${normalizeText(asset.filename)} ${getAssetMetadataField(asset, 'album')} ${getAssetMetadataField(asset, 'artist')}`.toLowerCase();
      return podcastTerms.some(term => haystack.includes(term));
    });
    return [{
      id: 'podcasts-device',
      title: 'Podcasts auf dem Gerät',
      items: podcastAssets.slice(0, 120).map((asset: MediaLibrary.Asset) => mapTrackAssetToItem(asset, 'podcast')),
    }];
  }

  if (route === 'library') {
    const recentTracks = assets.slice(0, 30);
    const albums: MediaLibrary.Album[] = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    const topAlbums = albums
      .filter((album: MediaLibrary.Album) => (album.assetCount || 0) > 0)
      .sort((left: MediaLibrary.Album, right: MediaLibrary.Album) => (right.assetCount || 0) - (left.assetCount || 0))
      .slice(0, 12);
    return [
      {
        id: 'library-recent-tracks',
        title: 'Zuletzt erkannt',
        items: recentTracks.map((asset: MediaLibrary.Asset) => mapTrackAssetToItem(asset, 'track')),
      },
      {
        id: 'library-top-albums',
        title: 'Starke Alben',
        items: topAlbums.map((album: MediaLibrary.Album) => ({
          id: album.id,
          title: normalizeText(album.title) || 'Album',
          subtitle: 'Album',
          meta: `${Math.max(0, album.assetCount || 0)} Tracks`,
          collectionType: 'album',
        })),
      },
    ];
  }

  return [{
    id: 'tracks-device',
    title: 'Titel auf dem Gerät',
    items: assets.slice(0, 120).map((asset: MediaLibrary.Asset) => mapTrackAssetToItem(asset, 'track')),
  }];
};

export const loadRouteSections = async (route: ContentRoute): Promise<IBridgeLoadResult> => {
  if (Platform.OS !== 'android') {
    return {
      sections: routeSections(route),
      source: 'fallback',
      reason: 'not-android',
    };
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.getSections) {
    try {
      const sections = await loadSectionsFromExpoMediaLibrary(route);
      return {
        sections: normalizeSections(sections),
        source: 'fallback',
        reason: 'module-missing',
      };
    } catch (_error) {
      return {
        sections: routeSections(route),
        source: 'fallback',
        reason: 'module-missing',
      };
    }
  }
  try {
    const sections = await nativeModule.getSections(route);
    return {
      sections: normalizeSections(sections),
      source: 'native-module',
    };
  } catch (_error) {
    return {
      sections: routeSections(route),
      source: 'fallback',
      reason: 'module-error',
    };
  }
};

export const loadPinnedItems = async (): Promise<IBridgePinnedResult> => {
  if (Platform.OS !== 'android') {
    return {
      pinnedItems: [],
      source: 'fallback',
      reason: 'not-android',
    };
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.getPinnedRecords) {
    try {
      return {
        pinnedItems: await loadFallbackPinnedRecords(),
        source: 'fallback',
        reason: 'module-missing',
      };
    } catch (_error) {
      return {
        pinnedItems: [],
        source: 'fallback',
        reason: 'module-missing',
      };
    }
  }
  try {
    const pinnedItems = await nativeModule.getPinnedRecords();
    return {
      pinnedItems: pinnedItems
        .filter((item) => !!item.collection_item_id && !!item.collection_item_type)
        .sort((left, right) => left.order - right.order),
      source: 'native-module',
    };
  } catch (_error) {
    try {
      return {
        pinnedItems: await loadFallbackPinnedRecords(),
        source: 'fallback',
        reason: 'module-error',
      };
    } catch (_secondError) {
      return {
        pinnedItems: [],
        source: 'fallback',
        reason: 'module-error',
      };
    }
  }
};

const normalizeLegacyPinnedKey = (legacyKey: string): { itemId: string; itemType: ILauncherPinnedRecord['collection_item_type'] } | undefined => {
  const normalizedKey = String(legacyKey || '').trim();
  if (!normalizedKey) {
    return undefined;
  }
  const keySegments = normalizedKey.split(':').filter(Boolean);
  if (keySegments.length >= 2) {
    const itemType = String(keySegments[0]).toLowerCase().trim();
    const itemId = keySegments.slice(1).join(':').trim();
    if (!itemId) {
      return undefined;
    }
    if (itemType === 'track' || itemType === 'album' || itemType === 'artist' || itemType === 'playlist' || itemType === 'podcast') {
      return {
        itemId,
        itemType,
      };
    }
  }
  return {
    itemId: normalizedKey,
    itemType: 'track',
  };
};

export const migrateLegacyPinnedItems = async (): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.getPinnedRecords || !nativeModule?.getPinnedItems || !nativeModule?.togglePinnedItem) {
    return false;
  }
  try {
    const [records, legacyPinnedKeys] = await Promise.all([
      nativeModule.getPinnedRecords(),
      nativeModule.getPinnedItems(),
    ]);
    if ((records || []).length > 0 || !(legacyPinnedKeys || []).length) {
      return false;
    }
    const normalizedKeys = (legacyPinnedKeys || [])
      .map((legacyKey) => normalizeLegacyPinnedKey(legacyKey))
      .filter((entry): entry is { itemId: string; itemType: ILauncherPinnedRecord['collection_item_type'] } => !!entry);
    if (!normalizedKeys.length) {
      return false;
    }
    for (const normalizedEntry of normalizedKeys) {
      await nativeModule.togglePinnedItem(
        normalizedEntry.itemId,
        normalizedEntry.itemType,
        normalizedEntry.itemId,
      );
    }
    if (nativeModule.updatePinnedOrder) {
      const orderedKeys = normalizedKeys.map((entry) => `${entry.itemType}:${entry.itemId}`);
      await nativeModule.updatePinnedOrder(orderedKeys);
    }
    return true;
  } catch (_error) {
    return false;
  }
};

export const loadPodcastUpdates = async (): Promise<number> => {
  if (Platform.OS !== 'android') {
    return 0;
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.getPodcastUpdates) {
    try {
      const podcastSections = await loadSectionsFromExpoMediaLibrary('podcasts');
      const updates = podcastSections.reduce((count, section) => count + section.items.length, 0);
      return clamp(updates, 0, 999);
    } catch (_error) {
      return 0;
    }
  }
  try {
    const updates = await nativeModule.getPodcastUpdates();
    if (!Number.isFinite(updates) || updates < 0) {
      return 0;
    }
    return Math.floor(updates);
  } catch (_error) {
    return 0;
  }
};

export const togglePinnedItem = async (
  itemId: string,
  itemType: ILauncherPinnedRecord['collection_item_type'],
  title: string,
): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  if (!itemId || !itemType) {
    return false;
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.togglePinnedItem) {
    const current = await loadFallbackPinnedRecords();
    const existingIndex = current.findIndex(
      (entry) => entry.collection_item_id === itemId && entry.collection_item_type === itemType,
    );
    if (existingIndex >= 0) {
      current.splice(existingIndex, 1);
      await saveFallbackPinnedRecords(current);
      return true;
    }
    current.push({
      collection_item_id: itemId,
      collection_item_type: toMediaItemType(itemType),
      order: current.length,
      pinned_at: Date.now(),
      title: normalizeText(title) || itemId,
    });
    await saveFallbackPinnedRecords(current);
    return true;
  }
  try {
    return !!(await nativeModule.togglePinnedItem(itemId, itemType, title || itemId));
  } catch (_error) {
    return false;
  }
};

export const updatePinnedOrder = async (orderedKeys: string[]): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  if (!orderedKeys.length) {
    return false;
  }
  const nativeModule = getNativeModule();
  if (!nativeModule?.updatePinnedOrder) {
    const current = await loadFallbackPinnedRecords();
    const lookup = new Map(current.map((entry) => [`${entry.collection_item_type}:${entry.collection_item_id}`, entry]));
    const orderedRecords: ILauncherPinnedRecord[] = [];
    orderedKeys.forEach((key, index) => {
      const currentEntry = lookup.get(key);
      if (!currentEntry) {
        return;
      }
      orderedRecords.push({
        ...currentEntry,
        order: index,
      });
    });
    current.forEach((entry) => {
      const key = `${entry.collection_item_type}:${entry.collection_item_id}`;
      if (!orderedKeys.includes(key)) {
        orderedRecords.push({
          ...entry,
          order: orderedRecords.length,
        });
      }
    });
    await saveFallbackPinnedRecords(orderedRecords);
    return true;
  }
  try {
    return !!(await nativeModule.updatePinnedOrder(orderedKeys));
  } catch (_error) {
    return false;
  }
};
