import React, { useEffect, useRef, useState } from 'react';
import classNames from 'classnames/bind';
import { Provider, useSelector } from 'react-redux';
import { MemoryRouter as Router, useHistory, useLocation } from 'react-router-dom';
import _ from 'lodash';

import { MediaSession, MediaPlayer } from '../components';
import { Routes } from '../constants';
import { ContextMenuProvider, ModalProvider, NotificationProvider } from '../contexts';
import { IAppStatePersistor } from '../interfaces';
import { MediaLocalProvider } from '../providers';
import { RootState } from '../reducers';
import {
  I18nService,
  MediaLibraryService,
  MediaProviderService,
  MediaPlayerService,
  EqualizerService,
  DlnaService,
  BitPerfectService,
  UpdateService,
} from '../services';
import { ThemeService } from '../services/theme.service';
import { IPCCommChannel, IPCRenderer, IPCRendererCommChannel } from '../modules/ipc';
import { MediaLibraryActions } from '../enums';

import statePersistors from '../persistors';
import store from '../store';
import { registerStatePersistor, loadState, removeStates } from '../store/persistor';

import styles from './app.component.css';
import { Sidebar } from './sidebar/sidebar.component';
import { Browser } from './browser/browser.component';
import { GlobalMediaSideView } from '../components/media-sideview/media-sideview.component';
import { openAlbumSideView } from '../components/media-sideview/media-sideview.store';

const cx = classNames.bind(styles);
const splashLogoModule = require('../../assets/icons/icon-squircle-no-background.png');

const splashLogo = splashLogoModule.default || splashLogoModule;

// app > splash

function Splash() {
  return (
    <div className={cx('app-splash')}>
      <div className={cx('app-splash-content')}>
        <div className={cx('app-splash-logo')} style={{ backgroundImage: `url(${splashLogo})` }}/>
        <div className={cx('app-splash-title')}>
          <span className={cx('app-splash-title-aurora')}>Aurora</span>
          <span className={cx('app-splash-title-pulse')}>Pulse</span>
        </div>
        <div className={cx('app-splash-loader')}/>
      </div>
    </div>
  );
}

// app > stage

