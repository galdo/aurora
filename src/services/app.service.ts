import { IPCCommChannel, IPCRenderer } from '../modules/ipc';

export type AppDetails = {
  display_name: string;
  version: string;
  build: string;
  platform: string;
  logs_path: string;
  media_hardware_shortcuts_registered?: boolean;
  media_hardware_shortcuts_accessibility_trusted?: boolean;
};

export class AppService {
  private static Details: AppDetails;

  static get details(): AppDetails {
    if (!this.Details) {
      this.Details = IPCRenderer.sendSyncMessage(IPCCommChannel.AppReadDetails);
    }

    return this.Details;
  }

  static resetAppData(): void {
    localStorage.clear();
    sessionStorage.clear();
    IPCRenderer.sendSyncMessage(IPCCommChannel.AppResetSettings);
  }
}
