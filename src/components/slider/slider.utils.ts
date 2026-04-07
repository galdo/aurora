export function getPercentFromValue(mediaProgressValue: number, mediaProgressMaxThreshold: number): number {
  return (mediaProgressValue / mediaProgressMaxThreshold) * 100;
}

export function getValueFromPercent(mediaProgressPercent: number, mediaProgressMaxThreshold: number): number {
  const value = (mediaProgressPercent / 100) * mediaProgressMaxThreshold;
  return Number(value.toFixed());
}

export function getPercentFromHorizontalPosition(mediaProgressPosition: number, mediaProgressContainerElement: HTMLDivElement, mediaProgressMaxThreshold: number): number {
  const mediaProgressContainerPositionStart = mediaProgressContainerElement.getBoundingClientRect().left;
  const mediaProgressContainerPositionEnd = mediaProgressContainerElement.getBoundingClientRect().right;

  let mediaProgressPercent: number;

  if (mediaProgressPosition < mediaProgressContainerPositionStart) {
    mediaProgressPercent = 0;
  } else if (mediaProgressPosition > mediaProgressContainerPositionEnd) {
    mediaProgressPercent = 100;
  } else {
    const mediaProgressOffset = mediaProgressPosition - mediaProgressContainerPositionStart;
    const mediaProgressContainerWidth = mediaProgressContainerPositionEnd - mediaProgressContainerPositionStart;

    const mediaProgressContainerBreakpoint = mediaProgressContainerWidth / mediaProgressMaxThreshold;
    const mediaProgressNearBreakpoint = Math.ceil((mediaProgressOffset / mediaProgressContainerBreakpoint)) * mediaProgressContainerBreakpoint;

    mediaProgressPercent = getPercentFromValue(mediaProgressNearBreakpoint, mediaProgressContainerWidth);
  }

  return mediaProgressPercent;
}

export function getPercentFromVerticalPosition(mediaProgressPosition: number, mediaProgressContainerElement: HTMLDivElement, mediaProgressMaxThreshold: number): number {
  const mediaProgressContainerPositionTop = mediaProgressContainerElement.getBoundingClientRect().top;
  const mediaProgressContainerPositionBottom = mediaProgressContainerElement.getBoundingClientRect().bottom;
  let mediaProgressPercent: number;

  if (mediaProgressPosition < mediaProgressContainerPositionTop) {
    mediaProgressPercent = 100;
  } else if (mediaProgressPosition > mediaProgressContainerPositionBottom) {
    mediaProgressPercent = 0;
  } else {
    const mediaProgressContainerHeight = mediaProgressContainerPositionBottom - mediaProgressContainerPositionTop;
    const mediaProgressOffset = mediaProgressContainerPositionBottom - mediaProgressPosition;
    const mediaProgressContainerBreakpoint = mediaProgressContainerHeight / mediaProgressMaxThreshold;
    const mediaProgressNearBreakpoint = Math.ceil((mediaProgressOffset / mediaProgressContainerBreakpoint)) * mediaProgressContainerBreakpoint;
    mediaProgressPercent = getPercentFromValue(mediaProgressNearBreakpoint, mediaProgressContainerHeight);
  }

  return mediaProgressPercent;
}