function Stage() {
  const history = useHistory();
  const location = useLocation();
  const mediaIsSyncing = useSelector((state: RootState) => state.mediaLibrary.mediaIsSyncing);
  const mediaSyncStateRef = useRef(mediaIsSyncing);
  const librarySyncGenerationRef = useRef(0);

  // ui related handlers need to be registered under router tree
  useEffect(() => {
    const listener = IPCRenderer.addMessageHandler(IPCRendererCommChannel.UIOpenSettings, () => {
      if (location.pathname !== Routes.Settings) {
        history.push(Routes.Settings);
      }
    });

    return () => {
      IPCRenderer.removeMessageHandler(IPCRendererCommChannel.UIOpenSettings, listener);
    };
  }, [
    history,
    location.pathname,
  ]);

  useEffect(() => {
    const listener = IPCRenderer.addMessageHandler(IPCRendererCommChannel.StateRemovePersisted, removeStates);

    return () => {
      IPCRenderer.removeMessageHandler(IPCRendererCommChannel.StateRemovePersisted, listener);
    };
  }, []);

  useEffect(() => {
    const stopPlaybackOnQuit = () => {
      BitPerfectService.stopPlayback();
      MediaPlayerService.stopMediaPlayer();
      DlnaService.stopSelectedRenderer().catch(() => undefined);
      MediaLibraryService.abortAndResetDapLibrarySyncState();
    };
    const quitListener = IPCRenderer.addMessageHandler(IPCRendererCommChannel.UIAppBeforeQuit, stopPlaybackOnQuit);
    window.addEventListener('beforeunload', stopPlaybackOnQuit);
    window.addEventListener('unload', stopPlaybackOnQuit);

    return () => {
      IPCRenderer.removeMessageHandler(IPCRendererCommChannel.UIAppBeforeQuit, quitListener);
      window.removeEventListener('beforeunload', stopPlaybackOnQuit);
      window.removeEventListener('unload', stopPlaybackOnQuit);
    };
  }, []);

  useEffect(() => {
    try {
      // Initial check
      const status = IPCRenderer.sendSyncMessage(IPCCommChannel.DeviceGetAudioCdStatus);
      store.dispatch({
        type: MediaLibraryActions.SetAudioCd,
        data: status,
      });
    } catch (e) {
      console.error('Failed to get initial audio CD status', e);
    }

    const listener = IPCRenderer.addMessageHandler(IPCRendererCommChannel.DeviceAudioCdUpdate, (status) => {
      store.dispatch({
        type: MediaLibraryActions.SetAudioCd,
        data: status,
      });
    });

    return () => {
      IPCRenderer.removeMessageHandler(IPCRendererCommChannel.DeviceAudioCdUpdate, listener);
    };
  }, []);

  useEffect(() => {
    const wasSyncing = mediaSyncStateRef.current;
    mediaSyncStateRef.current = mediaIsSyncing;
    if (!mediaIsSyncing && wasSyncing) {
      librarySyncGenerationRef.current += 1;
      MediaLibraryService.syncDapLibraryIfEnabled({
        silent: true,
        librarySyncGeneration: librarySyncGenerationRef.current,
      }).catch(() => {});
    }
    return () => {};
  }, [mediaIsSyncing]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (mediaSyncStateRef.current) {
        return;
      }
      const dapSyncSettings = MediaLibraryService.getDapSyncSettings();
      if (!dapSyncSettings.autoSyncEnabled) {
        return;
      }
      if (dapSyncSettings.transport === 'filesystem' && !dapSyncSettings.targetDirectory) {
        return;
      }
      const dapSyncSnapshot = MediaLibraryService.getDapSyncProgressSnapshot();
      if (dapSyncSnapshot.isRunning || !dapSyncSnapshot.canResume) {
        return;
      }
      MediaLibraryService.syncDapLibrary({
        targetDirectory: dapSyncSettings.targetDirectory,
        deleteMissingOnDevice: dapSyncSettings.deleteMissingOnDevice,
        silent: true,
        transport: dapSyncSettings.transport,
      }).catch(() => {});
    }, 12000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let diagSequence = 0;
    const diagEvents: Array<any> = [];
    const maxDiagEvents = 1200;
    const pushDiagEvent = (type: string, details?: Record<string, any>) => {
      diagSequence += 1;
      const entry = {
        seq: diagSequence,
        timestamp: new Date().toISOString(),
        type,
        details: details || {},
      };
      diagEvents.push(entry);
      if (diagEvents.length > maxDiagEvents) {
        diagEvents.splice(0, diagEvents.length - maxDiagEvents);
      }
    };
    let lastStateHash = '';
    const getStateSnapshot = () => {
      const { mediaPlayer } = store.getState();
      const dlnaState = DlnaService.getState();
      return {
        playbackState: mediaPlayer.mediaPlaybackState,
        progress: mediaPlayer.mediaPlaybackCurrentMediaProgress,
        trackId: mediaPlayer.mediaPlaybackCurrentMediaTrack?.id,
        queueEntryId: mediaPlayer.mediaPlaybackCurrentMediaTrack?.queue_entry_id,
        remoteOutputRequested: DlnaService.isRemoteOutputRequested(),
        selectedRendererId: dlnaState.selectedRendererId,
        rendererDevices: dlnaState.rendererDevices,
      };
    };
    const emitStateIfChanged = (reason: string) => {
      const snapshot = getStateSnapshot();
      const hash = JSON.stringify(snapshot);
      if (hash === lastStateHash) {
        return;
      }
      lastStateHash = hash;
      pushDiagEvent('ui_state', {
        reason,
        snapshot,
      });
    };
    emitStateIfChanged('init');
    const diagnosticsApi = {
      run: async (action: string) => {
        const normalizedAction = String(action || '').toLowerCase();
        const mediaPlayerSnapshot = store.getState().mediaPlayer;
        const hasCurrentTrack = !!mediaPlayerSnapshot.mediaPlaybackCurrentMediaTrack;
        pushDiagEvent('ui_action_requested', {
          action: normalizedAction,
          hasCurrentTrack,
        });
        if (normalizedAction === 'remote_on') {
          await DlnaService.refreshRendererDevices();
          const dlnaState = DlnaService.getState();
          const rendererDevices = dlnaState.rendererDevices || [];
          const preferredRenderer = rendererDevices
            .find(renderer => String(renderer.name || '').toLowerCase().includes('aurora pulse launcher'))
            || rendererDevices.find(renderer => String(renderer.id || '') === String(dlnaState.selectedRendererId || ''))
            || rendererDevices[0];
          if (!preferredRenderer?.id) {
            pushDiagEvent('ui_action_result', {
              action: normalizedAction,
              ok: false,
              reason: 'renderer_not_found',
            });
            return {
              ok: false,
              reason: 'renderer_not_found',
            };
          }
          await DlnaService.setOutputDevice(preferredRenderer.id);
          emitStateIfChanged('remote_on');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
          });
          return {
            ok: true,
          };
        }
        if (normalizedAction === 'remote_off') {
          await DlnaService.setOutputDevice('local');
          emitStateIfChanged('remote_off');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
          });
          return {
            ok: true,
          };
        }
        if (normalizedAction === 'play') {
          MediaPlayerService.resumeMediaPlayer();
          emitStateIfChanged('play');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          });
          return {
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          };
        }
        if (normalizedAction === 'pause') {
          MediaPlayerService.pauseMediaPlayer();
          emitStateIfChanged('pause');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          });
          return {
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          };
        }
        if (normalizedAction === 'stop') {
          MediaPlayerService.stopMediaPlayer();
          emitStateIfChanged('stop');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          });
          return {
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          };
        }
        if (normalizedAction === 'next') {
          MediaPlayerService.playNextTrack();
          emitStateIfChanged('next');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
          });
          return {
            ok: true,
          };
        }
        if (normalizedAction === 'previous') {
          MediaPlayerService.playPreviousTrack(true);
          emitStateIfChanged('previous');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
          });
          return {
            ok: true,
          };
        }
        if (normalizedAction === 'play_pause') {
          MediaPlayerService.toggleMediaPlayback();
          emitStateIfChanged('play_pause');
          pushDiagEvent('ui_action_result', {
            action: normalizedAction,
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          });
          return {
            ok: true,
            hadCurrentTrack: hasCurrentTrack,
          };
        }
        pushDiagEvent('ui_action_result', {
          action: normalizedAction,
          ok: false,
          reason: 'unsupported_action',
        });
        return {
          ok: false,
          reason: 'unsupported_action',
        };
      },
      state: () => getStateSnapshot(),
      events: (sinceSeq?: number, limit?: number) => {
        const normalizedSinceSeq = Number(sinceSeq || 0);
        const normalizedLimit = Math.max(1, Math.min(2000, Number(limit || 500)));
        const filtered = diagEvents.filter(entry => entry.seq > normalizedSinceSeq);
        const sliced = filtered.slice(Math.max(0, filtered.length - normalizedLimit));
        return {
          latestSeq: diagSequence,
          events: sliced,
        };
      },
      clearEvents: () => {
        diagEvents.splice(0, diagEvents.length);
        return {
          ok: true,
        };
      },
    };
    const unsubscribeStore = store.subscribe(() => {
      emitStateIfChanged('store_update');
    });
    const unsubscribeDlna = DlnaService.subscribe((state) => {
      pushDiagEvent('dlna_state', {
        outputMode: state.outputMode,
        selectedRendererId: state.selectedRendererId,
        rendererCount: state.rendererDevices.length,
      });
      emitStateIfChanged('dlna_state');
    });
    const diagnosticsKey = 'auroraDiagBridge';
    (window as any)[diagnosticsKey] = diagnosticsApi;
    return () => {
      unsubscribeStore();
      unsubscribeDlna();
      if ((window as any)[diagnosticsKey] === diagnosticsApi) {
        delete (window as any)[diagnosticsKey];
      }
    };
  }, []);

  return (
    <div className={cx('app-stage')}>
      <Sidebar/>
      <Browser/>
    </div>
  );
}

