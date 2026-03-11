import React, { useEffect, useState } from 'react';
import classNames from 'classnames/bind';

import {
  MediaHeaderNavigationLink,
  RouterSwitchComponent,
} from '../../components';
import { Routes } from '../../constants';
import { MediaPlaylistService } from '../../services';

import styles from './library.component.css';
import routes from './library.routes';

const cx = classNames.bind(styles);

export function LibraryPage() {
  return (
    <div className={cx('library-content-browser-container')}>
      <RouterSwitchComponent routes={routes}/>
    </div>
  );
}

export function LibraryHeader() {
  const [hideArtist, setHideArtist] = useState(false);

  useEffect(() => {
    const checkSettings = () => {
      const saved = localStorage.getItem('aurora:ui-settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setHideArtist(!!parsed.hideArtist);
        } catch (e) {
          // ignore
        }
      } else {
        setHideArtist(false);
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
          if (hideArtist && route.path === Routes.LibraryArtists) return null;

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
