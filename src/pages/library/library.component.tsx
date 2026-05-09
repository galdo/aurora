import React, { useEffect } from 'react';
import classNames from 'classnames/bind';

import {
  RouterSwitchComponent,
} from '../../components';
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

/**
 * LibraryHeader is no longer needed — navigation segments are now
 * handled by the TopMenuBar component in the Browser header.
 */
export function LibraryHeader() {
  useEffect(() => {
    MediaPlaylistService.loadMediaPlaylists();
  }, []);

  // Segments are now rendered by TopMenuBar — no inline header needed
  return null;
}
