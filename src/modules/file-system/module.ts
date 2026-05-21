import fs from 'fs';
import { dialog, shell } from 'electron';
import { Entry, walkStream } from '@nodelib/fs.walk';
import path from 'path';
import { isEmpty } from 'lodash';

import {
  IAppMain,
  IAppModule,
} from '../../interfaces';

import {
  FSFile,
  FSReadAssetOptions,
  FSReadDirectoryParams,
  FSSelectFileOptions,
} from './types';

import { IPCCommChannel, IPCMain, IPCStream } from '../ipc';

const debug = require('debug')('aurora:module:file-system');

export class FileSystemModule implements IAppModule {
  private readonly app: IAppMain;

  constructor(app: IAppMain) {
    this.app = app;
    this.registerMessageHandlers();
  }

  private registerMessageHandlers() {
    IPCMain.addSyncMessageHandler(IPCCommChannel.FSReadAsset, this.readAsset, this);
    IPCMain.addSyncMessageHandler(IPCCommChannel.FSReadDirectoryStream, this.readDirectoryStream, this);
    IPCMain.addSyncMessageHandler(IPCCommChannel.FSReadFile, this.readFile, this);
    IPCMain.addSyncMessageHandler(IPCCommChannel.FSSelectDirectory, this.selectDirectory, this);
    IPCMain.addSyncMessageHandler(IPCCommChannel.FSSelectFile, this.selectFile, this);
    IPCMain.addSyncMessageHandler(IPCCommChannel.FSShowItemInFolder, this.showItemInFolder, this);
  }

  private readAsset(assetPath: string[], options?: FSReadAssetOptions) {
    const assetResourcePath = this.app.getAssetPath(...assetPath);
    return fs.readFileSync(assetResourcePath, options?.encoding);
  }

  private readDirectoryStream(eventId: string, params: FSReadDirectoryParams) {
    const { directory, fileExtensions } = params;
    const channels = IPCStream.composeChannels(IPCCommChannel.FSReadDirectoryStream, eventId);

    const rootPath = path.resolve(directory);
    const childFatalErrors = ['EIO', 'ENODEV', 'EBADF'];
    const batchSize = 100;
    let batch: FSFile[] = [];
    let finished = false;
    let abortListener: any;

    const sendBatch = () => {
      if (!batch.length) return;

      debug('readDirectoryStream - sending batch, eventId - %s, batchSize - %s', eventId, batch.length);
      this.app.sendMessageToRenderer(channels.data, { files: batch });
      batch = [];
    };

    const finalize = () => {
      if (finished) return;
      finished = true;

      debug('readDirectoryStream - finalizing, eventId - %s', eventId);

      sendBatch();
      this.app.sendMessageToRenderer(channels.complete);
      if (abortListener) IPCMain.removeMessageHandler(channels.abort, abortListener);
    };

    const entryFilter = (entry: Entry): boolean => {
      if (!entry.dirent.isFile()) return false;
      if (this.shouldIgnoreEntryByName(entry.name)) return false;
      if (!fileExtensions || isEmpty(fileExtensions)) return true;

      const i = entry.name.lastIndexOf('.');
      if (i === -1) return false;

      const ext = entry.name.slice(i + 1).toLowerCase();
      return fileExtensions.includes(ext);
    };

    const deepFilter = (entry: Entry): boolean => {
      if (!entry.dirent.isDirectory()) {
        return true;
      }
      return !this.shouldIgnoreEntryByName(entry.name);
    };

    const walker = walkStream(directory, {
      followSymbolicLinks: false,
      stats: true,
      throwErrorOnBrokenSymbolicLink: false,
      entryFilter,
      deepFilter,
    });

    // stream
    walker
      .on('data', (entry: Entry) => {
        batch.push({
          path: entry.path,
          name: path.basename(entry.path),
          stats: {
            mtime: entry.stats?.mtimeMs,
            size: entry.stats?.size,
          },
        });

        if (batch.length >= batchSize) {
          sendBatch();
        }
      })
      .on('error', (err: any) => {
        debug('readDirectoryStream - encountered error - %s', eventId);
        console.error(err);

        if (err.message !== 'Aborted') {
          // rules for fatal:
          // anything on root
          // or, EIO / ENODEV / EBADF on child
          // or, root becomes inaccessible
          const isFatal = (err.path && path.resolve(err.path) === rootPath)
            || childFatalErrors.includes(err.code)
            || !this.isDirectoryAccessible(rootPath);

          if (isFatal) {
            this.app.sendMessageToRenderer(channels.error, err);
            finalize();
          }
        }
      })
      .on('close', finalize)
      .on('end', finalize);

    // abort
    abortListener = () => {
      debug('readDirectoryStream - abort received - %s', eventId);
      walker.destroy(new Error('Aborted'));
    };

    IPCMain.addSyncMessageHandler(channels.abort, abortListener);
  }

