import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { Form, Modal } from 'react-bootstrap';

import { ModalComponent } from '../../contexts';
import { IMediaAlbum, IMediaAlbumUpdateData } from '../../interfaces';
import { I18nService, MediaAlbumService, MediaLibraryService } from '../../services';
import { CryptoService } from '../../modules/crypto/service';
import MediaLocalConstants from '../../providers/media-local/media-local.constants.json';

import { Button } from '../button/button.component';

function getSanitizedAlbumName(albumName?: string, artistName?: string): string {
  const normalizedAlbumName = String(albumName || '').trim();
  const normalizedArtistName = String(artistName || '').trim();
  if (!normalizedAlbumName || !normalizedArtistName) {
    return normalizedAlbumName;
  }

  const escapedArtistName = normalizedArtistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const artistPrefixPattern = new RegExp(`^${escapedArtistName}\\s*[-–—]\\s*`, 'i');

  return normalizedAlbumName.replace(artistPrefixPattern, '').trim();
}

export const MediaAlbumEditModal: ModalComponent<{
  mediaAlbumId: string;
}, {
  updatedAlbum?: IMediaAlbum,
}> = (props) => {
  const {
    mediaAlbumId,
    onComplete,
  } = props;

  const [validated, setValidated] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [inputData, setInputData] = useState<IMediaAlbumUpdateData & { album_artist_name?: string }>({
    album_name: '',
    album_artist_name: '',
    album_genre: '',
    album_year: undefined,
  });
  const [initialData, setInitialData] = useState<IMediaAlbumUpdateData & { album_artist_name?: string }>({});

  const handleSubmit = useCallback(async (event: any) => {
    event.preventDefault();
    setValidated(true);

    if (!formRef.current?.checkValidity()) {
      return;
    }

    const nextAlbumName = String(inputData.album_name || '').trim();
    const nextAlbumArtistName = String(inputData.album_artist_name || '').trim();
    const initialAlbumArtistName = String(initialData.album_artist_name || '').trim();

    const updateData: any = {
      album_name: nextAlbumName,
      album_genre: String(inputData.album_genre || '').trim(),
      album_year: inputData.album_year ? Number(inputData.album_year) : undefined,
      sync_timestamp: Date.now(),
    };

    if (nextAlbumArtistName !== initialAlbumArtistName && nextAlbumArtistName) {
      const artist = await MediaLibraryService.checkAndInsertMediaArtist({
        artist_name: nextAlbumArtistName,
        provider: MediaLocalConstants.Provider,
        provider_id: CryptoService.sha256(nextAlbumArtistName),
        sync_timestamp: Date.now(),
      });
      updateData.album_artist_id = artist.id;
    }

    const providerArtistName = nextAlbumArtistName || initialAlbumArtistName;
    if (providerArtistName && nextAlbumName) {
      updateData.provider_id = CryptoService.sha256(providerArtistName, nextAlbumName);
    }

    const updatedAlbum = await MediaAlbumService.updateMediaAlbum({
      id: mediaAlbumId,
    }, updateData);

    // Sync metadata to files
    if (updatedAlbum) {
      await MediaAlbumService.syncAlbumMetadata(updatedAlbum.id);
    }

    onComplete({ updatedAlbum });
  }, [
    inputData,
    initialData,
    mediaAlbumId,
    onComplete,
  ]);

  useEffect(() => {
    MediaAlbumService.getMediaAlbum(mediaAlbumId)
      .then((mediaAlbum) => {
        if (!mediaAlbum) {
          return;
        }

        const albumArtistName = String(mediaAlbum.album_artist?.artist_name || '').trim();
        const data = {
          album_name: getSanitizedAlbumName(mediaAlbum.album_name, albumArtistName),
          album_artist_name: albumArtistName,
          album_genre: mediaAlbum.album_genre || '',
          album_year: mediaAlbum.album_year,
        };
        setInputData(data);
        setInitialData(data);
      });
  }, [
    mediaAlbumId,
  ]);

  return (
    <>
      <Modal.Header>
        <Modal.Title>
          {I18nService.getString('label_album_edit')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form ref={formRef} noValidate validated={validated} onSubmit={handleSubmit}>
          <Form.Group>
            <Form.Label>
              {I18nService.getString('label_album_name')}
            </Form.Label>
            <Form.Control
              required
              type="text"
              placeholder={I18nService.getString('label_album_name')}
              value={inputData.album_name}
              onChange={event => setInputData(data => ({
                ...data,
                album_name: event.target.value,
              }))}
            />
            <Form.Control.Feedback type="invalid">
              {I18nService.getString('message_value_invalid')}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group>
            <Form.Label>
              {I18nService.getString('label_artist_name')}
            </Form.Label>
            <Form.Control
              required
              type="text"
              placeholder={I18nService.getString('label_artist_name')}
              value={inputData.album_artist_name}
              onChange={event => setInputData(data => ({
                ...data,
                album_artist_name: event.target.value,
              }))}
            />
            <Form.Control.Feedback type="invalid">
              {I18nService.getString('message_value_invalid')}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group>
            <Form.Label>
              {I18nService.getString('label_genre')}
            </Form.Label>
            <Form.Control
              type="text"
              placeholder={I18nService.getString('label_genre')}
              value={inputData.album_genre}
              onChange={event => setInputData(data => ({
                ...data,
                album_genre: event.target.value,
              }))}
            />
          </Form.Group>

          <Form.Group>
            <Form.Label>
              {I18nService.getString('label_release_date')}
            </Form.Label>
            <Form.Control
              type="number"
              placeholder={I18nService.getString('label_release_date')}
              value={inputData.album_year || ''}
              onChange={event => setInputData(data => ({
                ...data,
                album_year: parseInt(event.target.value, 10),
              }))}
            />
          </Form.Group>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          onButtonSubmit={() => {
            onComplete();
          }}
        >
          {I18nService.getString('button_dialog_cancel')}
        </Button>
        <Button
          className="primary"
          onButtonSubmit={handleSubmit}
        >
          {I18nService.getString('button_dialog_confirm')}
        </Button>
      </Modal.Footer>
    </>
  );
};
