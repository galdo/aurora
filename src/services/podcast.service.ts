import fs from 'fs';
import path from 'path';
import _ from 'lodash';

import {
  IPodcastDirectoryEntry,
  IPodcastDirectorySearchFilters,
  IPodcastDirectorySource,
  IPodcastEpisode,
  IPodcastSubscription,
} from '../interfaces';

import { AppService } from './app.service';
import { NotificationService } from './notification.service';

type PodcastSyncResult = {
  copiedFiles: number;
  deletedFiles: number;
  downloadedEpisodes: number;
  totalFiles: number;
  syncedFiles: number;
};

export type PodcastPlaybackSnapshot = {
  episode?: IPodcastEpisode;
  subscription?: IPodcastSubscription;
  isActive: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
};

export class PodcastService {
  static readonly podcastStorageKey = 'aurora:podcasts';
  static readonly podcastPlaybackSeenStorageKey = 'aurora:podcasts:played-episodes';
  static readonly podcastChangeEventName = 'aurora:podcasts-updated';
  static readonly podcastPlaybackChangeEventName = 'aurora:podcast-playback-updated';
  static readonly podcastDirectoryName = 'Podcasts';
  static readonly podcastSyncEpisodeLimit = 5;
  private static podcastPlaybackAudio: HTMLAudioElement | null = null;
  private static podcastPlaybackEpisode: IPodcastEpisode | undefined;
  private static podcastPlaybackSubscription: IPodcastSubscription | undefined;
  private static podcastPlaybackTickInterval: number | undefined;
  private static podcastStorageFilePath: string | undefined;

  private static normalizeDirectorySource(source: unknown): IPodcastDirectorySource {
    if (source === 'de' || source === 'eu') {
      return source;
    }
    return 'global';
  }

  static getSubscriptions(): IPodcastSubscription[] {
    const subscriptionsFromLocalStorage = this.parseSubscriptions(localStorage.getItem(this.podcastStorageKey));
    const subscriptionsFromFileStorage = this.readSubscriptionsFromFileStorage();
    const effectiveSubscriptions = this.resolveEffectiveSubscriptions(
      subscriptionsFromLocalStorage,
      subscriptionsFromFileStorage,
    );

    if (effectiveSubscriptions.length > 0) {
      this.persistSubscriptionsToLocalStorage(effectiveSubscriptions);
      this.persistSubscriptionsToFileStorage(effectiveSubscriptions);
    }

    return effectiveSubscriptions;
  }

  static subscribe(listener: () => void): () => void {
    const handler = () => listener();
    window.addEventListener(this.podcastChangeEventName, handler);
    return () => window.removeEventListener(this.podcastChangeEventName, handler);
  }

  static subscribePlayback(listener: () => void): () => void {
    const handler = () => listener();
    window.addEventListener(this.podcastPlaybackChangeEventName, handler);
    return () => window.removeEventListener(this.podcastPlaybackChangeEventName, handler);
  }

  static getPlaybackSnapshot(): PodcastPlaybackSnapshot {
    const audio = this.podcastPlaybackAudio;
    return {
      episode: this.podcastPlaybackEpisode,
      subscription: this.podcastPlaybackSubscription,
      isActive: !!audio && !!this.podcastPlaybackEpisode,
      isPlaying: !!audio && !audio.paused && !audio.ended,
      currentTime: audio?.currentTime || 0,
      duration: Number.isFinite(audio?.duration) ? Number(audio?.duration) : 0,
    };
  }

  static isEpisodeListened(subscription: IPodcastSubscription, episode: IPodcastEpisode): boolean {
    const listenedEpisodeIds = this.getListenedEpisodeIdSet(subscription.id);
    return listenedEpisodeIds.has(episode.id);
  }

