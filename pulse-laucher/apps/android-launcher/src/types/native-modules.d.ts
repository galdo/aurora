export interface IInstalledLauncherApp {
  appName: string;
  packageName: string;
  iconUri?: string;
}

export interface IPulseLauncherAppsModule {
  getInstalledApps: () => Promise<IInstalledLauncherApp[]>;
  launchApp: (packageName: string) => Promise<boolean>;
}

export interface ILauncherSectionItem {
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  collectionType?: string;
}

export interface ILauncherSection {
  id: string;
  title: string;
  items: ILauncherSectionItem[];
}

export interface IPulseMediaLibraryModule {
  getSections: (route: string) => Promise<ILauncherSection[]>;
  getPinnedItems: () => Promise<string[]>;
  getPinnedRecords: () => Promise<{
    collection_item_id: string;
    collection_item_type: string;
    order: number;
    pinned_at: number;
    title: string;
  }[]>;
  togglePinnedItem: (itemId: string, itemType: string, title: string) => Promise<boolean>;
  updatePinnedOrder: (orderedKeys: string[]) => Promise<boolean>;
  getPodcastUpdates: () => Promise<number>;
}
