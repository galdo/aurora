import path from 'path';
import React, { useCallback, useEffect } from 'react';

import {
  Menu,
  Separator as MenuSeparator,
  Item,
  Submenu,
  ItemParams,
} from 'react-contexify';

import { useContextMenu, useModal } from '../../contexts';
import { useMediaCollectionPin, useScrollLock } from '../../hooks';
import { IMediaCollectionItem } from '../../interfaces';
import {
  I18nService,
  MediaAlbumService,
  MediaCollectionService,
  MediaPlayerService,
  MediaPlaylistService,
} from '../../services';
import { MediaCollectionItemType } from '../../enums';
import { IPCRenderer, IPCCommChannel } from '../../modules/ipc';

import { MediaPlaylistContextMenu } from '../media-playlist-context-menu/media-playlist-context-menu.component';
import { MediaAlbumCoverEmbedModal } from '../media-album-cover-embed-modal/media-album-cover-embed-modal.component';

export enum MediaCollectionContextMenuItem {
  AddToQueue,
  AddToPlaylist,
  Separator,
  ManagePlaylist,
  Pin,
  ToggleHidden,
  OpenInFileManager,
  EmbedCoverFromFolder,
}

export enum MediaCollectionContextMenuItemAction {
  AddToQueue = 'media/collection/action/addToQueue',
  Pin = 'media/collection/action/pin',
  ToggleHidden = 'media/collection/action/toggleHidden',
  OpenInFileManager = 'media/collection/action/openInFileManager',
  EmbedCoverFromFolder = 'media/collection/action/embedCoverFromFolder',
}

export interface MediaCollectionContextMenuItemProps {
  mediaItem?: IMediaCollectionItem;
}

