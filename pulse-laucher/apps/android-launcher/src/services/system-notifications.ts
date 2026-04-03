import { Linking, NativeEventEmitter, NativeModules } from 'react-native';

type ISystemNotificationNativeItem = {
  notificationKey: string;
  packageName: string;
  appName: string;
  title: string;
  message: string;
};

type ISystemNotificationSnapshotEvent = {
  items: ISystemNotificationNativeItem[];
};

const { PulseNotificationModule } = NativeModules;
const emitter = PulseNotificationModule ? new NativeEventEmitter(PulseNotificationModule) : undefined;

export const notificationEvents = {
  addPostedListener: (listener: (item: ISystemNotificationNativeItem) => void) => (
    emitter?.addListener('SYSTEM_NOTIFICATION_POSTED', listener)
  ),
  addRemovedListener: (listener: (payload: { notificationKey: string }) => void) => (
    emitter?.addListener('SYSTEM_NOTIFICATION_REMOVED', listener)
  ),
  addSnapshotListener: (listener: (payload: ISystemNotificationSnapshotEvent) => void) => (
    emitter?.addListener('SYSTEM_NOTIFICATION_SNAPSHOT', listener)
  ),
};

export const isNotificationAccessGranted = async (): Promise<boolean> => {
  if (!PulseNotificationModule) {
    return false;
  }
  return Boolean(await PulseNotificationModule.isNotificationAccessGranted());
};

export const openNotificationAccessSettings = async (): Promise<boolean> => {
  if (PulseNotificationModule) {
    const openedNative = Boolean(await PulseNotificationModule.openNotificationAccessSettings());
    if (openedNative) {
      return true;
    }
  }
  try {
    await Linking.openSettings();
    return true;
  } catch (_error) {
    return false;
  }
};

export const getCurrentNotifications = async (): Promise<ISystemNotificationNativeItem[]> => {
  if (!PulseNotificationModule || typeof PulseNotificationModule.getCurrentNotifications !== 'function') {
    return [];
  }
  const items = await PulseNotificationModule.getCurrentNotifications();
  if (!Array.isArray(items)) {
    return [];
  }
  return items as ISystemNotificationNativeItem[];
};

export const clearAllNotifications = async (): Promise<boolean> => {
  if (!PulseNotificationModule || typeof PulseNotificationModule.clearAllNotifications !== 'function') {
    return false;
  }
  return Boolean(await PulseNotificationModule.clearAllNotifications());
};

export type { ISystemNotificationNativeItem };