  static async playEpisode(subscription: IPodcastSubscription, episode: IPodcastEpisode): Promise<boolean> {
    this.stopPlayback();
    const audio = new Audio(episode.audioUrl);
    this.podcastPlaybackAudio = audio;
    this.podcastPlaybackEpisode = episode;
    this.podcastPlaybackSubscription = subscription;
    this.markEpisodeAsListened(subscription.id, episode.id);

    audio.onended = () => {
      this.stopPlayback();
    };

    audio.ontimeupdate = () => {
      this.dispatchPlaybackUpdate();
    };

    audio.onpause = () => {
      this.dispatchPlaybackUpdate();
    };

    audio.onplay = () => {
      this.dispatchPlaybackUpdate();
    };

    audio.onloadedmetadata = () => {
      this.dispatchPlaybackUpdate();
    };

    this.startPlaybackTick();
    this.dispatchPlaybackUpdate();

    try {
      await audio.play();
      this.dispatchPlaybackUpdate();
      return true;
    } catch (_error) {
      this.stopPlayback();
      return false;
    }
  }

  static async toggleEpisodePlayback(subscription: IPodcastSubscription, episode: IPodcastEpisode): Promise<boolean> {
    if (this.podcastPlaybackEpisode?.id === episode.id && this.podcastPlaybackAudio) {
      if (this.podcastPlaybackAudio.paused) {
        await this.resumePlayback();
      } else {
        await this.pausePlayback();
      }
      return true;
    }

    return this.playEpisode(subscription, episode);
  }

  static async pausePlayback(): Promise<boolean> {
    const audio = this.podcastPlaybackAudio;
    if (!audio) {
      return false;
    }
    audio.pause();
    this.dispatchPlaybackUpdate();
    return true;
  }

  static async resumePlayback(): Promise<boolean> {
    const audio = this.podcastPlaybackAudio;
    if (!audio) {
      return false;
    }
    try {
      await audio.play();
      this.dispatchPlaybackUpdate();
      return true;
    } catch (_error) {
      return false;
    }
  }

  static seekPlayback(time: number): boolean {
    const audio = this.podcastPlaybackAudio;
    if (!audio) {
      return false;
    }
    audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
    this.dispatchPlaybackUpdate();
    return true;
  }

  static stopPlayback(): boolean {
    if (!this.podcastPlaybackAudio) {
      return false;
    }

    const audio = this.podcastPlaybackAudio;
    audio.pause();
    audio.src = '';
    audio.onended = null;
    audio.ontimeupdate = null;
    audio.onpause = null;
    audio.onplay = null;
    audio.onloadedmetadata = null;
    this.podcastPlaybackAudio = null;
    this.podcastPlaybackEpisode = undefined;
    this.podcastPlaybackSubscription = undefined;
    this.stopPlaybackTick();
    this.dispatchPlaybackUpdate();
    return true;
  }

  static hasNewEpisodes(): boolean {
    return this.getSubscriptions().some(subscription => subscription.hasNewEpisodes);
  }

