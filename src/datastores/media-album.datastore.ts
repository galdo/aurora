import { IMediaAlbumData } from '../interfaces';

import {
  DataStoreFilterData,
  DataStoreInputData,
  DataStoreUpdateData,
} from '../modules/datastore';

import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

class MediaAlbumDatastore {
  private readonly mediaAlbumDatastoreName = 'media_albums';

  constructor() {
    IPCRenderer.sendSyncMessage(IPCCommChannel.DSRegisterDatastore, this.mediaAlbumDatastoreName, {
      indexes: [{
        field: 'id',
        unique: true,
      }, {
        field: 'provider_id',
        unique: true,
      }, {
        field: 'album_name',
      }, {
        field: 'album_name_normalized',
      },
      // Phase 2 perf optimization (#23): `extra.source_fingerprint` is the
      // dominant lookup key during sync — every track that ends up in a
      // pre-existing album triggers a `findMediaAlbum` over this nested
      // path (see `media-library.service.ts → checkAndInsertMediaAlbum`,
      // `resolveMediaAlbumTracks`, `consolidateCompilationAlbums`).
      // Without an index that's an O(albums) scan per track ≈ O(n²) on
      // a 3 000-track / 300-album library. NEDB lazily builds the index
      // on first load after upgrade, no migration needed.
      {
        field: 'extra.source_fingerprint',
      }],
    });
  }

  findMediaAlbumById(mediaAlbumId: string): Promise<IMediaAlbumData | undefined> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFindOne, this.mediaAlbumDatastoreName, {
      id: mediaAlbumId,
    });
  }

  findMediaAlbum(mediaAlbumFilterData: DataStoreFilterData<IMediaAlbumData>): Promise<IMediaAlbumData | undefined> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFindOne, this.mediaAlbumDatastoreName, mediaAlbumFilterData);
  }

  findMediaAlbums(mediaAlbumFilterData?: DataStoreFilterData<IMediaAlbumData>): Promise<IMediaAlbumData[]> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFind, this.mediaAlbumDatastoreName, {
      filter: mediaAlbumFilterData,
    });
  }

  updateAlbumById(mediaAlbumId: string, mediaAlbumUpdateData: DataStoreUpdateData<IMediaAlbumData>): Promise<IMediaAlbumData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdateOne, this.mediaAlbumDatastoreName, {
      id: mediaAlbumId,
    }, {
      $set: mediaAlbumUpdateData,
    });
  }

  updateMediaAlbum(mediaAlbumFilterData: DataStoreFilterData<IMediaAlbumData>, mediaAlbumUpdateData: DataStoreUpdateData<IMediaAlbumData>): Promise<IMediaAlbumData | undefined> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdateOne, this.mediaAlbumDatastoreName, mediaAlbumFilterData, {
      $set: mediaAlbumUpdateData,
    });
  }

  updateMediaAlbums(mediaAlbumFilterData: DataStoreFilterData<IMediaAlbumData>, mediaAlbumUpdateData: DataStoreUpdateData<IMediaAlbumData>): Promise<IMediaAlbumData[]> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdate, this.mediaAlbumDatastoreName, mediaAlbumFilterData, {
      $set: mediaAlbumUpdateData,
    });
  }

  insertMediaAlbum(mediaAlbumInputData: DataStoreInputData<IMediaAlbumData>): Promise<IMediaAlbumData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSInsertOne, this.mediaAlbumDatastoreName, mediaAlbumInputData);
  }

  deleteAlbums(mediaAlbumFilterData?: DataStoreFilterData<IMediaAlbumData>): Promise<void> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSRemove, this.mediaAlbumDatastoreName, mediaAlbumFilterData);
  }

  upsertMediaAlbum(mediaAlbumFilterData: DataStoreFilterData<IMediaAlbumData>, mediaAlbumInputData: DataStoreInputData<IMediaAlbumData>): Promise<IMediaAlbumData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpsertOne, this.mediaAlbumDatastoreName, mediaAlbumFilterData, mediaAlbumInputData);
  }
}

export default new MediaAlbumDatastore();