export function MediaCollectionContextMenu(props: {
  id: string,
  menuItems: MediaCollectionContextMenuItem[],
}) {
  const { id, menuItems } = props;
  const { menuProps, hideAll } = useContextMenu<MediaCollectionContextMenuItemProps>();
  const { showModal } = useModal();
  const { mediaItem } = menuProps || {};
  const { triggerScrollLock } = useScrollLock({
    scrollableSelector: '.app-scrollable',
    blockableSelector: '.contexify.contexify_willEnter-fade',
  });

  const {
    isPinned,
    isPinnedStatusLoading,
    togglePinned,
  } = useMediaCollectionPin({
    mediaItem,
  });

  const handleMenuItemClick = useCallback(async (itemParams: ItemParams<MediaCollectionContextMenuItemProps>) => {
    const itemAction: MediaCollectionContextMenuItemAction = itemParams.id as MediaCollectionContextMenuItemAction;
    hideAll();

    switch (itemAction) {
      case MediaCollectionContextMenuItemAction.AddToQueue: {
        if (!mediaItem) {
          throw new Error('MediaCollectionContextMenu encountered error while performing action AddToQueue - No media item was provided');
        }

        MediaCollectionService
          .getMediaCollectionTracks(mediaItem)
          .then((mediaTracks) => {
            MediaPlayerService.addMediaTracksToQueue(mediaTracks);
          });
        break;
      }
      case MediaCollectionContextMenuItemAction.Pin: {
        if (!mediaItem) {
          throw new Error('MediaCollectionContextMenu encountered error while performing action Pin - No media item was provided');
        }

        await togglePinned();
        break;
      }
      case MediaCollectionContextMenuItemAction.ToggleHidden: {
        if (!mediaItem) {
          throw new Error('MediaCollectionContextMenu encountered error while performing action ToggleHidden - No media item was provided');
        }

        if (mediaItem.type === MediaCollectionItemType.Album) {
          await MediaAlbumService.updateMediaAlbum({
            id: mediaItem.id,
          }, {
            hidden: !mediaItem.hidden,
          });
          MediaAlbumService.loadMediaAlbums();
          MediaPlaylistService.loadMediaPlaylists();
        } else if (mediaItem.type === MediaCollectionItemType.Playlist && mediaItem.hidden) {
          await MediaAlbumService.updateMediaAlbum({
            id: mediaItem.id,
          }, {
            hidden: false,
          });
          MediaAlbumService.loadMediaAlbums();
          MediaPlaylistService.loadMediaPlaylists();
        }
        break;
      }
      case MediaCollectionContextMenuItemAction.OpenInFileManager: {
        if (!mediaItem) {
          throw new Error('MediaCollectionContextMenu encountered error while performing action OpenInFileManager - No media item was provided');
        }

        try {
          // determine a representative filesystem path for this collection by
          // inspecting any of its tracks - tracks store their on-disk location
          // in `extra.file_path`. The album's folder is simply the parent
          // directory of any of its tracks.
          const mediaTracks = await MediaCollectionService.getMediaCollectionTracks(mediaItem);
          const trackWithPath = mediaTracks.find((mediaTrack) => {
            const filePath = (mediaTrack.extra as any)?.file_path;
            return typeof filePath === 'string' && filePath.length > 0;
          });

          const filePath = trackWithPath ? String((trackWithPath.extra as any)?.file_path || '') : '';
          if (!filePath) {
            console.warn('MediaCollectionContextMenu - OpenInFileManager - no track file path available for collection');
            break;
          }

          // resolve the album folder (parent directory of the track)
          const albumFolderPath = path.dirname(filePath);
          IPCRenderer.sendSyncMessage(IPCCommChannel.FSShowItemInFolder, albumFolderPath);
        } catch (err) {
          console.error('MediaCollectionContextMenu - OpenInFileManager error:', err);
        }
        break;
      }
      case MediaCollectionContextMenuItemAction.EmbedCoverFromFolder: {
        if (!mediaItem || mediaItem.type !== MediaCollectionItemType.Album) {
          break;
        }
        // The modal needs the full IMediaAlbum (with album_artist relation
        // hydrated). We re-resolve via the service rather than relying on
        // the (potentially stale) cached version inside the menu props.
        try {
          const album = await MediaAlbumService.getMediaAlbum(mediaItem.id);
          if (!album) {
            console.warn('MediaCollectionContextMenu - EmbedCoverFromFolder - album not found:', mediaItem.id);
            break;
          }
          showModal(MediaAlbumCoverEmbedModal, { mediaAlbum: album }, {
            // Refresh the album list once the user closes the modal so the
            // newly-attached cover (which we already wrote into the album
            // record) is reflected in every album-tile that shows it.
            onComplete: () => {
              MediaAlbumService.loadMediaAlbums();
            },
          });
        } catch (err) {
          console.error('MediaCollectionContextMenu - EmbedCoverFromFolder error:', err);
        }
        break;
      }
      default:
      // unsupported action, do nothing
    }
  }, [
    hideAll,
    mediaItem,
    showModal,
    togglePinned,
  ]);

  useEffect(() => () => {
    triggerScrollLock();
  }, [
    triggerScrollLock,
  ]);

  return (
    <Menu id={id} onVisibilityChange={triggerScrollLock}>
      {menuItems.map((menuItem, menuItemPointer) => {
        const rowKey = `mc-menu-${menuItem}-${menuItemPointer}`;
        switch (menuItem) {
          case MediaCollectionContextMenuItem.Pin:
            return (
              <Item
                key={rowKey}
                id={MediaCollectionContextMenuItemAction.Pin}
                onClick={handleMenuItemClick}
                disabled={isPinnedStatusLoading}
              >
                {I18nService.getString(isPinned ? 'label_submenu_media_collection_unpin' : 'label_submenu_media_collection_pin', {
                  collectionType: mediaItem ? MediaCollectionService.getItemSubtitle(mediaItem) : '',
                })}
              </Item>
            );
          case MediaCollectionContextMenuItem.AddToQueue:
            return (
              <Item
                key={MediaCollectionContextMenuItem.AddToQueue}
                id={MediaCollectionContextMenuItemAction.AddToQueue}
                onClick={handleMenuItemClick}
              >
                {I18nService.getString('label_submenu_media_collection_add_to_queue')}
              </Item>
            );
          case MediaCollectionContextMenuItem.AddToPlaylist:
            return (
              <Submenu
                key={rowKey}
                label={I18nService.getString('label_submenu_media_collection_add_to_playlist')}
              >
                <MediaPlaylistContextMenu
                  type="add"
                />
              </Submenu>
            );
          case MediaCollectionContextMenuItem.ManagePlaylist:
            return (
              <MediaPlaylistContextMenu
                key={rowKey}
                type="manage"
              />
            );
          case MediaCollectionContextMenuItem.Separator: {
            return (
              // eslint-disable-next-line react/no-array-index-key
              <MenuSeparator key={`${MediaCollectionContextMenuItem.Separator}-${menuItemPointer}`}/>
            );
          }
          case MediaCollectionContextMenuItem.ToggleHidden:
            if (mediaItem?.type === MediaCollectionItemType.Album) {
              return (
                <Item
                  key={rowKey}
                  id={MediaCollectionContextMenuItemAction.ToggleHidden}
                  onClick={handleMenuItemClick}
                >
                  {I18nService.getString(mediaItem.hidden ? 'label_submenu_media_collection_show' : 'label_submenu_media_collection_hide')}
                </Item>
              );
            }

            if (mediaItem?.type === MediaCollectionItemType.Playlist && mediaItem.hidden) {
              return (
                <Item
                  key={rowKey}
                  id={MediaCollectionContextMenuItemAction.ToggleHidden}
                  onClick={handleMenuItemClick}
                >
                  {I18nService.getString('label_submenu_media_collection_show')}
                </Item>
              );
            }

            return null;
          case MediaCollectionContextMenuItem.OpenInFileManager:
            // only show for albums - playlists / audio cd entries don't have
            // a single owning folder on disk that can be sensibly revealed
            if (mediaItem?.type !== MediaCollectionItemType.Album) {
              return null;
            }

            return (
              <Item
                key={rowKey}
                id={MediaCollectionContextMenuItemAction.OpenInFileManager}
                onClick={handleMenuItemClick}
              >
                {I18nService.getString('label_submenu_media_collection_open_in_file_manager')}
              </Item>
            );
          case MediaCollectionContextMenuItem.EmbedCoverFromFolder:
            // only meaningful for albums — playlists span multiple folders
            // and don't have a single source directory we could scan
            if (mediaItem?.type !== MediaCollectionItemType.Album) {
              return null;
            }

            return (
              <Item
                key={rowKey}
                id={MediaCollectionContextMenuItemAction.EmbedCoverFromFolder}
                onClick={handleMenuItemClick}
              >
                {I18nService.getString('label_submenu_media_collection_embed_cover_from_folder')}
              </Item>
            );
          default:
            return null;
        }
      })}
    </Menu>
  );
}