  static async searchPodcastDirectory(filters: IPodcastDirectorySearchFilters): Promise<IPodcastDirectoryEntry[]> {
    const source = this.normalizeDirectorySource(filters.source);
    let countries = ['US'];
    if (source === 'de') {
      countries = ['DE'];
    } else if (source === 'eu') {
      countries = ['DE', 'FR', 'ES', 'IT', 'GB', 'NL'];
    }
    const query = String(filters.query || '').trim();

    if (_.isEmpty(query)) {
      return [];
    }

    const countrySearches = await Promise.all(countries.map(async (country) => {
      const searchUrl = new URL('https://itunes.apple.com/search');
      searchUrl.searchParams.set('term', query);
      searchUrl.searchParams.set('entity', 'podcast');
      searchUrl.searchParams.set('media', 'podcast');
      searchUrl.searchParams.set('country', country);
      searchUrl.searchParams.set('limit', source === 'eu' ? '40' : '80');

      const response = await fetch(searchUrl.toString());
      if (!response.ok) {
        throw new Error(`Podcast search failed with status ${response.status}`);
      }

      const payload = await response.json();
      return Array.isArray(payload?.results) ? payload.results : [];
    }));

    const results = countrySearches.flat();
    const publisherFilter = String(filters.publisher || '').trim().toLowerCase();
    const genreFilter = String(filters.genre || '').trim().toLowerCase();
    const minRating = Number(filters.minRating || 0);

    const mappedResults = results
      .filter((entry: any) => !_.isEmpty(entry?.feedUrl))
      .map((entry: any): IPodcastDirectoryEntry => ({
        id: String(entry.collectionId || entry.trackId || _.uniqueId('podcast_')),
        title: String(entry.collectionName || entry.trackName || ''),
        publisher: String(entry.artistName || ''),
        genre: String(entry.primaryGenreName || ''),
        rating: Number(entry.averageUserRating || entry.averageUserRatingForCurrentVersion || 0),
        imageUrl: String(entry.artworkUrl600 || entry.artworkUrl100 || ''),
        feedUrl: String(entry.feedUrl || ''),
        source,
      }))
      .filter((entry: IPodcastDirectoryEntry) => {
        if (_.isEmpty(entry.title) || _.isEmpty(entry.feedUrl)) {
          return false;
        }
        if (publisherFilter && !entry.publisher.toLowerCase().includes(publisherFilter)) {
          return false;
        }
        if (genreFilter && !entry.genre.toLowerCase().includes(genreFilter)) {
          return false;
        }
        if (entry.rating < minRating) {
          return false;
        }
        return true;
      });

    return mappedResults.filter((entry, index) => (
      mappedResults.findIndex(candidate => (
        candidate.feedUrl === entry.feedUrl || candidate.id === entry.id
      )) === index
    ));
  }

  static async subscribeToPodcast(entry: IPodcastDirectoryEntry): Promise<void> {
    const existingSubscriptions = this.getSubscriptions();
    if (existingSubscriptions.some(subscription => subscription.id === entry.id || subscription.feedUrl === entry.feedUrl)) {
      return;
    }

    const newSubscription: IPodcastSubscription = {
      id: entry.id,
      title: entry.title,
      publisher: entry.publisher,
      genre: entry.genre,
      rating: entry.rating,
      imageUrl: entry.imageUrl,
      feedUrl: entry.feedUrl,
      source: entry.source,
      hasNewEpisodes: false,
      updatedAt: Date.now(),
      episodes: [],
    };

    const updatedSubscriptions = [...existingSubscriptions, newSubscription];
    this.setSubscriptions(updatedSubscriptions);
    await this.refreshSubscriptions();
  }

  static markAllEpisodesAsSeen() {
    const subscriptions = this.getSubscriptions().map(subscription => ({
      ...subscription,
      hasNewEpisodes: false,
      episodes: subscription.episodes.map(episode => ({
        ...episode,
        isNew: false,
      })),
    }));
    this.setSubscriptions(subscriptions);
  }

  static async refreshSubscriptions(): Promise<IPodcastSubscription[]> {
    const subscriptions = this.getSubscriptions();
    if (subscriptions.length === 0) {
      return [];
    }

    const refreshedSubscriptions = await Promise.all(subscriptions.map(async (subscription) => {
      const episodes = await this.fetchEpisodes(subscription.feedUrl).catch(() => []);
      const previousEpisodeIds = new Set(subscription.episodes.map(episode => episode.id));
      const mergedEpisodes = episodes.map(episode => ({
        ...episode,
        isNew: previousEpisodeIds.size > 0 && !previousEpisodeIds.has(episode.id),
      }));
      const hasNewEpisodes = mergedEpisodes.some(episode => episode.isNew);
      return {
        ...subscription,
        episodes: mergedEpisodes,
        hasNewEpisodes,
        updatedAt: Date.now(),
      };
    }));

    this.setSubscriptions(refreshedSubscriptions);
    return refreshedSubscriptions;
  }