// app > player

function Player({ active = false }: { active: boolean }) {
  return (
    <div className={cx('app-player', {
      active,
    })}
    >
      <MediaSession/>
      <MediaPlayer onShowAlbum={openAlbumSideView}/>
    </div>
  );
}

// app > stage, player

function Window() {
  const playerIsActive = true;

  return (
    <Router>
      <NotificationProvider snackbarSx={{
        bottom: playerIsActive ? '110px !important' : undefined, // TODO: Hack to keep it floating above player
      }}
      >
        <ModalProvider>
          <ContextMenuProvider>
            <Stage/>
            <Player active={playerIsActive}/>
            <GlobalMediaSideView/>
          </ContextMenuProvider>
        </ModalProvider>
      </NotificationProvider>
    </Router>
  );
}

// app > columns [splash | window]

export function App() {
  const [appStateIsLoading, setAppStateIsLoading] = useState<boolean>(true);
  const [, setLocaleVersion] = useState(0);

  useEffect(() => {
    const onLocaleChanged = () => {
      setLocaleVersion(localeVersion => localeVersion + 1);
    };

    window.addEventListener('aurora:locale-changed', onLocaleChanged);
    return () => {
      window.removeEventListener('aurora:locale-changed', onLocaleChanged);
    };
  }, []);

  useEffect(() => {
    setAppStateIsLoading(true);

    ThemeService.initialize();
    I18nService.initialize();
    EqualizerService.initialize();
    DlnaService.initialize();
    BitPerfectService.initialize();
    UpdateService.initialize();

    // register media providers
    const mediaLocalProvider = new MediaLocalProvider();
    MediaProviderService.registerMediaProvider(mediaLocalProvider);

    // register state persistors
    _.forEach(statePersistors, (statePersistor: IAppStatePersistor, stateKey: string) => {
      registerStatePersistor(stateKey, statePersistor);
    });

    loadState(store)
      .then(() => {
        setAppStateIsLoading(false);
      })
      .catch((error) => {
        throw new Error(`App encountered error while loading state - ${error.message}`);
      });
  }, []);

  return (
    <div className={cx('app')}>
      <Provider store={store}>
        {appStateIsLoading && (
          <Splash/>
        )}
        {!appStateIsLoading && (
          <Window/>
        )}
      </Provider>
    </div>
  );
}
