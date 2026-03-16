import React from 'react';
import classNames from 'classnames/bind';

import { Icons, Routes } from '../../constants';
import { IMediaPlaylist } from '../../interfaces';
import { I18nService, MediaCollectionService } from '../../services';
import { StringUtils } from '../../utils';

import { MediaCollectionTile } from '../media-collection-tile/media-collection-tile.component';
import { openPlaylistSideView } from '../media-sideview/media-sideview.store';

import {
  MediaCollectionContextMenu,
  MediaCollectionContextMenuItem,
} from '../media-collection-context-menu/media-collection-context-menu.component';

import styles from './media-playlists.component.css';

const cx = classNames.bind(styles);

export function MediaPlaylists(props: {
  mediaPlaylists: IMediaPlaylist[],
  coverSize?: number,
}) {
  const { mediaPlaylists, coverSize } = props;
  const mediaContextMenuId = 'media_playlists_context_menu';
  const containerStyle = coverSize ? {
    '--album-cover-size': `${coverSize}px`,
  } as React.CSSProperties : undefined;

  return (
    <>
      <div className={cx('media-playlists')} style={containerStyle}>
        {mediaPlaylists.map((mediaPlaylist) => {
          const mediaItem = MediaCollectionService.getMediaItemFromPlaylist(mediaPlaylist);

          return (
            <div key={mediaPlaylist.id}>
              <MediaCollectionTile
                mediaItem={mediaItem}
                contextMenuId={mediaContextMenuId}
                routerLink={StringUtils.buildRoute(Routes.LibraryPlaylist, {
                  playlistId: mediaPlaylist.id,
                })}
                subtitle={I18nService.getString('label_playlist_subtitle', {
                  trackCount: mediaPlaylist.tracks.length.toString(),
                })}
                onClick={() => openPlaylistSideView(mediaPlaylist.id)}
                coverPlaceholderIcon={Icons.PlaylistPlaceholder}
              />
            </div>
          );
        })}
      </div>
      <MediaCollectionContextMenu
        id={mediaContextMenuId}
        menuItems={[
          MediaCollectionContextMenuItem.Pin,
          MediaCollectionContextMenuItem.AddToQueue,
          MediaCollectionContextMenuItem.ManagePlaylist,
          MediaCollectionContextMenuItem.ToggleHidden,
        ]}
      />
    </>
  );
}
