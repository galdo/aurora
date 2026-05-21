import path from 'path';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Modal } from 'react-bootstrap';
import classNames from 'classnames/bind';

import { ModalComponent } from '../../contexts';
import { I18nService, MediaCollectionService, MediaAlbumService } from '../../services';
import { IPCRenderer, IPCCommChannel } from '../../modules/ipc';
import { IMediaAlbum } from '../../interfaces';

import { Button } from '../button/button.component';
import { LoaderCircle } from '../loader/loader-circle.component';

import styles from './media-album-cover-embed-modal.component.css';

const cx = classNames.bind(styles);

/**
 * MediaAlbumCoverEmbedModal — UI for the "Cover aus Ordner einbetten" feature.
 *
 * Workflow
 *   1. On open, the modal asks the main process for a list of every image
 *      file under the album folder (and one level of subfolders so multi-disc
 *      releases work).
 *   2. The user picks one image. If the album folder contains exactly one
 *      candidate, that one is pre-selected automatically — but the user
 *      still confirms explicitly so they always know what's being written
 *      to their FLACs.
 *   3. On confirm, the picked cover is embedded into every track of the
 *      album via metaflac (FLAC) or ffmpeg (MP3/M4A/WAV). Tracks of
 *      unsupported container formats (DSF/DFF) are reported but skipped,
 *      not failed.
 *   4. After a successful embed, we update the album's cover in Aurora's
 *      database too so the UI reflects the new artwork without requiring
 *      a manual library re-sync.
 */

type AlbumImage = {
  path: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  mime: string;
  dataUrl?: string;
};

