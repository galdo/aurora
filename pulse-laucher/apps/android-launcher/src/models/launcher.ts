export type ContentRoute =
  | 'library'
  | 'albums'
  | 'playlists'
  | 'artists'
  | 'podcasts'
  | 'equalizer'
  | 'settings'
  | 'apps';

export interface IMenuEntry {
  key: ContentRoute;
  label: string;
  subtitle: string;
  icon: string;
}

export interface ILauncherListItem {
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  durationMs?: number;
  trackNumber?: number;
  artworkUri?: string;
  mosaicArtworks?: string[];
  sourceUri?: string;
  collectionType?: 'track' | 'album' | 'artist' | 'playlist' | 'podcast' | 'setting' | 'cd-header';
}

export interface ILauncherSection {
  id: string;
  title: string;
  items: ILauncherListItem[];
}

export interface ILauncherPinnedRecord {
  collection_item_id: string;
  collection_item_type: 'track' | 'album' | 'artist' | 'playlist' | 'podcast';
  order: number;
  pinned_at: number;
  title: string;
}
