import React from 'react';
import ReactDOM from 'react-dom';
import classNames from 'classnames/bind';

import { Icons } from '../../constants';
import { Icon } from '../icon/icon.component';
import { Slider } from '../slider/slider.component';
import {
  COLLECTION_COVER_SIZE_MAX,
  COLLECTION_COVER_SIZE_MIN,
} from '../../utils/collection-cover-size.utils';

import styles from './collection-cover-size-control.component.css';

const cx = classNames.bind(styles);

export function CollectionCoverSizeControl(props: {
  value: number;
  onChange: (value: number) => void;
}) {
  const { value, onChange } = props;
  const container = document.getElementById('browser-header-inline-controls')
    || document.getElementById('library-header-controls');
  if (!container) {
    return null;
  }

  return ReactDOM.createPortal(
    <div className={cx('collection-cover-size-control')}>
      <Icon className={cx('collection-cover-size-icon')} name={Icons.Image}/>
      <div className={cx('collection-cover-size-slider')}>
        <Slider
          sliderContainerClassName={cx('collection-cover-size-slider-instance')}
          sliderTrackClassName={cx('collection-cover-size-slider-track')}
          sliderThumbClassName={cx('collection-cover-size-slider-thumb')}
          value={value}
          maxValue={COLLECTION_COVER_SIZE_MAX}
          onDragCommit={nextValue => onChange(Math.max(COLLECTION_COVER_SIZE_MIN, nextValue))}
          autoCommitOnUpdate
        />
      </div>
    </div>,
    container,
  );
}
