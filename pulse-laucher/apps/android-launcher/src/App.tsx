import React, {
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  burgerMenuEntries,
  pinnedEntries,
  routeHeading,
  routeSubtitle,
} from './data/launcher-content';
import {
  ContentRoute,
  ILauncherListItem,
  ILauncherPinnedRecord,
  ILauncherSection,
} from './models/launcher';
import {
  IInstalledLauncherApp,
  loadInstalledLauncherApps,
  launchInstalledLauncherApp,
} from './services/launcher-apps';
import {
  loadPinnedItems,
  loadPodcastUpdates,
  migrateLegacyPinnedItems,
  loadRouteSections,
  togglePinnedItem,
  updatePinnedOrder,
} from './services/media-library-bridge';
import { AuroraThemeMode, getAuroraTheme } from './theme/aurora-theme';
import PulseLauncherRedesign from './PulseLauncherRedesign';

const createStyles = (auroraTheme: ReturnType<typeof getAuroraTheme>, isCompactDevice: boolean) => StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: auroraTheme.colors.stageBackground,
  },
  screen: {
    flex: 1,
    backgroundColor: auroraTheme.colors.stageBackground,
  },
  topBar: {
    minHeight: isCompactDevice ? 62 : 70,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 0,
    paddingHorizontal: isCompactDevice ? 10 : 14,
    gap: isCompactDevice ? 8 : 10,
    backgroundColor: auroraTheme.colors.stageOverlay,
  },
  burger: {
    width: isCompactDevice ? 40 : 44,
    height: isCompactDevice ? 40 : 44,
    borderRadius: auroraTheme.radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.stageContent,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
  },
  burgerText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 19,
    fontWeight: '700',
  },
  brandBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  logoBadge: {
    width: isCompactDevice ? 30 : 34,
    height: isCompactDevice ? 30 : 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.accent,
  },
  logoBadgeText: {
    color: auroraTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
  },
  brandTextBlock: {
    flex: 1,
  },
  topTitle: {
    color: auroraTheme.colors.textPrimary,
    fontSize: isCompactDevice ? 16 : 18,
    fontWeight: '700',
  },
  topSubtitle: {
    color: auroraTheme.colors.textSecondary,
    fontSize: isCompactDevice ? 10 : 11,
    marginTop: 1,
  },
  contentFrame: {
    flex: 1,
    paddingHorizontal: isCompactDevice ? 10 : 14,
    paddingTop: isCompactDevice ? 8 : 10,
  },
  listContainer: {
    gap: isCompactDevice ? 8 : 10,
    paddingBottom: 22,
  },
  heroCard: {
    borderRadius: auroraTheme.radius.cardLarge,
    paddingHorizontal: isCompactDevice ? 11 : 14,
    paddingVertical: isCompactDevice ? 10 : 14,
    backgroundColor: auroraTheme.colors.stageContent,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
  },
  heroLabel: {
    color: auroraTheme.colors.textMuted,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: auroraTheme.colors.textPrimary,
    fontSize: isCompactDevice ? 16 : 18,
    fontWeight: '800',
    marginTop: 3,
  },
  heroMetaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  heroMetaChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
    backgroundColor: auroraTheme.colors.stageOverlay,
    paddingHorizontal: 10,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroMetaChipText: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  libraryModeRail: {
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
    backgroundColor: auroraTheme.colors.stageOverlay,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
  },
  libraryModeSegment: {
    flex: 1,
    minHeight: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  libraryModeSegmentActive: {
    backgroundColor: auroraTheme.colors.accent,
  },
  libraryModeText: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  libraryModeTextActive: {
    color: auroraTheme.colors.textPrimary,
  },
  sectionTitle: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionBlock: {
    gap: 8,
  },
  listRow: {
    borderRadius: auroraTheme.radius.cardLarge,
    backgroundColor: auroraTheme.colors.stageContent,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
    minHeight: isCompactDevice ? 56 : 62,
    justifyContent: 'center',
    paddingHorizontal: isCompactDevice ? 11 : 14,
    paddingVertical: isCompactDevice ? 8 : 10,
  },
  listRowTitle: {
    color: auroraTheme.colors.textPrimary,
    fontSize: isCompactDevice ? 13 : 14,
    fontWeight: '600',
  },
  listRowTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  listRowSubtitle: {
    color: auroraTheme.colors.textSecondary,
    fontSize: isCompactDevice ? 11 : 12,
    marginTop: 3,
  },
  listRowMeta: {
    color: auroraTheme.colors.textMuted,
    fontSize: 11,
    marginTop: 3,
  },
  emptyBox: {
    borderRadius: auroraTheme.radius.cardLarge,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outline,
    backgroundColor: auroraTheme.colors.stageContent,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 72,
    justifyContent: 'center',
  },
  emptyTitle: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  emptyText: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 12,
    marginTop: 3,
  },
  loadingBox: {
    minHeight: 70,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 12,
  },
  warningBox: {
    borderRadius: auroraTheme.radius.cardLarge,
    borderWidth: 1,
    borderColor: '#6f5321',
    backgroundColor: '#261c0e',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warningTitle: {
    color: '#f8d38b',
    fontSize: 13,
    fontWeight: '700',
  },
  warningText: {
    color: '#e5c99f',
    fontSize: 12,
    marginTop: 3,
  },
  playerBar: {
    minHeight: isCompactDevice ? 66 : 72,
    borderTopWidth: 1,
    borderTopColor: auroraTheme.colors.outline,
    paddingHorizontal: isCompactDevice ? 10 : 14,
    paddingVertical: isCompactDevice ? 8 : 10,
    backgroundColor: auroraTheme.colors.stageOverlay,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playerInfo: {
    flex: 1,
  },
  playerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playerRoundButton: {
    width: isCompactDevice ? 40 : 44,
    height: isCompactDevice ? 40 : 44,
    borderRadius: isCompactDevice ? 20 : 22,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: auroraTheme.colors.stageContent,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outline,
  },
  playerRoundButtonPrimary: {
    backgroundColor: auroraTheme.colors.accent,
    borderColor: auroraTheme.colors.accentPressed,
  },
  playerRoundButtonText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  playerTrack: {
    color: auroraTheme.colors.textPrimary,
    fontSize: isCompactDevice ? 13 : 14,
    fontWeight: '700',
  },
  playerMeta: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  fullscreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0f1115f2',
    zIndex: 20,
  },
  overlayContainer: {
    paddingHorizontal: 12,
    paddingVertical: 14,
    gap: 8,
  },
  overlayHeading: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 2,
  },
  overlayEntry: {
    borderRadius: auroraTheme.radius.button,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outline,
    backgroundColor: auroraTheme.colors.stageContent,
    minHeight: 54,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  overlayEntryActive: {
    borderColor: auroraTheme.colors.accent,
    backgroundColor: auroraTheme.colors.stageHighlight,
  },
  overlayEntryTitle: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  overlayEntrySubtitle: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  overlayEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  overlayEntryMain: {
    flex: 1,
  },
  orderButton: {
    minHeight: 28,
    minWidth: 28,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outline,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.stageBackground,
  },
  orderButtonText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  unpinButton: {
    minHeight: 28,
    minWidth: 28,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#7f3b3b',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2b1717',
  },
  unpinButtonText: {
    color: '#f4b9b9',
    fontSize: 11,
    fontWeight: '700',
  },
  overlayClose: {
    minHeight: 44,
    borderRadius: auroraTheme.radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.stageContent,
    marginTop: 6,
  },
  overlayCloseText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  fullscreenSideview: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: auroraTheme.colors.stageBackground,
    zIndex: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  promptCard: {
    borderRadius: auroraTheme.radius.cardLarge,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
    backgroundColor: auroraTheme.colors.stageContent,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 10,
    gap: 8,
  },
  promptTitle: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  promptText: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 12,
  },
  promptActions: {
    flexDirection: 'row',
    gap: 8,
  },
  promptButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: auroraTheme.radius.button,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outlineSoft,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.stageBackground,
  },
  promptButtonPrimary: {
    backgroundColor: auroraTheme.colors.accent,
    borderColor: auroraTheme.colors.accentPressed,
  },
  promptButtonText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  sideviewHeading: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  sideviewText: {
    color: auroraTheme.colors.textSecondary,
    fontSize: 13,
    marginBottom: 6,
  },
  sideviewClose: {
    minHeight: 44,
    borderRadius: auroraTheme.radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.accent,
    marginTop: 10,
  },
  sideviewCloseText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pinButton: {
    minHeight: 24,
    minWidth: 24,
    paddingHorizontal: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: auroraTheme.colors.outline,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.stageBackground,
  },
  pinButtonPinned: {
    backgroundColor: auroraTheme.colors.accent,
    borderColor: auroraTheme.colors.accentPressed,
  },
  pinButtonText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  podcastBadge: {
    borderRadius: 999,
    minWidth: 20,
    minHeight: 20,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: auroraTheme.colors.accent,
  },
  podcastBadgeText: {
    color: auroraTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
});

