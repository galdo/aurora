export const COLLECTION_COVER_SIZE_STORAGE_KEY = 'aurora:collection-cover-size';
export const COLLECTION_COVER_SIZE_EVENT = 'aurora:collection-cover-size-changed';
export const COLLECTION_COVER_SIZE_MIN = 100;
export const COLLECTION_COVER_SIZE_MAX = 400;
export const COLLECTION_COVER_SIZE_DEFAULT = 200;

export function clampCollectionCoverSize(size: number): number {
  return Math.min(COLLECTION_COVER_SIZE_MAX, Math.max(COLLECTION_COVER_SIZE_MIN, Math.round(size)));
}

export function getCollectionCoverSize(): number {
  const saved = localStorage.getItem(COLLECTION_COVER_SIZE_STORAGE_KEY);
  const parsed = Number(saved);
  if (!Number.isFinite(parsed)) {
    return COLLECTION_COVER_SIZE_DEFAULT;
  }
  return clampCollectionCoverSize(parsed);
}

export function setCollectionCoverSize(size: number): number {
  const next = clampCollectionCoverSize(size);
  localStorage.setItem(COLLECTION_COVER_SIZE_STORAGE_KEY, String(next));
  window.dispatchEvent(new CustomEvent(COLLECTION_COVER_SIZE_EVENT, {
    detail: {
      coverSize: next,
    },
  }));
  return next;
}
