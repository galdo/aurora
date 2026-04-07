import React, { useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';
import { isNil } from 'lodash';

import { useContextMenu, useModal } from '../../contexts';
import { MediaCollectionItemType } from '../../enums';
import { IMediaCollectionItem, IMediaPinnedItem } from '../../interfaces';
import {
  I18nService,
  MediaCollectionService,
  MediaPinnedItemService,
  MediaPlaylistService,
} from '../../services';
import { selectSortedPinnedItems } from '../../selectors';

import { List } from '../list/list.component';
import { Icon } from '../icon/icon.component';
import { RouterLink } from '../router-link/router-link.component';
import { MediaCollectionContextMenu, MediaCollectionContextMenuItem } from '../media-collection-context-menu/media-collection-context-menu.component';
import { MediaPlaylistDeleteModal } from '../media-playlist-delete-modal/media-playlist-delete-modal.component';
import { openLikedTracksSideView, openPlaylistSideView } from '../media-sideview/media-sideview.store';

import styles from './media-pinned-item-list.component.css';

const cx = classNames.bind(styles);
const likedTracksLegacyPlaylistIds = new Set([
  'liked-tracks',
  'auto-playlist-liked-tracks',
]);

const getLocalizedPinnedItem = (pinnedItem: IMediaPinnedItem): IMediaPinnedItem => {
  if (pinnedItem.type === MediaCollectionItemType.LikedTracks) {
    return {
      ...pinnedItem,
      name: I18nService.getString('label_liked_tracks_collection_name'),
    };
  }

  if (pinnedItem.type === MediaCollectionItemType.Playlist && pinnedItem.id === MediaPlaylistService.mostPlayedPlaylistId) {
    return {
      ...pinnedItem,
      name: I18nService.getString('label_playlist_most_played'),
    };
  }

  return pinnedItem;
};

export function MediaPinnedItemList() {
  const sortedMediaPinnedItems = useSelector(selectSortedPinnedItems);
  const hasPinnedPlaylists = sortedMediaPinnedItems.some(pinnedItem => pinnedItem.type === MediaCollectionItemType.Playlist);
  const { showMenu } = useContextMenu<{ mediaItem?: IMediaCollectionItem }>();
  const { showModal } = useModal();
  const contextMenuId = 'media-pinned-item-list-context-menu';

  useEffect(() => {
    MediaPinnedItemService.loadPinnedItems();
  }, []);

  const handleItemsSorted = useCallback(async (items: IMediaPinnedItem[]) => {
    await MediaPinnedItemService.updatePinnedItemsOrder(items.map(item => item.pinned_item_id));
  }, []);

  const handleItemsDelete = useCallback((ids: string[]) => new Promise<boolean>((resolve) => {
    const pinnedItemId = ids[0];
    const pinnedItem = sortedMediaPinnedItems.find(item => item.pinned_item_id === pinnedItemId);

    if (pinnedItem && pinnedItem.type === MediaCollectionItemType.Playlist) {
      showModal(MediaPlaylistDeleteModal, {
        mediaPlaylistId: pinnedItem.id,
      }, {
        onComplete: (result) => {
          resolve(!isNil(result?.deletedId));
          MediaPinnedItemService.loadPinnedItems(); // TODO: Remove this, items should be automatically removed on collection item removal
        },
      });
    } else {
      resolve(false);
    }
  }), [
    showModal,
    sortedMediaPinnedItems,
  ]);

  const handleItemContextMenu = useCallback((event: React.MouseEvent, mediaItem: IMediaCollectionItem) => {
    showMenu({
      id: contextMenuId,
      event,
      props: {
        mediaItem,
      },
    });
  }, [contextMenuId, showMenu]);

  return (
    <>
      {hasPinnedPlaylists && (
        <div className={cx('media-pinned-item-list-section-title')}>
          Playlists
        </div>
      )}
      <List
        disableMultiSelect
        sortable
        className={cx('media-pinned-item-list')}
        items={sortedMediaPinnedItems}
        getItemId={item => item.pinned_item_id}
        onItemsSorted={handleItemsSorted}
        onItemsDelete={handleItemsDelete}
      >
        {(pinnedItem) => {
          const localizedPinnedItem = getLocalizedPinnedItem(pinnedItem);
          const pinnedItemRouterLink = MediaCollectionService.getItemRouterLink(localizedPinnedItem);
          const pinnedItemIcon = MediaCollectionService.getItemCoverPlaceholderIcon(localizedPinnedItem);
          const opensLikedTracksSideView = localizedPinnedItem.type === MediaCollectionItemType.LikedTracks
            || (localizedPinnedItem.type === MediaCollectionItemType.Playlist
              && likedTracksLegacyPlaylistIds.has(localizedPinnedItem.id));
          return (
            <RouterLink
              key={localizedPinnedItem.id}
              to={pinnedItemRouterLink}
              exact
              activeClassName={cx('media-pinned-item-link-active')}
              className={cx('media-pinned-item-link', 'app-nav-link')}
              onClick={(event) => {
                if (opensLikedTracksSideView) {
                  event.preventDefault();
                  openLikedTracksSideView();
                  return;
                }
                if (localizedPinnedItem.type === MediaCollectionItemType.Playlist) {
                  event.preventDefault();
                  openPlaylistSideView(localizedPinnedItem.id);
                }
              }}
              onContextMenu={event => handleItemContextMenu(event, localizedPinnedItem)}
            >
              <span className={cx('media-pinned-item-icon')}>
                <Icon name={pinnedItemIcon}/>
              </span>
              <span className={cx('media-pinned-item-label')}>
                {localizedPinnedItem.name}
              </span>
            </RouterLink>
          );
        }}
      </List>
      <MediaCollectionContextMenu
        id={contextMenuId}
        menuItems={[
          MediaCollectionContextMenuItem.Pin,
          MediaCollectionContextMenuItem.AddToQueue,
          MediaCollectionContextMenuItem.AddToPlaylist,
        ]}
      />
    </>
  );
}