const DEFAULT_LAUNCHER_PROMPT_STORAGE_KEY = 'pulse-launcher:default-launcher-prompt-shown';
type MusicLibraryView = 'titles' | 'albums' | 'artists' | 'playlists';
const musicLibraryModes: { key: MusicLibraryView; label: string }[] = [
  { key: 'titles', label: 'Titel' },
  { key: 'albums', label: 'Alben' },
  { key: 'artists', label: 'Künstler' },
  { key: 'playlists', label: 'Playlists' },
];

function LegacyApp() {
  const dimensions = useWindowDimensions();
  const systemColorScheme = useColorScheme();
  const themeMode: AuroraThemeMode = systemColorScheme === 'dark' ? 'dark' : 'light';
  const isCompactDevice = dimensions.width < 390 || dimensions.height < 760;
  const [route, setRoute] = useState<ContentRoute>('library');
  const [libraryView, setLibraryView] = useState<MusicLibraryView>('titles');
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideviewOpen, setSideviewOpen] = useState(false);
  const [loadingApps, setLoadingApps] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [apps, setApps] = useState<IInstalledLauncherApp[]>([]);
  const [appsSource, setAppsSource] = useState<'native-module' | 'fallback'>('fallback');
  const [appsReason, setAppsReason] = useState<'not-android' | 'module-missing' | 'module-error' | undefined>(undefined);
  const [sections, setSections] = useState<ILauncherSection[]>([]);
  const [contentSource, setContentSource] = useState<'native-module' | 'fallback'>('fallback');
  const [contentReason, setContentReason] = useState<'not-android' | 'module-missing' | 'module-error' | undefined>(undefined);
  const [pinnedRecords, setPinnedRecords] = useState<ILauncherPinnedRecord[]>(
    pinnedEntries.map((title, index) => ({
      collection_item_id: `fallback-${index}`,
      collection_item_type: 'track',
      order: index,
      pinned_at: 0,
      title,
    })),
  );
  const [playerState, setPlayerState] = useState<'playing' | 'paused'>('paused');
  const [playerTrack, setPlayerTrack] = useState('Kein Track aktiv');
  const [playerMetaText, setPlayerMetaText] = useState('Pausiert');
  const [playbackQueue, setPlaybackQueue] = useState<ILauncherListItem[]>([]);
  const [playbackQueueIndex, setPlaybackQueueIndex] = useState(-1);
  const [sideviewTitle, setSideviewTitle] = useState('Details');
  const [sideviewSubtitle, setSideviewSubtitle] = useState('Noch keine Auswahl');
  const [podcastUpdates, setPodcastUpdates] = useState(0);
  const [showDefaultLauncherPrompt, setShowDefaultLauncherPrompt] = useState(false);
  const auroraTheme = useMemo(() => getAuroraTheme(themeMode), [themeMode]);
  const styles = useMemo(() => createStyles(auroraTheme, isCompactDevice), [auroraTheme, isCompactDevice]);

  const heading = useMemo(() => routeHeading(route), [route]);
  const subtitle = useMemo(() => routeSubtitle(route), [route]);
  const pinnedItemKeys = useMemo(
    () => new Set(pinnedRecords.map((item) => `${item.collection_item_type}:${item.collection_item_id}`)),
    [pinnedRecords],
  );
  const pinnedTitles = useMemo(
    () => [...pinnedRecords].sort((left, right) => left.order - right.order).map((item) => item.title),
    [pinnedRecords],
  );
  const sortedPinnedRecords = useMemo(
    () => [...pinnedRecords].sort((left, right) => left.order - right.order),
    [pinnedRecords],
  );
  const effectiveContentRoute = useMemo<ContentRoute>(() => {
    if (route !== 'library') {
      return route;
    }
    if (libraryView === 'albums') {
      return 'albums';
    }
    if (libraryView === 'artists') {
      return 'artists';
    }
    if (libraryView === 'playlists') {
      return 'playlists';
    }
    return 'library';
  }, [route, libraryView]);
  const libraryItems = useMemo(() => {
    const allItems = sections.flatMap((section) => section.items);
    if (libraryView === 'titles') {
      return allItems.filter((item) => item.collectionType === 'track' || !item.collectionType);
    }
    if (libraryView === 'albums') {
      return allItems.filter((item) => item.collectionType === 'album');
    }
    if (libraryView === 'artists') {
      return allItems.filter((item) => item.collectionType === 'artist');
    }
    return allItems.filter((item) => item.collectionType === 'playlist');
  }, [sections, libraryView]);

  useEffect(() => {
    if (route !== 'apps') {
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
        setAppsSource(result.source);
        setAppsReason(result.reason);
      })
      .finally(() => {
        if (active) {
          setLoadingApps(false);
        }
      });
    return () => {
      active = false;
    };
  }, [route]);

  useEffect(() => {
    if (route === 'apps') {
      return;
    }
    let active = true;
    setLoadingContent(true);
    loadRouteSections(effectiveContentRoute)
      .then((result) => {
        if (!active) {
          return;
        }
        setSections(result.sections);
        setContentSource(result.source);
        setContentReason(result.reason);
      })
      .finally(() => {
        if (active) {
          setLoadingContent(false);
        }
      });
    return () => {
      active = false;
    };
  }, [route, effectiveContentRoute]);

  useEffect(() => {
    let active = true;
    migrateLegacyPinnedItems()
      .catch(() => false)
      .finally(() => {
        loadPinnedItems().then((result) => {
          if (!active) {
            return;
          }
          setPinnedRecords(result.pinnedItems);
        });
      });
    loadPodcastUpdates().then((updates) => {
      if (!active) {
        return;
      }
      setPodcastUpdates(updates);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    let active = true;
    AsyncStorage.getItem(DEFAULT_LAUNCHER_PROMPT_STORAGE_KEY)
      .then((promptState) => {
        if (!active) {
          return;
        }
        if (promptState === '1') {
          return;
        }
        setShowDefaultLauncherPrompt(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const openRoute = (nextRoute: ContentRoute) => {
    setRoute(nextRoute);
    setMenuOpen(false);
  };

  const persistDefaultLauncherPromptSeen = () => {
    AsyncStorage.setItem(DEFAULT_LAUNCHER_PROMPT_STORAGE_KEY, '1').catch(() => undefined);
  };

  const openDefaultLauncherSettings = async () => {
    if (Platform.OS !== 'android') {
      setSideviewTitle('Standard-Launcher');
      setSideviewSubtitle('Nur auf Android verfügbar');
      setSideviewOpen(true);
      return;
    }
    try {
      await Linking.sendIntent('android.settings.HOME_SETTINGS');
    } catch (_error) {
      setSideviewTitle('Standard-Launcher');
      setSideviewSubtitle('Home-Einstellungen konnten nicht geöffnet werden');
      setSideviewOpen(true);
    }
  };

  const startPlayback = (queue: ILauncherListItem[], index: number) => {
    if (queue.length === 0 || index < 0 || index >= queue.length) {
      return;
    }
    const nextItem = queue[index];
    setPlaybackQueue(queue);
    setPlaybackQueueIndex(index);
    setPlayerTrack(nextItem.title);
    setPlayerMetaText(nextItem.subtitle || 'Wiedergabe aktiv');
    setPlayerState('playing');
  };

  const onSelectItem = async (item: ILauncherListItem, currentItems: ILauncherListItem[]) => {
    if (item.collectionType === 'setting') {
      if (item.id === 'set-media-library') {
        await Linking.openSettings().catch(() => undefined);
        setRoute('library');
        setLibraryView('titles');
        return;
      }
      if (item.id === 'set-default-launcher') {
        persistDefaultLauncherPromptSeen();
        setShowDefaultLauncherPrompt(false);
        await openDefaultLauncherSettings();
        return;
      }
      setSideviewTitle(item.title);
      setSideviewSubtitle(item.subtitle);
      setSideviewOpen(true);
      return;
    }
    const selectedIndex = currentItems.findIndex((entry) => entry.id === item.id);
    const queue = selectedIndex >= 0 ? currentItems : [item];
    const queueIndex = selectedIndex >= 0 ? selectedIndex : 0;
    startPlayback(queue, queueIndex);
  };

  const onTogglePin = async (item: ILauncherListItem) => {
    if (!item.collectionType || item.collectionType === 'setting' || item.collectionType === 'cd-header') {
      return;
    }
    const didToggle = await togglePinnedItem(item.id, item.collectionType as 'track' | 'album' | 'artist' | 'playlist' | 'podcast', item.title);
    if (!didToggle) {
      setSideviewTitle('Pinning');
      setSideviewSubtitle('Pin konnte nicht geändert werden');
      setSideviewOpen(true);
      return;
    }
    const pinnedResult = await loadPinnedItems();
    setPinnedRecords(pinnedResult.pinnedItems);
  };

  const movePinnedRecord = async (
    record: ILauncherPinnedRecord,
    direction: 'up' | 'down',
  ) => {
    const ordered = [...sortedPinnedRecords];
    const index = ordered.findIndex(
      (item) => item.collection_item_id === record.collection_item_id
        && item.collection_item_type === record.collection_item_type,
    );
    if (index < 0) {
      return;
    }
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= ordered.length) {
      return;
    }
    const [moved] = ordered.splice(index, 1);
    ordered.splice(targetIndex, 0, moved);
    const didPersist = await updatePinnedOrder(
      ordered.map((item) => `${item.collection_item_type}:${item.collection_item_id}`),
    );
    if (!didPersist) {
      return;
    }
    const pinnedResult = await loadPinnedItems();
    setPinnedRecords(pinnedResult.pinnedItems);
  };

  const unpinRecord = async (record: ILauncherPinnedRecord) => {
    const didToggle = await togglePinnedItem(
      record.collection_item_id,
      record.collection_item_type,
      record.title,
    );
    if (!didToggle) {
      return;
    }
    const pinnedResult = await loadPinnedItems();
    setPinnedRecords(pinnedResult.pinnedItems);
  };

  const openApp = async (app: IInstalledLauncherApp) => {
    const launched = await launchInstalledLauncherApp(app.packageName);
    if (launched) {
      setSideviewTitle(app.appName);
      setSideviewSubtitle('App wurde gestartet');
    } else {
      setSideviewTitle(app.appName);
      setSideviewSubtitle('App konnte nicht gestartet werden');
    }
    setSideviewOpen(true);
  };

  const displaySections = useMemo<ILauncherSection[]>(() => {
    if (route !== 'library') {
      return sections;
    }
    const sectionTitle = libraryView === 'titles'
      ? 'Titel'
      : libraryView === 'albums'
        ? 'Alben'
        : libraryView === 'artists'
          ? 'Künstler'
          : 'Playlists';
    return [{
      id: `library-${libraryView}`,
      title: sectionTitle,
      items: libraryItems,
    }];
  }, [route, sections, libraryItems, libraryView]);
  const hasVisibleItems = useMemo(
    () => displaySections.some((section) => section.items.length > 0),
    [displaySections],
  );

  const playPrevious = () => {
    if (playbackQueue.length === 0 || playbackQueueIndex <= 0) {
      return;
    }
    startPlayback(playbackQueue, playbackQueueIndex - 1);
  };

  const playNext = () => {
    if (playbackQueue.length === 0 || playbackQueueIndex >= (playbackQueue.length - 1)) {
      return;
    }
    startPlayback(playbackQueue, playbackQueueIndex + 1);
  };

  const togglePlayPause = () => {
    setPlayerState((state) => (state === 'playing' ? 'paused' : 'playing'));
    setPlayerMetaText((text) => (text === 'Pausiert' ? 'Wiedergabe aktiv' : 'Pausiert'));
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable onPress={() => setMenuOpen((open) => !open)} style={styles.burger} hitSlop={8}>
            <Text style={styles.burgerText}>☰</Text>
          </Pressable>
          <View style={styles.brandBlock}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>AP</Text>
            </View>
            <View style={styles.brandTextBlock}>
              <Text style={styles.topTitle}>
                {'Aurora '}
                <Text style={{ fontFamily: 'cursive' }}>Pulse</Text>
                {` · ${heading}`}
              </Text>
              <Text style={styles.topSubtitle}>{subtitle}</Text>
            </View>
          </View>
        </View>

        <View style={styles.contentFrame}>
          <ScrollView contentContainerStyle={styles.listContainer}>
            {route === 'library' ? (
              <View style={styles.libraryModeRail}>
                {musicLibraryModes.map((mode) => (
                  <Pressable
                    key={mode.key}
                    style={[styles.libraryModeSegment, libraryView === mode.key ? styles.libraryModeSegmentActive : undefined]}
                    onPress={() => setLibraryView(mode.key)}
                  >
                    <Text style={[styles.libraryModeText, libraryView === mode.key ? styles.libraryModeTextActive : undefined]}>
                      {mode.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View style={styles.heroCard}>
                <Text style={styles.heroLabel}>Aurora Pulse Launcher</Text>
                <Text style={styles.heroTitle}>{heading}</Text>
              </View>
            )}
            {showDefaultLauncherPrompt && (
              <View style={styles.promptCard}>
                <Text style={styles.promptTitle}>Als Standard-Launcher festlegen?</Text>
                <Text style={styles.promptText}>
                  Damit Pulse direkt nach Home-Taste startet, setze ihn als Standard-Launcher.
                </Text>
                <View style={styles.promptActions}>
                  <Pressable
                    style={[styles.promptButton, styles.promptButtonPrimary]}
                    onPress={async () => {
                      persistDefaultLauncherPromptSeen();
                      setShowDefaultLauncherPrompt(false);
                      await openDefaultLauncherSettings();
                    }}
                  >
                    <Text style={styles.promptButtonText}>Jetzt festlegen</Text>
                  </Pressable>
                  <Pressable
                    style={styles.promptButton}
                    onPress={() => {
                      persistDefaultLauncherPromptSeen();
                      setShowDefaultLauncherPrompt(false);
                    }}
                  >
                    <Text style={styles.promptButtonText}>Später</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {route !== 'apps' && contentSource === 'fallback' && contentReason === 'module-error' && (
              <View style={styles.warningBox}>
                <Text style={styles.warningTitle}>Bridge läuft im Fallback-Modus</Text>
                <Text style={styles.warningText}>
                  Native Media-Bridge liefert Fehler. Fallback wurde aktiviert.
                </Text>
              </View>
            )}
            {route === 'library' && !hasVisibleItems && (
              <View style={styles.promptCard}>
                <Text style={styles.promptTitle}>Musikzugriff einrichten</Text>
                <Text style={styles.promptText}>
                  Öffne die App-Berechtigungen und aktiviere Audiozugriff, damit Tracks, Alben und Künstler geladen werden.
                </Text>
                <View style={styles.promptActions}>
                  <Pressable
                    style={[styles.promptButton, styles.promptButtonPrimary]}
                    onPress={() => {
                      Linking.openSettings().catch(() => undefined);
                    }}
                  >
                    <Text style={styles.promptButtonText}>Berechtigungen öffnen</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {route !== 'apps' && displaySections.map((section) => (
              <View key={section.id} style={styles.sectionBlock}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {loadingContent && (
                  <View style={styles.loadingBox}>
                    <ActivityIndicator color={auroraTheme.colors.accent} size="small" />
                    <Text style={styles.loadingText}>Inhalte werden geladen</Text>
                  </View>
                )}
                {section.items.length === 0 && (
                  <View style={styles.emptyBox}>
                    <Text style={styles.emptyTitle}>Noch keine Daten vorhanden</Text>
                    <Text style={styles.emptyText}>
                      Verbinde Medienquelle oder aktiviere Import für diesen Bereich.
                    </Text>
                  </View>
                )}
                {section.items.map((item) => {
                  const pinKey = item.collectionType ? `${item.collectionType}:${item.id}` : '';
                  const isPinned = !!pinKey && pinnedItemKeys.has(pinKey);
                  return (
                    <Pressable
                      key={item.id}
                      style={styles.listRow}
                      onPress={() => onSelectItem(item, section.items)}
                    >
                    <View style={styles.rowTitleLine}>
                      <View style={styles.listRowTitleWrap}>
                        <Text style={styles.listRowTitle}>{item.title}</Text>
                        {isPinned && <Text style={styles.podcastBadgeText}>●</Text>}
                      </View>
                      <View style={styles.rowActions}>
                        {item.collectionType && item.collectionType !== 'setting' && (
                          <Pressable
                            style={[styles.pinButton, isPinned ? styles.pinButtonPinned : undefined]}
                            onPress={() => onTogglePin(item)}
                          >
                            <Text style={styles.pinButtonText}>{isPinned ? 'PIN' : '+'}</Text>
                          </Pressable>
                        )}
                        {route === 'podcasts' && podcastUpdates > 0 && (
                          <View style={styles.podcastBadge}>
                            <Text style={styles.podcastBadgeText}>{podcastUpdates}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <Text style={styles.listRowSubtitle}>{item.subtitle}</Text>
                    {!!item.meta && <Text style={styles.listRowMeta}>{item.meta}</Text>}
                  </Pressable>
                  );
                })}
              </View>
            ))}

            {route === 'apps' && loadingApps && (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={auroraTheme.colors.accent} size="small" />
                <Text style={styles.loadingText}>Installierte Apps werden gelesen</Text>
              </View>
            )}

            {route === 'apps' && !loadingApps && apps.length === 0 && (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>Keine installierten Apps erkannt</Text>
                <Text style={styles.emptyText}>
                  Prüfe Native-Bridge und Package-Visibility auf dem DAP.
                </Text>
              </View>
            )}
            {route === 'apps' && appsSource === 'fallback' && appsReason === 'module-error' && (
              <View style={styles.warningBox}>
                <Text style={styles.warningTitle}>App-Bridge im Fallback-Modus</Text>
                <Text style={styles.warningText}>
                  Native App-Liste fehlerhaft. System-Shortcuts werden angezeigt.
                </Text>
              </View>
            )}

            {route === 'apps' && !loadingApps && apps.map((app) => (
              <Pressable key={app.packageName} style={styles.listRow} onPress={() => openApp(app)}>
                <Text style={styles.listRowTitle}>{app.appName}</Text>
                <Text style={styles.listRowSubtitle}>{app.packageName}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.playerBar}>
          <View style={styles.playerInfo}>
            <Text style={styles.playerTrack} numberOfLines={1}>{playerTrack}</Text>
            <Text style={styles.playerMeta}>{playerMetaText}</Text>
          </View>
          <View style={styles.playerControls}>
            <Pressable
              style={styles.playerRoundButton}
              onPress={playPrevious}
              hitSlop={8}
            >
              <Text style={styles.playerRoundButtonText}>⏮</Text>
            </Pressable>
            <Pressable
              style={[styles.playerRoundButton, styles.playerRoundButtonPrimary]}
              onPress={togglePlayPause}
              hitSlop={8}
            >
              <Text style={styles.playerRoundButtonText}>{playerState === 'playing' ? '⏸' : '▶'}</Text>
            </Pressable>
            <Pressable
              style={styles.playerRoundButton}
              onPress={playNext}
              hitSlop={8}
            >
              <Text style={styles.playerRoundButtonText}>⏭</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {menuOpen && (
        <View style={styles.fullscreenOverlay}>
          <ScrollView contentContainerStyle={styles.overlayContainer}>
            <Text style={styles.overlayHeading}>Menü</Text>
            {burgerMenuEntries.map((entry) => (
              <Pressable
                key={entry.key}
                style={[styles.overlayEntry, route === entry.key ? styles.overlayEntryActive : undefined]}
                onPress={() => openRoute(entry.key)}
              >
                <Text style={styles.overlayEntryTitle}>{`${entry.icon}  ${entry.label}`}</Text>
                <Text style={styles.overlayEntrySubtitle}>{entry.subtitle}</Text>
              </Pressable>
            ))}

            <Text style={styles.overlayHeading}>Angepinnt</Text>
            {pinnedTitles.length === 0 && (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>Keine angepinnten Elemente</Text>
                <Text style={styles.emptyText}>Pins werden aus echter Bibliothek übernommen.</Text>
              </View>
            )}
            {sortedPinnedRecords.map((entry, index) => (
              <Pressable
                key={`${entry.collection_item_type}:${entry.collection_item_id}`}
                style={styles.overlayEntry}
                onPress={() => {
                  setSideviewTitle(entry.title);
                  setSideviewSubtitle('Angepinnter Eintrag');
                  setMenuOpen(false);
                  setSideviewOpen(true);
                }}
              >
                <View style={styles.overlayEntryRow}>
                  <View style={styles.overlayEntryMain}>
                    <Text style={styles.overlayEntryTitle}>{entry.title}</Text>
                    <Text style={styles.overlayEntrySubtitle}>
                      {`Direktzugriff · ${entry.collection_item_type}`}
                    </Text>
                  </View>
                  <Pressable style={styles.orderButton} onPress={() => movePinnedRecord(entry, 'up')}>
                    <Text style={styles.orderButtonText}>↑</Text>
                  </Pressable>
                  <Pressable style={styles.orderButton} onPress={() => movePinnedRecord(entry, 'down')}>
                    <Text style={styles.orderButtonText}>↓</Text>
                  </Pressable>
                  <Pressable style={styles.unpinButton} onPress={() => unpinRecord(entry)}>
                    <Text style={styles.unpinButtonText}>×</Text>
                  </Pressable>
                </View>
              </Pressable>
            ))}
            <Pressable style={styles.overlayClose} onPress={() => setMenuOpen(false)}>
              <Text style={styles.overlayCloseText}>Schließen</Text>
            </Pressable>
          </ScrollView>
        </View>
      )}

      {sideviewOpen && (
        <View style={styles.fullscreenSideview}>
          <Text style={styles.sideviewHeading}>{sideviewTitle}</Text>
          <Text style={styles.sideviewText}>{sideviewSubtitle}</Text>
          <Text style={styles.sideviewText}>Aurora Pulse Sideview im Vollbildmodus</Text>
          <Pressable style={styles.sideviewClose} onPress={() => setSideviewOpen(false)}>
            <Text style={styles.sideviewCloseText}>Zurück</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

export default PulseLauncherRedesign;
