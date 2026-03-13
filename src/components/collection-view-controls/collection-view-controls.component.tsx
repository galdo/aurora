import React from 'react';
import ReactDOM from 'react-dom';
import classNames from 'classnames/bind';

import { Icons } from '../../constants';
import { Button } from '../button/button.component';
import { Icon } from '../icon/icon.component';
import { Slider } from '../slider/slider.component';
import {
  COLLECTION_COVER_SIZE_MAX,
  COLLECTION_COVER_SIZE_MIN,
} from '../../utils/collection-cover-size.utils';

import styles from './collection-view-controls.component.css';

const cx = classNames.bind(styles);

export type CollectionSortDirection = 'asc' | 'desc';

export function CollectionViewControls(props: {
  coverSize: number;
  onCoverSizeChange: (nextValue: number) => void;
  sortBy?: string;
  sortOptions?: Array<{ value: string; label: string }>;
  sortDirection?: CollectionSortDirection;
  onSortByChange?: (value: string) => void;
  onSortDirectionToggle?: () => void;
  sortToggleTooltip?: string;
}) {
  const {
    coverSize,
    onCoverSizeChange,
    sortBy,
    sortOptions,
    sortDirection = 'asc',
    onSortByChange,
    onSortDirectionToggle,
    sortToggleTooltip,
  } = props;

  const container = document.getElementById('browser-header-inline-controls')
    || document.getElementById('library-header-controls');
  if (!container) {
    return null;
  }

  const hasSortControls = !!sortBy && !!sortOptions?.length && !!onSortByChange && !!onSortDirectionToggle;

  return ReactDOM.createPortal(
    <div className={cx('collection-controls')}>
      {hasSortControls && (
        <div className={cx('collection-sort-control')}>
          <select
            className={cx('collection-select')}
            value={sortBy}
            onChange={event => onSortByChange(event.target.value)}
          >
            {sortOptions.map(sortOption => (
              <option key={sortOption.value} value={sortOption.value}>{sortOption.label}</option>
            ))}
          </select>
          <Button
            icon={sortDirection === 'asc' ? Icons.SortAsc : Icons.SortDesc}
            variant={['rounded', 'outline']}
            onButtonSubmit={onSortDirectionToggle}
            tooltip={sortToggleTooltip}
          />
        </div>
      )}
      <div className={cx('collection-size-control')}>
        <Icon name={Icons.Image}/>
        <div className={cx('collection-size-slider')}>
          <Slider
            sliderContainerClassName={cx('collection-slider-instance')}
            sliderTrackClassName={cx('collection-slider-track')}
            sliderThumbClassName={cx('collection-slider-thumb')}
            value={coverSize}
            maxValue={COLLECTION_COVER_SIZE_MAX}
            onDragCommit={nextValue => onCoverSizeChange(Math.max(COLLECTION_COVER_SIZE_MIN, nextValue))}
            autoCommitOnUpdate
          />
        </div>
      </div>
    </div>,
    container,
  );
}
