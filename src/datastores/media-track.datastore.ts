import { IMediaTrackData } from '../interfaces';

import {
  DataStoreFilterData,
  DataStoreInputData,
  DataStoreUpdateData,
} from '../modules/datastore';

import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

class MediaTrackDatastore {
  private readonly mediaTrackDatastoreName = 'media_tracks';

  constructor() {
    IPCRenderer.sendSyncMessage(IPCCommChannel.DSRegisterDatastore, this.mediaTrackDatastoreName, {
      indexes: [{
        field: 'id',
        unique: true,
      }, {
        field: 'provider_id',
        unique: true,
      }, {
        field: 'track_name',
      }, {
        field: 'track_name_normalized',
      },
      // Phase 2 perf optimization (#23): index hot lookup paths used during
      // sync. Without these, NEDB scans every track for every probe — at
      // 3 000 tracks that's an O(n²) blow-up on cold + re-scan paths.
      //
      //   • `track_album_id` — joined on every album-level operation
      //     (resolveMediaAlbumTracks, processCompilationAlbumCovers,
      //      consolidateCompilationAlbums, getMediaAlbumTracks).
      //   • `extra.file_path` — used by the new bulk pre-fetch in the
      //     library-sync (Phase 3) and by per-track recovery paths.
      //   • `extra.file_source` — used by the compilation consolidation pass
      //     (`tracksByDir = _.groupBy(tracks, t => t.extra?.file_source)`).
      //
      // NOTE on existing DBs: NEDB lazily builds missing indexes on the
      // FIRST load after upgrade. That single boot pays the one-time O(n)
      // index build, every subsequent operation is O(log n). No migration
      // step needed in the renderer code.
      {
        field: 'track_album_id',
      }, {
        field: 'extra.file_path',
      }, {
        field: 'extra.file_source',
      }],
    });
  }

  findMediaTrack(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>): Promise<IMediaTrackData | undefined> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFindOne, this.mediaTrackDatastoreName, mediaTrackFilterData);
  }

  findMediaTracks(mediaTrackFilterData?: DataStoreFilterData<IMediaTrackData>): Promise<IMediaTrackData[]> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFind, this.mediaTrackDatastoreName, {
      filter: mediaTrackFilterData,
    });
  }

  updateMediaTrack(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>, mediaTrackUpdateData: DataStoreUpdateData<IMediaTrackData>): Promise<IMediaTrackData | undefined> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdateOne, this.mediaTrackDatastoreName, mediaTrackFilterData, {
      $set: mediaTrackUpdateData,
    });
  }

  updateMediaTracks(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>, mediaTrackUpdateData: DataStoreUpdateData<IMediaTrackData>): Promise<number> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdate, this.mediaTrackDatastoreName, mediaTrackFilterData, {
      $set: mediaTrackUpdateData,
    });
  }

  insertMediaTrack(mediaTrackInputData: DataStoreInputData<IMediaTrackData>): Promise<IMediaTrackData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSInsertOne, this.mediaTrackDatastoreName, mediaTrackInputData);
  }

  deleteTracks(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>): Promise<void> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSRemove, this.mediaTrackDatastoreName, mediaTrackFilterData);
  }

  countMediaTracks(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>): Promise<number> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSCount, this.mediaTrackDatastoreName, mediaTrackFilterData);
  }

  upsertMediaTrack(mediaTrackFilterData: DataStoreFilterData<IMediaTrackData>, mediaTrackInputData: DataStoreInputData<IMediaTrackData>): Promise<IMediaTrackData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpsertOne, this.mediaTrackDatastoreName, mediaTrackFilterData, mediaTrackInputData);
  }
}

export default new MediaTrackDatastore();
