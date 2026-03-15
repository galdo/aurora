import { DataStoreFilterData, DataStoreInputData, DataStoreUpdateData } from '../modules/datastore';
import { IMediaPlaylistData, IMediaPlaylistTrackData } from '../interfaces';
import { IPCRenderer, IPCCommChannel } from '../modules/ipc';

class MediaPlaylistDatastore {
  private readonly mediaPlaylistsDatastoreName = 'media_playlists';

  constructor() {
    IPCRenderer.sendSyncMessage(IPCCommChannel.DSRegisterDatastore, this.mediaPlaylistsDatastoreName, {
      indexes: [{
        field: 'id',
        unique: true,
      }, {
        field: 'name',
      }, {
        field: 'name_normalized',
      }],
    });
  }

  countMediaPlaylists(): Promise<number> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSCount, this.mediaPlaylistsDatastoreName);
  }

  insertMediaPlaylist(mediaPlaylistInputData: DataStoreInputData<IMediaPlaylistData>): Promise<IMediaPlaylistData> {
    const now = Date.now();
    const name = String(mediaPlaylistInputData.name || '');

    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSInsertOne, this.mediaPlaylistsDatastoreName, {
      ...mediaPlaylistInputData,
      name_normalized: mediaPlaylistInputData.name_normalized || this.normalizeSearchValue(name),
      created_at: now,
      updated_at: now,
    });
  }

  addMediaPlaylistTracks(mediaPlaylistId: string, mediaTrackInputDataList: IMediaPlaylistTrackData[]): Promise<IMediaPlaylistData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdateOne, this.mediaPlaylistsDatastoreName, {
      id: mediaPlaylistId,
    }, {
      $push: {
        tracks: {
          $each: mediaTrackInputDataList,
        },
      },
      $set: {
        updated_at: Date.now(),
      },
    });
  }

  deleteMediaPlaylistTracks(mediaPlaylistId: string, mediaPlaylistTrackIds: string[]): Promise<IMediaPlaylistData> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdateOne, this.mediaPlaylistsDatastoreName, {
      id: mediaPlaylistId,
    }, {
      $pull: {
        tracks: {
          playlist_track_id: {
            $in: mediaPlaylistTrackIds,
          },
        },
      },
      $set: {
        updated_at: Date.now(),
      },
    });
  }

  findMediaPlaylist(mediaPlaylistFilterData: DataStoreFilterData<IMediaPlaylistData>): Promise<IMediaPlaylistData | undefined> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFindOne, this.mediaPlaylistsDatastoreName, mediaPlaylistFilterData);
  }

  findMediaPlaylists(mediaPlaylistFilterData?: DataStoreFilterData<IMediaPlaylistData>): Promise<IMediaPlaylistData[]> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSFind, this.mediaPlaylistsDatastoreName, {
      filter: mediaPlaylistFilterData,
    });
  }

  deleteMediaPlaylist(mediaPlaylistFilterData?: DataStoreFilterData<IMediaPlaylistData>): Promise<void> {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSRemoveOne, this.mediaPlaylistsDatastoreName, mediaPlaylistFilterData);
  }

  updateMediaPlaylist(mediaPlaylistId: string, mediaPlaylistUpdateData: DataStoreUpdateData<IMediaPlaylistData>) {
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpdateOne, this.mediaPlaylistsDatastoreName, {
      id: mediaPlaylistId,
    }, {
      $set: {
        ...mediaPlaylistUpdateData,
        ...(mediaPlaylistUpdateData.name ? {
          name_normalized: this.normalizeSearchValue(mediaPlaylistUpdateData.name),
        } : {}),
        updated_at: Date.now(),
      },
    });
  }

  upsertMediaPlaylist(mediaPlaylistFilterData: DataStoreFilterData<IMediaPlaylistData>, mediaPlaylistInputData: DataStoreInputData<IMediaPlaylistData>) {
    const now = Date.now();
    const name = String(mediaPlaylistInputData.name || '');
    return IPCRenderer.sendAsyncMessage(IPCCommChannel.DSUpsertOne, this.mediaPlaylistsDatastoreName, mediaPlaylistFilterData, {
      ...mediaPlaylistInputData,
      name_normalized: mediaPlaylistInputData.name_normalized || this.normalizeSearchValue(name),
      updated_at: now,
      created_at: now,
    });
  }

  private normalizeSearchValue(value: string): string {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }
}

export default new MediaPlaylistDatastore();
