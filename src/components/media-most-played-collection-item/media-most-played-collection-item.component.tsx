import React from 'react';
import { useSelector } from 'react-redux';

import { Icons, Routes } from '../../constants';
import { RootState } from '../../reducers';
import { I18nService, MediaCollectionService, MediaPlaylistService } from '../../services';
import { StringUtils } from '../../utils';

import { MediaCollectionItem } from '../media-collection-item/media-collection-item.component';
import { MediaCollectionContextMenu, MediaCollectionContextMenuItem } from '../media-collection-context-menu/media-collection-context-menu.component';
import { openPlaylistSideView } from '../media-sideview/media-sideview.store';

export function MediaMostPlayedCollectionItem(props: {
  className?: string;
}) {
  const { className } = props;
  const mediaPlaylists = useSelector((state: RootState) => state.mediaLibrary.mediaPlaylists);
  const mostPlayedPlaylist = mediaPlaylists.find(playlist => playlist.id === MediaPlaylistService.mostPlayedPlaylistId);

  if (!mostPlayedPlaylist) {
    return null;
  }

  const contextMenuId = 'media-most-played-context-menu';
  const mediaItem = MediaCollectionService.getMediaItemFromPlaylist(mostPlayedPlaylist);

  return (
    <>
      <MediaCollectionItem
        key={mostPlayedPlaylist.id}
        mediaItem={mediaItem}
        contextMenuId={contextMenuId}
        routerLink={StringUtils.buildRoute(Routes.LibraryPlaylist, {
          playlistId: mostPlayedPlaylist.id,
        })}
        onClick={() => {
          openPlaylistSideView(mostPlayedPlaylist.id);
        }}
        subtitle={I18nService.getString('label_playlist_subtitle', {
          trackCount: mostPlayedPlaylist.tracks.length,
        })}
        disablePlayback={mostPlayedPlaylist.tracks.length === 0}
        className={className}
        coverPlaceholderIcon={Icons.PlaylistPlaceholder}
      />
      <MediaCollectionContextMenu
        id={contextMenuId}
        menuItems={[
          MediaCollectionContextMenuItem.AddToQueue,
          MediaCollectionContextMenuItem.AddToPlaylist,
          MediaCollectionContextMenuItem.Pin,
        ]}
      />
    </>
  );
}
