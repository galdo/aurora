import React from 'react';
import classNames from 'classnames/bind';

import { MediaEnums } from '../../enums';
import { IMediaPicture } from '../../interfaces';

import { Icon } from '../icon/icon.component';
import { LoaderCircle } from '../loader/loader-circle.component';

import styles from './media-cover-picture.component.css';

const cx = classNames.bind(styles);

export type MediaCoverPictureProps = {
  children?: React.ReactNode;
  mediaPicture?: IMediaPicture;
  mediaPictureAltText?: string;
  mediaCoverPlaceholderIcon?: string;
  isLoading?: boolean;
  className?: string;
  contentClassName?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function MediaCoverPicture(props: MediaCoverPictureProps) {
  const {
    children,
    mediaPicture,
    mediaPictureAltText,
    mediaCoverPlaceholderIcon,
    isLoading,
    className,
    contentClassName,
    onContextMenu,
  } = props;

  let mediaCoverPictureImageSrc;

  if (mediaPicture) {
    switch (mediaPicture.image_data_type) {
      case MediaEnums.MediaTrackCoverPictureImageDataType.Path: {
        mediaCoverPictureImageSrc = mediaPicture.image_data;
        break;
      }
      default:
        throw new Error(`MediaTrackCoverPictureComponent component encountered error while process media track - Unsupported image data type - ${mediaPicture.image_data_type}`);
    }
  }
  const [imageLoadFailed, setImageLoadFailed] = React.useState(false);

  React.useEffect(() => {
    setImageLoadFailed(false);
  }, [mediaCoverPictureImageSrc]);

  let mediaCoverContent = mediaCoverPlaceholderIcon ? (
    <div className={cx('media-cover-placeholder')}>
      <Icon
        className={cx('media-cover-placeholder-icon')}
        name={mediaCoverPlaceholderIcon}
      />
    </div>
  ) : null;

  if (isLoading) {
    mediaCoverContent = (
      <div className={cx('media-cover-placeholder')}>
        <LoaderCircle
          size={28}
          className={cx('media-cover-loader')}
        />
      </div>
    );
  }

  if (mediaCoverPictureImageSrc && !imageLoadFailed) {
    mediaCoverContent = (
      <img
        alt={mediaPictureAltText}
        src={mediaCoverPictureImageSrc}
        onError={() => setImageLoadFailed(true)}
      />
    );
  }

  return (
    <div
      className={cx('media-cover-picture', { has_content: !!children }, className)}
      onContextMenu={onContextMenu}
    >
      {mediaCoverContent}
      <div className={cx('media-cover-picture-content', contentClassName)}>
        {children}
      </div>
    </div>
  );
}
