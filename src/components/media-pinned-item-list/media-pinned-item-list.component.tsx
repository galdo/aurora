import React, { useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import classNames from 'classnames/bind';
import { isNil } from 'lodash';

import { useModal } from '../../contexts';
import { MediaCollectionItemType } from '../../enums';
import { IMediaPinnedItem } from '../../interfaces';
import {
  I18nService,
  MediaCollectionService,
  MediaPinnedItemService,
  MediaPlaylistService,
} from '../../services';
import { selectSortedPinnedItems } from '../../selectors';

import { List } from '../list/list.component';
import { MediaCollectionItem } from '../media-collection-item/media-collection-item.component';
import { MediaCollectionContextMenu, MediaCollectionContextMenuItem } from '../media-collection-context-menu/media-collection-context-menu.component';
import { MediaPlaylistDeleteModal } from '../media-playlist-delete-modal/media-playlist-delete-modal.component';

import styles from './media-pinned-item-list.component.css';

const cx = classNames.bind(styles);

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

  return (
    <>
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
          return (
            <MediaCollectionItem
              key={localizedPinnedItem.id}
              mediaItem={localizedPinnedItem}
              variant="compact"
              routerLink={MediaCollectionService.getItemRouterLink(localizedPinnedItem)}
              coverPlaceholderIcon={MediaCollectionService.getItemCoverPlaceholderIcon(localizedPinnedItem)}
              subtitle={MediaCollectionService.getItemSubtitle(localizedPinnedItem)}
              contextMenuId={contextMenuId}
            />
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