  private readFile(filePath: string) {
    return fs.readFileSync(filePath);
  }

  private selectDirectory(): string | undefined {
    // prompt user to select a directory, showOpenDialogSync will either return string[] or undefined (in case user cancels the operation)
    // important - this will only select a single directory (openDirectory will make sure only single directory is allowed to be selected)
    // @see - https://www.electronjs.org/docs/api/dialog#dialogshowopendialogsyncbrowserwindow-options
    const fsSelectedDirectories = dialog.showOpenDialogSync(this.app.getCurrentWindow(), {
      properties: ['openDirectory'],
    });

    return fsSelectedDirectories ? fsSelectedDirectories[0] : undefined;
  }

  private selectFile(options?: FSSelectFileOptions) {
    const selection = dialog.showOpenDialogSync(this.app.getCurrentWindow(), {
      title: options?.title || 'Select file',
      properties: ['openFile'],
      filters: [{ name: 'Selection', extensions: options?.extensions || ['*'] }],
    });

    return selection?.[0];
  }

  /**
   * Reveals the given file or folder in the operating system's file manager
   * (Finder on macOS, Explorer on Windows, default file manager on Linux).
   *
   * If `targetPath` points to a file, the file will be highlighted within its
   * containing folder. If it points to a directory, the directory itself will
   * be opened. Symlinks/missing paths are handled gracefully.
   *
   * @param targetPath absolute filesystem path to a file or directory
   * @returns true if the OS was instructed to reveal the path, false otherwise
   */
  private showItemInFolder(targetPath: string): boolean {
    if (!targetPath || typeof targetPath !== 'string') {
      debug('showItemInFolder - invalid path provided');
      return false;
    }

    try {
      const resolvedPath = path.resolve(targetPath);

      if (!fs.existsSync(resolvedPath)) {
        debug('showItemInFolder - path does not exist - %s', resolvedPath);
        return false;
      }

      const stats = fs.statSync(resolvedPath);
      if (stats.isDirectory()) {
        // for directories, open the directory itself in the file manager
        // (showItemInFolder would otherwise highlight the directory in its parent)
        // openPath returns an empty string on success, error message on failure
        shell.openPath(resolvedPath).then((errorMessage) => {
          if (errorMessage) {
            debug('showItemInFolder - openPath error - %s', errorMessage);
          }
        });
      } else {
        // for files, highlight the file inside its parent folder
        shell.showItemInFolder(resolvedPath);
      }

      return true;
    } catch (err) {
      debug('showItemInFolder - encountered error - %o', err);
      console.error('FileSystemModule.showItemInFolder error:', err);
      return false;
    }
  }

  private isDirectoryAccessible(directory: string): boolean {
    try {
      fs.readdirSync(directory);
      return true;
    } catch {
      return false;
    }
  }

  private shouldIgnoreEntryByName(entryName: string): boolean {
    const normalizedName = String(entryName || '');
    if (!normalizedName) {
      return false;
    }

    if (normalizedName.startsWith('._')) {
      return true;
    }

    if (process.platform === 'win32' || process.platform === 'linux') {
      return normalizedName.startsWith('.');
    }

    return false;
  }
}