  static async syncPodcastsToDap(input: {
    targetDirectory: string,
    deleteMissingOnDevice?: boolean,
    signal?: AbortSignal,
  }): Promise<PodcastSyncResult> {
    const { signal } = input;
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new Error('DAP_SYNC_ABORTED');
      }
    };
    let targetDirectory = String(input.targetDirectory || '').trim();
    if (!targetDirectory) {
      return {
        copiedFiles: 0,
        deletedFiles: 0,
        downloadedEpisodes: 0,
        totalFiles: 0,
        syncedFiles: 0,
      };
    }

    if (path.basename(targetDirectory).toLowerCase() === 'music') {
      targetDirectory = path.dirname(targetDirectory);
    }

    const legacySyncRootPath = path.join(targetDirectory, 'Music', this.podcastDirectoryName);
    const legacySyncRootExists = await fs.promises
      .stat(legacySyncRootPath)
      .then(stats => stats.isDirectory())
      .catch(() => false);
    const legacyFiles = legacySyncRootExists ? await this.getFilesRecursive(legacySyncRootPath) : [];
    const legacyPathByFileName = new Map<string, string[]>();
    legacyFiles.forEach((legacyFilePath) => {
      const fileName = path.basename(legacyFilePath).toLowerCase();
      const existingPaths = legacyPathByFileName.get(fileName) || [];
      legacyPathByFileName.set(fileName, [...existingPaths, legacyFilePath]);
    });

    throwIfAborted();
    const subscriptions = await this.refreshSubscriptions();
    const syncRootPath = path.join(targetDirectory, this.podcastDirectoryName);
    await fs.promises.mkdir(syncRootPath, { recursive: true });

    const expectedFilePaths = new Set<string>();
    const syncResults = await Promise.all(subscriptions.map(async (subscription) => {
      throwIfAborted();
      const podcastAuthorName = String(subscription.publisher || '').trim();
      const podcastDirectoryName = this.truncatePathPart(this.sanitizePathPart(podcastAuthorName || subscription.title), 120);
      const podcastDirectory = path.join(syncRootPath, podcastDirectoryName);
      await fs.promises.mkdir(podcastDirectory, { recursive: true });

      const episodeCandidates = subscription.episodes
        .filter(episode => !_.isEmpty(episode.audioUrl))
        .slice(0, this.podcastSyncEpisodeLimit);

      const episodeSyncResult = await Promise.all(episodeCandidates.map(async (episode, episodeIndex) => {
        throwIfAborted();
        const extension = this.getFileExtensionFromUrl(episode.audioUrl);
        const fileName = this.truncatePathPart(`${String(episodeIndex + 1).padStart(2, '0')} - ${this.sanitizePathPart(episode.title)}${extension}`, 160);
        const destinationPath = path.join(podcastDirectory, fileName);
        expectedFilePaths.add(destinationPath);

        let exists = await fs.promises.stat(destinationPath).then(() => true).catch(() => false);
        if (!exists) {
          const legacyCandidates = legacyPathByFileName.get(fileName.toLowerCase()) || [];
          const legacyCandidatePath = legacyCandidates.shift();
          if (legacyCandidatePath) {
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
            await fs.promises.rename(legacyCandidatePath, destinationPath).catch(async (error: any) => {
              if (String(error?.code || '').toUpperCase() !== 'EXDEV') {
                return;
              }
              await fs.promises.copyFile(legacyCandidatePath, destinationPath);
              await fs.promises.unlink(legacyCandidatePath).catch(() => undefined);
            });
            exists = await fs.promises.stat(destinationPath).then(() => true).catch(() => false);
          }
        }
        if (!exists) {
          const response = await fetch(episode.audioUrl, {
            signal,
          });
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            throwIfAborted();
            await fs.promises.writeFile(destinationPath, new Uint8Array(arrayBuffer));
            return {
              copiedFiles: 1,
              downloadedEpisodes: 1,
            };
          }
        }
        return {
          copiedFiles: 0,
          downloadedEpisodes: 0,
        };
      }));
      return episodeSyncResult.reduce((result, entry) => ({
        copiedFiles: result.copiedFiles + entry.copiedFiles,
        downloadedEpisodes: result.downloadedEpisodes + entry.downloadedEpisodes,
      }), {
        copiedFiles: 0,
        downloadedEpisodes: 0,
      });
    }));
    const syncTotals = syncResults.reduce((result, entry) => ({
      copiedFiles: result.copiedFiles + entry.copiedFiles,
      downloadedEpisodes: result.downloadedEpisodes + entry.downloadedEpisodes,
    }), {
      copiedFiles: 0,
      downloadedEpisodes: 0,
    });

    let deletedFiles = 0;

    if (input.deleteMissingOnDevice !== false) {
      throwIfAborted();
      const existingFiles = await this.getFilesRecursive(syncRootPath);
      const deleteResult = await Promise.all(existingFiles.map(async (existingFile) => {
        if (!expectedFilePaths.has(existingFile)) {
          await fs.promises.unlink(existingFile).catch(() => undefined);
          return true;
        }
        return false;
      }));
      deletedFiles += deleteResult.filter(Boolean).length;
      const legacyStillExistingFiles = await this.getFilesRecursive(legacySyncRootPath).catch(() => []);
      deletedFiles += legacyStillExistingFiles.length;
      await fs.promises.rm(legacySyncRootPath, { recursive: true, force: true }).catch(() => undefined);
    }

    const subscriptionsCleared = this.getSubscriptions().map(subscription => ({
      ...subscription,
      hasNewEpisodes: false,
      episodes: subscription.episodes.map(episode => ({
        ...episode,
        isNew: false,
      })),
    }));
    this.setSubscriptions(subscriptionsCleared);

    NotificationService.showMessage(`Podcast Sync: ${syncTotals.downloadedEpisodes} geladen, ${syncTotals.copiedFiles} auf DAP synchronisiert, ${deletedFiles} gelöscht.`);

    const expectedFilePathList = [...expectedFilePaths];
    const syncedFiles = (await Promise.all(expectedFilePathList.map(async (expectedFilePath) => {
      const fileStats = await fs.promises.stat(expectedFilePath).catch(() => undefined);
      return !!fileStats && fileStats.isFile() && Number(fileStats.size || 0) > 0;
    }))).filter(Boolean).length;

    return {
      copiedFiles: syncTotals.copiedFiles,
      deletedFiles,
      downloadedEpisodes: syncTotals.downloadedEpisodes,
      totalFiles: expectedFilePaths.size,
      syncedFiles,
    };
  }

  static getExpectedDapSyncFileCount(): number {
    const subscriptions = this.getSubscriptions();
    return subscriptions.reduce((count, subscription) => {
      const expectedEpisodeCount = subscription.episodes
        .filter(episode => !_.isEmpty(episode.audioUrl))
        .slice(0, this.podcastSyncEpisodeLimit)
        .length;
      return count + expectedEpisodeCount;
    }, 0);
  }

  private static async fetchEpisodes(feedUrl: string): Promise<IPodcastEpisode[]> {
    const response = await fetch(feedUrl);
    if (!response.ok) {
      throw new Error(`RSS fetch failed with status ${response.status}`);
    }
    const xmlText = await response.text();
    const parser = new DOMParser();
    const documentParsed = parser.parseFromString(xmlText, 'text/xml');
    const itemElements = Array.from(documentParsed.querySelectorAll('channel > item'));

    const episodes = itemElements.map((itemElement, index) => {
      const enclosureUrl = itemElement.querySelector('enclosure')?.getAttribute('url')
        || itemElement.querySelector('media\\:content')?.getAttribute('url')
        || '';
      const guid = itemElement.querySelector('guid')?.textContent?.trim();
      const title = itemElement.querySelector('title')?.textContent?.trim() || `Episode ${index + 1}`;
      const publishedRaw = itemElement.querySelector('pubDate')?.textContent?.trim() || '';
      const publishedAt = Number(new Date(publishedRaw).getTime()) || 0;
      const description = itemElement.querySelector('description')?.textContent?.trim() || '';
      const id = String(guid || `${title}__${publishedRaw}__${enclosureUrl}`);

      return {
        id,
        title,
        audioUrl: String(enclosureUrl || ''),
        publishedAt,
        description,
        isNew: false,
      };
    })
      .filter(episode => !_.isEmpty(episode.audioUrl))
      .sort((a, b) => b.publishedAt - a.publishedAt);

    return _.uniqBy(episodes, episode => episode.id);
  }

  private static setSubscriptions(subscriptions: IPodcastSubscription[]) {
    this.persistSubscriptionsToLocalStorage(subscriptions);
    this.persistSubscriptionsToFileStorage(subscriptions);
    window.dispatchEvent(new CustomEvent(this.podcastChangeEventName));
  }

  private static parseSubscriptions(rawValue: string | null | undefined): IPodcastSubscription[] {
    if (!rawValue) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map((item): IPodcastSubscription => ({
        id: String(item.id),
        title: String(item.title || ''),
        publisher: String(item.publisher || ''),
        genre: String(item.genre || ''),
        rating: Number(item.rating || 0),
        imageUrl: String(item.imageUrl || ''),
        feedUrl: String(item.feedUrl || ''),
        source: this.normalizeDirectorySource(item.source),
        hasNewEpisodes: Boolean(item.hasNewEpisodes),
        updatedAt: Number(item.updatedAt || 0),
        episodes: Array.isArray(item.episodes) ? item.episodes.map((episode: any) => ({
          id: String(episode.id || ''),
          title: String(episode.title || ''),
          audioUrl: String(episode.audioUrl || ''),
          publishedAt: Number(episode.publishedAt || 0),
          description: episode.description ? String(episode.description) : undefined,
          isNew: Boolean(episode.isNew),
        })).filter((episode: IPodcastEpisode) => !_.isEmpty(episode.id) && !_.isEmpty(episode.audioUrl)) : [],
      })).filter((subscription: IPodcastSubscription) => !_.isEmpty(subscription.id) && !_.isEmpty(subscription.feedUrl));
    } catch (_error) {
      return [];
    }
  }

  private static resolveEffectiveSubscriptions(
    subscriptionsFromLocalStorage: IPodcastSubscription[],
    subscriptionsFromFileStorage: IPodcastSubscription[],
  ): IPodcastSubscription[] {
    if (subscriptionsFromLocalStorage.length === 0) {
      return subscriptionsFromFileStorage;
    }
    if (subscriptionsFromFileStorage.length === 0) {
      return subscriptionsFromLocalStorage;
    }
    const localTimestamp = this.getSubscriptionsTimestamp(subscriptionsFromLocalStorage);
    const fileTimestamp = this.getSubscriptionsTimestamp(subscriptionsFromFileStorage);
    if (fileTimestamp > localTimestamp) {
      return subscriptionsFromFileStorage;
    }
    return subscriptionsFromLocalStorage;
  }

  private static getSubscriptionsTimestamp(subscriptions: IPodcastSubscription[]): number {
    if (subscriptions.length === 0) {
      return 0;
    }
    return Math.max(...subscriptions.map(subscription => Number(subscription.updatedAt || 0)));
  }

  private static getListenedEpisodesMap(): Record<string, string[]> {
    try {
      const rawData = localStorage.getItem(this.podcastPlaybackSeenStorageKey);
      const parsedData = JSON.parse(String(rawData || '{}'));
      if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
        return {};
      }
      return Object.entries(parsedData).reduce<Record<string, string[]>>((result, [subscriptionId, episodeIds]) => {
        if (!Array.isArray(episodeIds)) {
          return result;
        }
        return {
          ...result,
          [subscriptionId]: episodeIds.map(item => String(item || '')).filter(Boolean),
        };
      }, {});
    } catch (_error) {
      return {};
    }
  }

  private static persistListenedEpisodesMap(listenedEpisodesMap: Record<string, string[]>) {
    localStorage.setItem(this.podcastPlaybackSeenStorageKey, JSON.stringify(listenedEpisodesMap));
  }

  private static getListenedEpisodeIdSet(subscriptionId: string): Set<string> {
    const listenedEpisodesMap = this.getListenedEpisodesMap();
    return new Set(listenedEpisodesMap[subscriptionId] || []);
  }

  private static markEpisodeAsListened(subscriptionId: string, episodeId: string) {
    const listenedEpisodesMap = this.getListenedEpisodesMap();
    const listenedEpisodeIds = new Set(listenedEpisodesMap[subscriptionId] || []);
    listenedEpisodeIds.add(episodeId);
    listenedEpisodesMap[subscriptionId] = Array.from(listenedEpisodeIds);
    this.persistListenedEpisodesMap(listenedEpisodesMap);
  }

  private static persistSubscriptionsToLocalStorage(subscriptions: IPodcastSubscription[]) {
    localStorage.setItem(this.podcastStorageKey, JSON.stringify(subscriptions));
  }

  private static readSubscriptionsFromFileStorage(): IPodcastSubscription[] {
    const storageFilePath = this.getPodcastStorageFilePath();
    if (!storageFilePath) {
      return [];
    }
    try {
      const fileContent = fs.readFileSync(storageFilePath, 'utf8');
      return this.parseSubscriptions(fileContent);
    } catch (_error) {
      return [];
    }
  }

  private static persistSubscriptionsToFileStorage(subscriptions: IPodcastSubscription[]) {
    const storageFilePath = this.getPodcastStorageFilePath();
    if (!storageFilePath) {
      return;
    }
    _.attempt(() => {
      fs.mkdirSync(path.dirname(storageFilePath), { recursive: true });
      fs.writeFileSync(storageFilePath, JSON.stringify(subscriptions, null, 2), 'utf8');
    });
  }

  private static getPodcastStorageFilePath(): string | undefined {
    if (this.podcastStorageFilePath) {
      return this.podcastStorageFilePath;
    }
    const logsPath = String(AppService.details?.logs_path || '').trim();
    if (_.isEmpty(logsPath)) {
      return undefined;
    }
    const appDataRootPath = path.dirname(logsPath);
    this.podcastStorageFilePath = path.join(appDataRootPath, 'State', 'podcasts.subscriptions.json');
    return this.podcastStorageFilePath;
  }

  private static startPlaybackTick() {
    this.stopPlaybackTick();
    this.podcastPlaybackTickInterval = window.setInterval(() => {
      this.dispatchPlaybackUpdate();
    }, 500);
  }

  private static stopPlaybackTick() {
    if (this.podcastPlaybackTickInterval) {
      window.clearInterval(this.podcastPlaybackTickInterval);
    }
    this.podcastPlaybackTickInterval = undefined;
  }

  private static dispatchPlaybackUpdate() {
    window.dispatchEvent(new CustomEvent(this.podcastPlaybackChangeEventName));
  }

  private static sanitizePathPart(value: string): string {
    return String(value || '')
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown';
  }

  private static truncatePathPart(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return value.slice(0, Math.max(10, maxLength)).trim();
  }

  private static getFileExtensionFromUrl(urlValue: string): string {
    let extension = '';
    try {
      extension = path.extname(new URL(urlValue).pathname);
    } catch (_error) {
      extension = path.extname(urlValue);
    }
    if (_.isEmpty(extension)) {
      return '.mp3';
    }
    return extension;
  }

  private static async getFilesRecursive(directoryPath: string): Promise<string[]> {
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return this.getFilesRecursive(fullPath);
      }
      return [fullPath];
    }));
    return nested.flat();
  }
}
