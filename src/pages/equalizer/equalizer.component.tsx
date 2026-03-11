import React, { useCallback, useState } from 'react';
import classNames from 'classnames/bind';

import { Button, Slider } from '../../components';
import { I18nService, EqualizerService } from '../../services';

import styles from './equalizer.component.css';

const cx = classNames.bind(styles);

function formatFrequencyLabel(frequency: number): string {
  if (frequency >= 1000) {
    return `${frequency / 1000}kHz`;
  }
  return `${frequency}Hz`;
}

export function EqualizerPage() {
  const [bands, setBands] = useState(() => EqualizerService.getBands());
  const [headroomCompensationEnabled, setHeadroomCompensationEnabled] = useState(
    () => EqualizerService.getHeadroomCompensationEnabled(),
  );
  const chartWidth = 660;
  const chartHeight = 120;
  const chartPaddingX = 18;
  const chartPaddingY = 12;
  const chartInnerWidth = chartWidth - (chartPaddingX * 2);
  const chartInnerHeight = chartHeight - (chartPaddingY * 2);
  const chartPoints = bands.map((band, index) => {
    const x = chartPaddingX + (index * (chartInnerWidth / (Math.max(bands.length - 1, 1))));
    const normalizedGain = (band.gain + 12) / 24;
    const y = chartPaddingY + ((1 - normalizedGain) * chartInnerHeight);
    return `${x},${y}`;
  }).join(' ');
  const chartGuides = [0, 6, 12, 18, 24].map((gain) => {
    const normalizedGain = gain / 24;
    return chartPaddingY + ((1 - normalizedGain) * chartInnerHeight);
  });

  const handleReset = useCallback(() => {
    setBands(EqualizerService.resetBands());
  }, []);

  const handleToggleHeadroomCompensation = useCallback(() => {
    setHeadroomCompensationEnabled(
      EqualizerService.setHeadroomCompensationEnabled(!headroomCompensationEnabled),
    );
  }, [headroomCompensationEnabled]);

  return (
    <div className={cx('equalizer-page')}>
      <div className={cx('equalizer-header')}>
        <div className={cx('equalizer-title')}>
          {I18nService.getString('link_equalizer')}
        </div>
        <Button onButtonSubmit={handleReset}>
          {I18nService.getString('label_equalizer_reset')}
        </Button>
      </div>
      <div className={cx('equalizer-card')}>
        <div className={cx('equalizer-subtitle')}>
          {I18nService.getString('label_equalizer_subtitle')}
        </div>
        <div className={cx('equalizer-headroom-row')}>
          <div>
            <div className={cx('equalizer-headroom-title')}>
              {I18nService.getString('label_equalizer_headroom_compensation')}
            </div>
            <div className={cx('equalizer-headroom-description')}>
              {I18nService.getString('label_equalizer_headroom_compensation_description')}
            </div>
          </div>
          <div className={cx('equalizer-headroom-switch')}>
            <button
              type="button"
              className={cx('equalizer-headroom-switch-item', { active: headroomCompensationEnabled })}
              onClick={handleToggleHeadroomCompensation}
            >
              {headroomCompensationEnabled
                ? I18nService.getString('label_toggle_on')
                : I18nService.getString('label_toggle_off')}
            </button>
          </div>
        </div>
        <div className={cx('equalizer-chart-container')}>
          <svg
            className={cx('equalizer-chart')}
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            preserveAspectRatio="none"
          >
            {chartGuides.map(yValue => (
              <line
                key={String(yValue)}
                x1={chartPaddingX}
                y1={yValue}
                x2={chartWidth - chartPaddingX}
                y2={yValue}
                className={cx('equalizer-chart-guide')}
              />
            ))}
            <polyline
              points={chartPoints}
              className={cx('equalizer-chart-line')}
            />
            {bands.map((band, index) => {
              const x = chartPaddingX + (index * (chartInnerWidth / (Math.max(bands.length - 1, 1))));
              const normalizedGain = (band.gain + 12) / 24;
              const y = chartPaddingY + ((1 - normalizedGain) * chartInnerHeight);
              return (
                <circle
                  key={band.frequency}
                  cx={x}
                  cy={y}
                  r="3.5"
                  className={cx('equalizer-chart-point')}
                />
              );
            })}
          </svg>
        </div>
        <div className={cx('equalizer-band-list')}>
          {bands.map(band => (
            <div key={band.frequency} className={cx('equalizer-band-item')}>
              <div className={cx('equalizer-band-label')}>
                {formatFrequencyLabel(band.frequency)}
              </div>
              <Slider
                value={(band.gain + 12) * 2}
                maxValue={48}
                orientation="vertical"
                autoCommitOnUpdate
                sliderContainerClassName={cx('equalizer-slider')}
                sliderTrackClassName={cx('equalizer-slider-track')}
                sliderThumbClassName={cx('equalizer-slider-thumb')}
                onDragCommit={(value) => {
                  const normalizedGain = (value / 2) - 12;
                  setBands(EqualizerService.setBandGain(band.frequency, normalizedGain));
                }}
              />
              <div className={cx('equalizer-band-gain')}>
                {band.gain > 0 ? '+' : ''}
                {band.gain.toFixed(1)}
                dB
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
