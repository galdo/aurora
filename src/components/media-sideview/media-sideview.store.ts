export type MediaSideViewState =
  | { type: 'none' }
  | { type: 'album', albumId: string }
  | { type: 'playlist', playlistId: string }
  | { type: 'podcast', podcastId: string };

let state: MediaSideViewState = { type: 'none' };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

export function subscribeMediaSideView(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMediaSideViewState() {
  return state;
}

export function openAlbumSideView(albumId: string) {
  state = { type: 'album', albumId };
  emit();
}

export function openPlaylistSideView(playlistId: string) {
  state = { type: 'playlist', playlistId };
  emit();
}

export function openPodcastSideView(podcastId: string) {
  state = { type: 'podcast', podcastId };
  emit();
}

export function closeMediaSideView() {
  state = { type: 'none' };
  emit();
}
