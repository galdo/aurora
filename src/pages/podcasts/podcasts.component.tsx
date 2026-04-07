import React, { useEffect, useMemo, useState } from 'react';
import classNames from 'classnames/bind';
import _ from 'lodash';

import { CollectionViewControls, Icon } from '../../components';
import { openPodcastSideView } from '../../components/media-sideview/media-sideview.store';
import { IPodcastSubscription } from '../../interfaces';
import { Icons } from '../../constants';
import { I18nService, PodcastService } from '../../services';
import {
  COLLECTION_COVER_SIZE_DEFAULT,
  COLLECTION_COVER_SIZE_EVENT,
  clampCollectionCoverSize,
  getCollectionCoverSize,
  setCollectionCoverSize,
} from '../../utils/collection-cover-size.utils';

import styles from './podcasts.component.css';

const cx = classNames.bind(styles);
type SortOption = 'album' | 'artist' | 'genre' | 'added';
type SortDirection = 'asc' | 'desc';
const SETTINGS_KEY = 'aurora:podcasts-view-settings';

function usePodcastSubscriptions() {
  const [subscriptions, setSubscriptions] = useState<IPodcastSubscription[]>(() => PodcastService.getSubscriptions());

  useEffect(() => {
    const updateSubscriptions = () => {
      setSubscriptions(PodcastService.getSubscriptions());
    };
    const unsubscribe = PodcastService.subscribe(updateSubscriptions);
    updateSubscriptions();
    return () => unsubscribe();
  }, []);

  return subscriptions;
}

export function PodcastsPage() {
  const subscriptions = usePodcastSubscriptions();
  const [coverSize, setCoverSize] = useState(COLLECTION_COVER_SIZE_DEFAULT);
  const [sortBy, setSortBy] = useState<SortOption>('album');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  useEffect(() => {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.sortBy === 'album' || parsed.sortBy === 'artist' || parsed.sortBy === 'genre' || parsed.sortBy === 'added') {
          setSortBy(parsed.sortBy);
        }
        if (parsed.sortDirection === 'asc' || parsed.sortDirection === 'desc') {
          setSortDirection(parsed.sortDirection);
        }
      } catch (_error) {
        localStorage.removeItem(SETTINGS_KEY);
      }
    }
    PodcastService.refreshSubscriptions().catch(() => undefined);
    setCoverSize(getCollectionCoverSize());
  }, []);

  useEffect(() => {
    const handleCoverSizeChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ coverSize?: number }>;
      const nextSize = clampCollectionCoverSize(Number(customEvent.detail?.coverSize || COLLECTION_COVER_SIZE_DEFAULT));
      setCoverSize(nextSize);
    };
    window.addEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
    return () => window.removeEventListener(COLLECTION_COVER_SIZE_EVENT, handleCoverSizeChange as EventListener);
  }, []);

  const subscriptionsIndexById = useMemo(() => {
    const indexById = new Map<string, number>();
    subscriptions.forEach((subscription, index) => {
      indexById.set(subscription.id, index);
    });
    return indexById;
  }, [subscriptions]);

  const subscriptionsSorted = useMemo(() => {
    let iteratee: any;
    switch (sortBy) {
      case 'artist':
        iteratee = (subscription: IPodcastSubscription) => String(subscription.publisher || '').toLowerCase();
        break;
      case 'genre':
        iteratee = (subscription: IPodcastSubscription) => String(subscription.genre || '').toLowerCase();
        break;
      case 'added':
        iteratee = (subscription: IPodcastSubscription) => Number(subscriptionsIndexById.get(subscription.id) || 0);
        break;
      case 'album':
      default:
        iteratee = (subscription: IPodcastSubscription) => String(subscription.title || '').toLowerCase();
        break;
    }
    return (_.orderBy(subscriptions, [iteratee], [sortDirection]) || []) as IPodcastSubscription[];
  }, [sortBy, sortDirection, subscriptions, subscriptionsIndexById]);

  const updateSort = (nextSortBy: SortOption, nextSortDirection: SortDirection) => {
    const effectiveSortDirection = nextSortBy === 'added' && nextSortDirection === 'asc'
      ? 'desc'
      : nextSortDirection;
    setSortBy(nextSortBy);
    setSortDirection(effectiveSortDirection);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sortBy: nextSortBy,
      sortDirection: effectiveSortDirection,
    }));
  };

  return (
    <div className={cx('podcasts-page')}>
      <CollectionViewControls
        coverSize={coverSize}
        onCoverSizeChange={value => setCoverSize(setCollectionCoverSize(value))}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortByChange={value => updateSort(value as SortOption, sortDirection)}
        onSortDirectionToggle={() => updateSort(sortBy, sortDirection === 'asc' ? 'desc' : 'asc')}
        sortToggleTooltip={I18nService.getString('tooltip_album_sort_toggle')}
        sortOptions={[
          { value: 'album', label: 'Podcast Titel' },
          { value: 'artist', label: 'Herausgeber' },
          { value: 'genre', label: I18nService.getString('label_genre') },
          { value: 'added', label: I18nService.getString('label_album_sort_added') },
        ]}
      />
      <div className={cx('podcasts-page-title')}>
        {I18nService.getString('link_podcasts')}
      </div>
      {subscriptionsSorted.length === 0 && (
        <div className={cx('podcasts-empty')}>
          {I18nService.getString('label_podcasts_empty')}
        </div>
      )}
      <div
        className={cx('podcasts-grid')}
        style={{ '--album-cover-size': `${coverSize}px` } as React.CSSProperties}
      >
        {subscriptionsSorted.map((subscription) => {
          const hasUnplayedEpisodes = subscription.hasNewEpisodes
            || subscription.episodes.some(episode => episode.isNew);
          return (
            <div
              key={subscription.id}
              className={cx('podcast-card')}
              role="button"
              tabIndex={0}
              onClick={() => openPodcastSideView(subscription.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openPodcastSideView(subscription.id);
                }
              }}
            >
              <div className={cx('podcast-card-content')}>
                <div className={cx('podcast-cover-wrapper')}>
                  {subscription.imageUrl ? (
                    <img
                      src={subscription.imageUrl}
                      alt={subscription.title}
                      className={cx('podcast-cover')}
                    />
                  ) : (
                    <div className={cx('podcast-cover-placeholder')}>
                      <Icon name={Icons.Podcast}/>
                    </div>
                  )}
                  {hasUnplayedEpisodes && (
                    <div className={cx('podcast-status')}>
                      <span className={cx('podcast-status-dot')}/>
                      <span className={cx('podcast-status-new')}>Neu</span>
                      <span className={cx('podcast-status-unplayed')}>(ungespielt)</span>
                    </div>
                  )}
                </div>
                <div className={cx('podcast-meta')}>
                  <div className={cx('podcast-title')}>
                    {subscription.title}
                  </div>
                  <div className={cx('podcast-publisher')}>
                    {subscription.publisher || '-'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PodcastsHeader() {
  return null;
}