type EmbedResult = {
  processed: number;
  embedded: number;
  skippedUnsupported: number;
  errors: Array<{ trackPath: string; message: string }>;
  unsupportedTrackPaths: string[];
};

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export const MediaAlbumCoverEmbedModal: ModalComponent<{
  mediaAlbum: IMediaAlbum;
}, {
  embedded?: number;
  errors?: number;
  cancelled?: boolean;
}> = (props) => {
  const { mediaAlbum, onComplete } = props;

  const [isLoadingImages, setIsLoadingImages] = useState(true);
  const [images, setImages] = useState<AlbumImage[]>([]);
  const [selectedImagePath, setSelectedImagePath] = useState<string | null>(null);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [embedResult, setEmbedResult] = useState<EmbedResult | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // The album directory is derived from the parent directory of any track —
  // the Library Sync collapses CD\d+ subdirs into one parent for grouping
  // purposes (see `effectiveFolderForGrouping` in MediaLocalLibraryService),
  // and we reproduce that logic here so the picker scans the same directory
  // hierarchy that produced the album in the first place.
  const albumDirectoryPromiseRef = useRef<Promise<string | null> | null>(null);
  const resolveAlbumDirectory = useCallback(async (): Promise<string | null> => {
    if (albumDirectoryPromiseRef.current) {
      return albumDirectoryPromiseRef.current;
    }

    const promise = (async () => {
      const mediaItem = MediaCollectionService.getMediaItemFromAlbum(mediaAlbum);
      const tracks = await MediaCollectionService.getMediaCollectionTracks(mediaItem);
      const trackWithPath = tracks.find((t) => {
        const fp = (t.extra as any)?.file_path;
        return typeof fp === 'string' && fp.length > 0;
      });
      if (!trackWithPath) return null;

      const filePath = String((trackWithPath.extra as any).file_path);
      const trackDir = path.dirname(filePath);
      // If track sits in a CD\s*\d+ subfolder, use the parent directory as
      // the album root — that's where loose covers usually live.
      const base = path.basename(trackDir);
      if (/^(cd|disc|disk)\s*\d+$/i.test(base)) {
        return path.dirname(trackDir);
      }
      return trackDir;
    })();
    albumDirectoryPromiseRef.current = promise;
    return promise;
  }, [mediaAlbum]);

  // Pre-cache the track list so the eventual embed call is fast — and so we
  // already have the file paths for the embed IPC.
  const trackPathsPromiseRef = useRef<Promise<string[]> | null>(null);
  const resolveTrackPaths = useCallback(async (): Promise<string[]> => {
    if (trackPathsPromiseRef.current) return trackPathsPromiseRef.current;
    const promise = (async () => {
      const mediaItem = MediaCollectionService.getMediaItemFromAlbum(mediaAlbum);
      const tracks = await MediaCollectionService.getMediaCollectionTracks(mediaItem);
      return tracks
        .map(t => String((t.extra as any)?.file_path || ''))
        .filter(Boolean);
    })();
    trackPathsPromiseRef.current = promise;
    return promise;
  }, [mediaAlbum]);

  // Load images on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const albumDir = await resolveAlbumDirectory();
        if (!albumDir) {
          if (!cancelled) {
            setStatusError(I18nService.getString('label_cover_embed_no_directory') || 'Album directory not available');
            setIsLoadingImages(false);
          }
          return;
        }
        const result: AlbumImage[] = await IPCRenderer.sendAsyncMessage(
          IPCCommChannel.DeviceFindAlbumImages,
          { albumDirectory: albumDir, maxDepth: 1 },
        );
        if (cancelled) return;
        setImages(Array.isArray(result) ? result : []);
        // auto-select the first (highest-ranked) image — the user still has
        // to click "Übernehmen" to actually write the file
        if (Array.isArray(result) && result.length > 0) {
          setSelectedImagePath(result[0].path);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusError(`${(err as Error).message || err}`);
        }
      } finally {
        if (!cancelled) setIsLoadingImages(false);
      }
    })();
    return () => { cancelled = true; };
  }, [resolveAlbumDirectory]);

  const selectedImage = useMemo(
    () => images.find(img => img.path === selectedImagePath) || null,
    [images, selectedImagePath],
  );

  const handleEmbed = useCallback(async () => {
    if (!selectedImage || isEmbedding) return;
    setIsEmbedding(true);
    setStatusError(null);
    try {
      const trackPaths = await resolveTrackPaths();
      if (trackPaths.length === 0) {
        setStatusError(I18nService.getString('label_cover_embed_no_tracks') || 'No tracks found for this album');
        setIsEmbedding(false);
        return;
      }
      const result: EmbedResult = await IPCRenderer.sendAsyncMessage(
        IPCCommChannel.DeviceEmbedCoverInTracks,
        {
          coverImagePath: selectedImage.path,
          trackPaths,
        },
      );
      setEmbedResult(result);

      // Mirror the freshly-embedded cover in the album record so the UI
      // updates immediately, without having to wait for the next library
      // sync. We use the file path data type (no buffer) which is exactly
      // what music-metadata produces when it eventually re-reads the file.
      try {
        await MediaAlbumService.updateMediaAlbum({ id: mediaAlbum.id }, {
          album_cover_picture: {
            image_data: selectedImage.path,
            // value mirrors `MediaTrackCoverPictureImageDataType.Path`
            // ('media/track/coverPictureImageDataType/path') used elsewhere.
            image_data_type: 'media/track/coverPictureImageDataType/path' as any,
          },
        });
      } catch (err) {
        // a DB write failure here is non-fatal — the file embed already
        // succeeded; a library re-sync will pick the cover up either way.
        // eslint-disable-next-line no-console
        console.warn('Could not update album cover in DB after embed:', err);
      }
    } catch (err) {
      setStatusError(`${(err as Error).message || err}`);
    } finally {
      setIsEmbedding(false);
    }
  }, [isEmbedding, mediaAlbum.id, resolveTrackPaths, selectedImage]);

  const handleClose = useCallback(() => {
    if (embedResult) {
      onComplete({ embedded: embedResult.embedded, errors: embedResult.errors.length });
    } else {
      onComplete({ cancelled: true });
    }
  }, [embedResult, onComplete]);

  return (
    <>
      <Modal.Header>
        <Modal.Title>
          {I18nService.getString('label_cover_embed_title') || 'Cover aus Ordner einbetten'}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className={cx('cover-embed-modal-body')}>
          {isLoadingImages && (
            <div className={cx('cover-embed-loading')}>
              <LoaderCircle/>
            </div>
          )}

          {!isLoadingImages && images.length === 0 && (
            <div className={cx('cover-embed-empty')}>
              {I18nService.getString('label_cover_embed_empty')
                || 'Im Album-Ordner wurden keine Bilddateien gefunden.'}
            </div>
          )}

          {!isLoadingImages && images.length > 0 && (
            <>
              <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.85 }}>
                {I18nService.getString('label_cover_embed_select_hint', {
                  count: images.length,
                }) || `Wähle eines der ${images.length} gefundenen Bilder aus, das in alle Tracks des Albums geschrieben werden soll.`}
              </div>
              <div className={cx('cover-embed-grid')}>
                {images.map(img => (
                  <button
                    key={img.path}
                    type="button"
                    className={cx('cover-embed-tile', {
                      'cover-embed-tile-selected': img.path === selectedImagePath,
                    })}
                    onClick={() => setSelectedImagePath(img.path)}
                    disabled={isEmbedding}
                  >
                    <div className={cx('cover-embed-thumbnail-wrap')}>
                      {img.dataUrl ? (
                        <img
                          src={img.dataUrl}
                          alt={img.name}
                          className={cx('cover-embed-thumbnail')}
                          loading="lazy"
                        />
                      ) : (
                        <span className={cx('cover-embed-thumbnail-placeholder')}>
                          {img.name}
                        </span>
                      )}
                    </div>
                    <div className={cx('cover-embed-tile-meta')}>
                      <div className={cx('cover-embed-tile-name')} title={img.name}>
                        {img.name}
                      </div>
                      <div className={cx('cover-embed-tile-detail')} title={img.relativePath}>
                        {img.relativePath !== img.name ? img.relativePath : ''}
                      </div>
                      <div className={cx('cover-embed-tile-detail')}>
                        {[img.mime.replace('image/', '').toUpperCase(), formatBytes(img.sizeBytes)]
                          .filter(Boolean)
                          .join(' • ')}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {statusError && (
            <div className={cx('cover-embed-status', 'cover-embed-status-error')}>
              {statusError}
            </div>
          )}

          {embedResult && !statusError && (
            <div className={cx('cover-embed-status', 'cover-embed-status-success')}>
              {I18nService.getString('label_cover_embed_result', {
                embedded: embedResult.embedded,
                processed: embedResult.processed,
                errors: embedResult.errors.length,
                skipped: embedResult.skippedUnsupported,
              }) || `${embedResult.embedded} von ${embedResult.processed} Tracks aktualisiert. ${embedResult.errors.length} Fehler, ${embedResult.skippedUnsupported} übersprungen.`}
            </div>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button
          disabled={isEmbedding}
          onButtonSubmit={handleClose}
        >
          {embedResult
            ? (I18nService.getString('button_dialog_close') || 'Schließen')
            : (I18nService.getString('button_dialog_cancel') || 'Abbrechen')}
        </Button>
        {!embedResult && (
          <Button
            variant="primary"
            disabled={!selectedImage || isEmbedding || isLoadingImages || images.length === 0}
            onButtonSubmit={handleEmbed}
          >
            {isEmbedding
              ? (I18nService.getString('label_cover_embed_in_progress') || 'Wird eingebettet...')
              : (I18nService.getString('label_cover_embed_apply') || 'In Tracks einbetten')}
          </Button>
        )}
      </Modal.Footer>
    </>
  );
};
