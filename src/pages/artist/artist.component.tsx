import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { isEmpty } from 'lodash';
import _ from 'lodash';
import classNames from 'classnames/bind';

import { I18nService, MediaAlbumService, MediaArtistService, MediaCollectionService } from '../../services';
import { CollectionViewControls, MediaAlbums, MediaCollectionActions, MediaCoverPicture, TextClamp } from '../../components';
import { COLLECTION_COVER_SIZE_DEFAULT, COLLECTION_COVER_SIZE_EVENT, getCollectionCoverSize, setCollectionCoverSize, clampCollectionCoverSize } from '../../utils/collection-cover-size.utils';
import { Icons, Layout } from '../../constants';
import { RootState } from '../../reducers';
import { IMediaAlbum } from '../../interfaces';
import styles from './artist.component.css';

const cx = classNames.bind(styles);
type SortOption = 'album' | 'year' | 'genre' | 'added';
type SortDirection = 'asc' | 'desc';
interface IArtistViewSettings { sortBy: SortOption; sortDirection: SortDirection; coverSize: number; }
const SETTINGS_KEY = 'aurora:artist-view-settings';
const DEFAULT_SETTINGS: IArtistViewSettings = { sortBy: 'year', sortDirection: 'asc', coverSize: COLLECTION_COVER_SIZE_DEFAULT };

export function ArtistPage() {
  const { artistId } = useParams() as { artistId: string };
  const mediaSelectedArtist = useSelector((state: RootState) => state.mediaLibrary.mediaSelectedArtist);
  const mediaSelectedArtistAlbums = useSelector((state: RootState) => state.mediaLibrary.mediaSelectedArtistAlbums);
  const [settings, setSettings] = useState<IArtistViewSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    MediaAlbumService.loadMediaArtistAlbums(artistId);
    const saved = localStorage.getItem(SETTINGS_KEY);
    const sharedCoverSize = getCollectionCoverSize();
    if (saved) {
      try { setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved), coverSize: sharedCoverSize }); }
      catch (e) { setSettings(prev => ({ ...prev, coverSize: sharedCoverSize })); }
    } else { setSettings(prev => ({ ...prev, coverSize: sharedCoverSize })); }
    return () => MediaArtistService.unloadMediaArtist();
  }, [artistId]);

  useEffect(() => {
    const handleCoverSizeChange = (event: Event) => {
      const nextSize = clampCollectionCoverSize(Number((event as CustomEvent).detail?.coverSize || COLLECTION_COVER_SIZE_DEFAULT));
      setSettings(prev => ({ ...prev, coverSize: nextSize }));
    };
    window.addEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
    return () => window.removeEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
  }, []);

  const updateSettings = (partial: Partial<IArtistViewSettings>) => {
    const newSettings = { ...settings, ...partial } as IArtistViewSettings;
    if (partial.sortBy === 'added' && _.isNil(partial.sortDirection)) newSettings.sortDirection = 'desc';
    if (!_.isNil(partial.coverSize)) newSettings.coverSize = setCollectionCoverSize(partial.coverSize);
    setSettings(newSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sortBy: newSettings.sortBy, sortDirection: newSettings.sortDirection }));
  };

  const sortedAlbums = useMemo(() => {
    if (!mediaSelectedArtistAlbums || isEmpty(mediaSelectedArtistAlbums)) return [];
    let iteratee: any;
    switch (settings.sortBy) {
      case 'album': iteratee = (a: IMediaAlbum) => (a.album_name || '').toLowerCase(); break;
      case 'year': iteratee = 'album_year'; break;
      case 'genre': iteratee = (album: IMediaAlbum) => String(album.album_genre || '').toLowerCase(); break;
      case 'added': iteratee = (album: IMediaAlbum) => Number((album.extra as any)?.added_at || album.sync_timestamp || 0); break;
      default: iteratee = 'album_year';
    }
    return _.orderBy(mediaSelectedArtistAlbums, [iteratee], [settings.sortDirection]) as IMediaAlbum[];
  }, [mediaSelectedArtistAlbums, settings.sortBy, settings.sortDirection]);

  if (!mediaSelectedArtist || !mediaSelectedArtistAlbums || isEmpty(mediaSelectedArtistAlbums)) return (<></>);

  return (
    <div className="container-fluid">
      <div className={cx('artist-header')}>
        <div className="row">
          <div className={cx(Layout.Grid.CollectionHeaderCoverColumn, 'artist-header-cover-column')}>
            <MediaCoverPicture mediaPicture={mediaSelectedArtist.artist_feature_picture} mediaPictureAltText={mediaSelectedArtist.artist_name} mediaCoverPlaceholderIcon={Icons.ArtistPlaceholder} isLoading={!mediaSelectedArtist.artist_feature_picture && !!(mediaSelectedArtist.extra as any)?.artist_feature_picture_loading} className={cx('artist-cover-picture')}/>
          </div>
          <div className={cx(Layout.Grid.CollectionHeaderInfoColumn, 'artist-header-info-column')}>
            <div className={cx('artist-header-label')}>{I18nService.getString('label_artist_header')}</div>
            <div className={cx('artist-header-name')}><TextClamp>{mediaSelectedArtist.artist_name}</TextClamp></div>
            <div className={cx('artist-header-info')}/>
          </div>
        </div>
      </div>
      <div className={cx('artist-actions')}>
        <MediaCollectionActions mediaItem={MediaCollectionService.getMediaItemFromArtist(mediaSelectedArtist)}/>
      </div>
      <CollectionViewControls coverSize={settings.coverSize} onCoverSizeChange={v => updateSettings({ coverSize: v })} sortBy={settings.sortBy} sortDirection={settings.sortDirection} onSortByChange={v => updateSettings({ sortBy: v as SortOption })} onSortDirectionToggle={() => updateSettings({ sortDirection: settings.sortDirection === 'asc' ? 'desc' : 'asc' })} sortToggleTooltip={I18nService.getString('tooltip_album_sort_toggle')} sortOptions={[{ value: 'year', label: I18nService.getString('label_album_sort_year') }, { value: 'album', label: I18nService.getString('label_album_sort_album') }, { value: 'genre', label: I18nService.getString('label_genre') }, { value: 'added', label: I18nService.getString('label_album_sort_added') }]}/>
      <div className={cx('artist-albums')}>
        <MediaAlbums mediaAlbums={sortedAlbums} coverSize={settings.coverSize}/>
      </div>
    </div>
  );
}