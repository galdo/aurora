import React, { useEffect, useState } from 'react';
import classNames from 'classnames/bind';

import {
  MediaHeaderNavigationLink,
  RouterSwitchComponent,
} from '../../components';
import { Routes } from '../../constants';
import { I18nService, MediaPlaylistService } from '../../services';

import styles from './library.component.css';
import routes from './library.routes';

const cx = classNames.bind(styles);

export function LibraryPage() {
  return (
    <div className={cx('library-content-browser-container')}>
      <div className={cx('library-page-title')}>
        {I18nService.getString('link_library')}
      </div>
      <RouterSwitchComponent routes={routes}/>
    </div>
  );
}

export function LibraryHeader() {
  const [artistViewMode, setArtistViewMode] = useState<'off' | 'artists' | 'album_artists'>('artists');

  useEffect(() => {
    const checkSettings = () => {
      const saved = localStorage.getItem('aurora:ui-settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const parsedMode = String(parsed.artistViewMode || '').trim();
          if (parsedMode === 'off' || parsedMode === 'artists' || parsedMode === 'album_artists') {
            setArtistViewMode(parsedMode);
          } else {
            setArtistViewMode(parsed.hideArtist ? 'off' : 'artists');
          }
        } catch (e) {
          // ignore
        }
      } else {
        setArtistViewMode('artists');
      }
    };

    checkSettings();
    window.addEventListener('aurora:settings-changed', checkSettings);
    return () => window.removeEventListener('aurora:settings-changed', checkSettings);
  }, []);

  useEffect(() => {
    MediaPlaylistService.loadMediaPlaylists();
  }, []);

  return (
    <div className={cx('library-header')}>
      <div className={cx('library-header-navigation-list')}>
        {routes.map((route) => {
          if (!route.tHeaderName) return null;
          if (artistViewMode === 'off' && route.path === Routes.LibraryArtists) return null;

          return (
            <MediaHeaderNavigationLink
              key={route.path}
              tName={route.tHeaderName}
              path={route.path}
            />
          );
        })}
      </div>
    </div>
  );
}
