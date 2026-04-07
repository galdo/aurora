import React, { useEffect, useMemo, useState } from 'react';
import classNames from 'classnames/bind';
import { useSelector } from 'react-redux';

import { Icons } from '../../constants';
import { Button } from '../../components';
import { Icon } from '../../components/icon/icon.component';
import { MediaTrackDatastore } from '../../datastores';
import { IMediaTrack } from '../../interfaces';
import { RootState } from '../../reducers';
import { I18nService, MediaPlayerService, MediaTrackService } from '../../services';

import styles from './tracks.component.css';

const cx = classNames.bind(styles);

type TrackColumnKey = 'cover' | 'title' | 'artist' | 'album' | 'year' | 'genre' | 'plays';
type SortDirection = 'asc' | 'desc';
type SortValue = string | number;

type TrackRow = {
  id: string;
  track: IMediaTrack;
  coverPath: string;
  title: string;
  artist: string;
  album: string;
  year: number;
  genre: string;
  plays: number;
};

const SETTINGS_KEY = 'aurora:tracks-table-settings';
const TOP_BAR_SEARCH_STATE_KEY = 'aurora:topbar-search-query';
const TOP_BAR_SEARCH_CHANGE_EVENT = 'aurora:topbar-search-changed';

const ALL_COLUMNS: Array<{ key: TrackColumnKey; label: string; sortable: boolean }> = [
  { key: 'cover', label: 'Album-Cover', sortable: false },
  { key: 'title', label: 'Titel', sortable: true },
  { key: 'artist', label: I18nService.getString('label_artist_header'), sortable: true },
  { key: 'album', label: I18nService.getString('label_album_header'), sortable: true },
  { key: 'year', label: I18nService.getString('label_album_sort_year'), sortable: true },
  { key: 'genre', label: I18nService.getString('label_genre'), sortable: true },
  { key: 'plays', label: 'Anzahl abgespielt', sortable: true },
];

const DEFAULT_VISIBLE_COLUMNS: Record<TrackColumnKey, boolean> = {
  cover: true,
  title: true,
  artist: true,
  album: true,
  year: true,
  genre: true,
  plays: true,
};

function normalizePicturePath(value?: string): string {
  return String(value || '').trim();
}

function getTrackCoverPath(track: IMediaTrack): string {
  return normalizePicturePath(track.track_cover_picture?.image_data)
    || normalizePicturePath(track.track_album?.album_cover_picture?.image_data)
    || '';
}

function getSortableValue(row: TrackRow, sortBy: TrackColumnKey): SortValue {
  switch (sortBy) {
    case 'title':
      return row.title.toLowerCase();
    case 'artist':
      return row.artist.toLowerCase();
    case 'album':
      return row.album.toLowerCase();
    case 'year':
      return row.year;
    case 'genre':
      return row.genre.toLowerCase();
    case 'plays':
      return row.plays;
    default:
      return row.title.toLowerCase();
  }
}

