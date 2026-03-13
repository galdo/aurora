import React from 'react';
import classNames from 'classnames/bind';

import { Icons, Routes } from '../../constants';
import { IMediaArtist } from '../../interfaces';
import { StringUtils } from '../../utils';

import {
  MediaCollectionContextMenu,
  MediaCollectionContextMenuItem,
} from '../media-collection-context-menu/media-collection-context-menu.component';

import { MediaCollectionTile } from '../media-collection-tile/media-collection-tile.component';

import styles from './media-artists.component.css';
import { MediaCollectionService } from '../../services';

const cx = classNames.bind(styles);

export function MediaArtists(props: {
  mediaArtists: IMediaArtist[],
  coverSize?: number,
}) {
  const { mediaArtists, coverSize } = props;
  const mediaContextMenuId = 'media_artists_context_menu';
  const containerStyle = coverSize ? {
    '--album-cover-size': `${coverSize}px`,
  } as React.CSSProperties : undefined;

  return (
    <div>
      <div className={cx('media-artists')} style={containerStyle}>
        {mediaArtists.map((mediaArtist) => {
          const mediaItem = MediaCollectionService.getMediaItemFromArtist(mediaArtist);

          return (
            <div key={mediaArtist.id}>
              <MediaCollectionTile
                mediaItem={mediaItem}
                routerLink={StringUtils.buildRoute(Routes.LibraryArtist, {
                  artistId: mediaArtist.id,
                })}
                contextMenuId={mediaContextMenuId}
                coverPlaceholderIcon={Icons.ArtistPlaceholder}
              />
            </div>
          );
        })}
      </div>
      <MediaCollectionContextMenu
        id={mediaContextMenuId}
        menuItems={[
          MediaCollectionContextMenuItem.AddToQueue,
          MediaCollectionContextMenuItem.AddToPlaylist,
        ]}
      />
    </div>
  );
}