export function TracksPage() {
  const currentTrackId = useSelector((state: RootState) => state.mediaPlayer.mediaPlaybackCurrentMediaTrack?.id);
  const [isLoading, setIsLoading] = useState(true);
  const [rows, setRows] = useState<TrackRow[]>([]);
  const [sortBy, setSortBy] = useState<TrackColumnKey>('title');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [visibleColumns, setVisibleColumns] = useState<Record<TrackColumnKey, boolean>>(DEFAULT_VISIBLE_COLUMNS);
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [topBarSearchQuery, setTopBarSearchQuery] = useState(() => localStorage.getItem(TOP_BAR_SEARCH_STATE_KEY) || '');

  useEffect(() => {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) {
      return;
    }
    try {
      const parsed = JSON.parse(saved);
      if (parsed.sortBy && ['title', 'artist', 'album', 'year', 'genre', 'plays'].includes(parsed.sortBy)) {
        setSortBy(parsed.sortBy);
      }
      if (parsed.sortDirection === 'asc' || parsed.sortDirection === 'desc') {
        setSortDirection(parsed.sortDirection);
      }
      if (parsed.visibleColumns && typeof parsed.visibleColumns === 'object') {
        setVisibleColumns({
          ...DEFAULT_VISIBLE_COLUMNS,
          ...parsed.visibleColumns,
        });
      }
    } catch (_error) {
      localStorage.removeItem(SETTINGS_KEY);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sortBy,
      sortDirection,
      visibleColumns,
    }));
  }, [sortBy, sortDirection, visibleColumns]);

  useEffect(() => {
    const handleTopBarSearchChange = (event: Event) => {
      const searchEvent = event as CustomEvent<{ query?: string }>;
      setTopBarSearchQuery(String(searchEvent.detail?.query || ''));
    };
    window.addEventListener(TOP_BAR_SEARCH_CHANGE_EVENT, handleTopBarSearchChange as EventListener);
    return () => window.removeEventListener(TOP_BAR_SEARCH_CHANGE_EVENT, handleTopBarSearchChange as EventListener);
  }, []);

  useEffect(() => {
    let isSubscribed = true;
    setIsLoading(true);

    MediaTrackDatastore.findMediaTracks({})
      .then(mediaTrackDataList => MediaTrackService.buildMediaTracks(mediaTrackDataList))
      .then((mediaTracks) => {
        if (!isSubscribed) {
          return;
        }
        setRows(mediaTracks.map((track) => {
          const trackArtists = (track.track_artists || []).map(artist => String(artist.artist_name || '').trim()).filter(Boolean);
          return {
            id: track.id,
            track,
            coverPath: getTrackCoverPath(track),
            title: String(track.track_name || '').trim(),
            artist: trackArtists.join(', '),
            album: String(track.track_album?.album_name || '').trim(),
            year: Number(track.track_album?.album_year || 0),
            genre: String(track.track_album?.album_genre || '').trim(),
            plays: Number((track.extra as any)?.play_count || 0),
          };
        }));
      })
      .finally(() => {
        if (isSubscribed) {
          setIsLoading(false);
        }
      });

    return () => {
      isSubscribed = false;
    };
  }, []);

  const normalizedTopBarSearchQuery = topBarSearchQuery.toLowerCase().trim();
  const topBarSearchTerms = useMemo(() => normalizedTopBarSearchQuery
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean), [normalizedTopBarSearchQuery]);

  const filteredRows = useMemo(() => {
    if (!normalizedTopBarSearchQuery) {
      return rows;
    }
    return rows.filter((row) => {
      const haystack = `${row.title} ${row.artist} ${row.album} ${row.genre} ${row.year}`.toLowerCase().trim();
      if (!haystack) {
        return false;
      }
      if (haystack.includes(normalizedTopBarSearchQuery)) {
        return true;
      }
      return topBarSearchTerms.every(term => haystack.includes(term));
    });
  }, [
    normalizedTopBarSearchQuery,
    rows,
    topBarSearchTerms,
  ]);

  const sortedRows = useMemo(() => {
    const nextRows = [...filteredRows];
    nextRows.sort((rowA, rowB) => {
      const valueA = getSortableValue(rowA, sortBy);
      const valueB = getSortableValue(rowB, sortBy);
      if (valueA === valueB) {
        return rowA.title.localeCompare(rowB.title, undefined, { sensitivity: 'base' });
      }
      if (typeof valueA === 'number' && typeof valueB === 'number') {
        return valueA - valueB;
      }
      return String(valueA).localeCompare(String(valueB), undefined, { sensitivity: 'base' });
    });
    return sortDirection === 'asc' ? nextRows : nextRows.reverse();
  }, [filteredRows, sortBy, sortDirection]);

  const visibleColumnKeys = ALL_COLUMNS.filter(column => visibleColumns[column.key]).map(column => column.key);
  const sortedTracks = useMemo(() => sortedRows.map(row => row.track), [sortedRows]);

  const toggleColumnVisibility = (columnKey: TrackColumnKey) => {
    const currentlyVisible = visibleColumns[columnKey];
    const visibleCount = Object.values(visibleColumns).filter(Boolean).length;
    if (currentlyVisible && visibleCount <= 1) {
      return;
    }
    setVisibleColumns(prev => ({
      ...prev,
      [columnKey]: !prev[columnKey],
    }));
  };

  const onHeaderSort = (columnKey: TrackColumnKey) => {
    if (columnKey === 'cover') {
      return;
    }
    if (sortBy === columnKey) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(columnKey);
    setSortDirection('asc');
  };

  return (
    <div className={cx('tracks-page')}>
      <div className={cx('tracks-toolbar')}>
        <div className={cx('tracks-toolbar-copy')}>
          {I18nService.getString('search_result_heading_tracks')}
          {`: ${sortedRows.length}`}
        </div>
        <div className={cx('tracks-column-menu-container')}>
          <Button
            variant={['rounded', 'outline']}
            icon={Icons.Menu}
            onButtonSubmit={() => setShowColumnMenu(prev => !prev)}
          >
            Spalten
          </Button>
          {showColumnMenu && (
            <div className={cx('tracks-column-menu')}>
              {ALL_COLUMNS.map(column => (
                <label key={column.key} className={cx('tracks-column-option')} htmlFor={`tracks-column-${column.key}`}>
                  <input
                    id={`tracks-column-${column.key}`}
                    type="checkbox"
                    checked={visibleColumns[column.key]}
                    onChange={() => toggleColumnVisibility(column.key)}
                  />
                  <span>{column.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={cx('tracks-table-wrapper')}>
        <table className={cx('tracks-table')}>
          <thead>
            <tr>
              {ALL_COLUMNS.filter(column => visibleColumns[column.key]).map(column => (
                <th key={column.key}>
                  <button
                    type="button"
                    className={cx('tracks-header-button', {
                      sortable: column.sortable,
                      active: column.sortable && sortBy === column.key,
                    })}
                    onClick={() => column.sortable && onHeaderSort(column.key)}
                  >
                    <span>{column.label}</span>
                    {column.sortable && sortBy === column.key && (
                      <Icon name={sortDirection === 'asc' ? Icons.SortAsc : Icons.SortDesc}/>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={Math.max(1, visibleColumnKeys.length)} className={cx('tracks-empty')}>
                  ...
                </td>
              </tr>
            )}
            {!isLoading && sortedRows.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, visibleColumnKeys.length)} className={cx('tracks-empty')}>
                  {I18nService.getString('label_dashboard_no_plays')}
                </td>
              </tr>
            )}
            {!isLoading && sortedRows.map((row) => {
              const isCurrentTrack = String(currentTrackId || '') === row.id;
              return (
                <tr key={row.id} className={cx('tracks-row', { 'tracks-row-current': isCurrentTrack })}>
                  {visibleColumns.cover && (
                    <td className={cx('tracks-cover-cell')}>
                      {row.coverPath ? (
                        <img className={cx('tracks-cover')} src={row.coverPath} alt={row.album || row.title}/>
                      ) : (
                        <div className={cx('tracks-cover-placeholder')}>
                          <Icon name={Icons.TrackPlaceholder}/>
                        </div>
                      )}
                    </td>
                  )}
                  {visibleColumns.title && (
                    <td>
                      <button
                        type="button"
                        className={cx('tracks-title-button', { 'tracks-title-button-current': isCurrentTrack })}
                        onClick={() => {
                          const pointer = sortedRows.findIndex(trackRow => trackRow.id === row.id);
                          if (pointer < 0) {
                            MediaPlayerService.playMediaTrack(row.track);
                            return;
                          }
                          MediaPlayerService.playMediaTrackFromList(sortedTracks, pointer);
                        }}
                      >
                        {row.title || '—'}
                      </button>
                    </td>
                  )}
                  {visibleColumns.artist && <td>{row.artist || '—'}</td>}
                  {visibleColumns.album && <td>{row.album || '—'}</td>}
                  {visibleColumns.year && <td>{row.year > 0 ? row.year : '—'}</td>}
                  {visibleColumns.genre && <td>{row.genre || '—'}</td>}
                  {visibleColumns.plays && <td>{row.plays}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
