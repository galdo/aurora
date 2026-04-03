import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Network from 'expo-network';

export interface ISystemBridgeSnapshot {
  deviceName: string;
  osVersion: string;
  batteryPercent?: number;
  isCharging?: boolean;
  networkType?: string;
  isConnected?: boolean;
}

const normalizeNetworkType = (value: Network.NetworkStateType | null): string => {
  if (!value || value === Network.NetworkStateType.UNKNOWN) {
    return 'Unknown';
  }
  return String(value).toUpperCase();
};

export const loadSystemBridgeSnapshot = async (): Promise<ISystemBridgeSnapshot> => {
  const [batteryLevel, batteryState, networkState] = await Promise.all([
    Battery.getBatteryLevelAsync().catch(() => undefined),
    Battery.getBatteryStateAsync().catch(() => undefined),
    Network.getNetworkStateAsync().catch(() => undefined),
  ]);

  return {
    deviceName: String(Device.deviceName || Device.modelName || 'Android Device'),
    osVersion: String(Device.osVersion || Device.platformApiLevel || 'Android'),
    batteryPercent: typeof batteryLevel === 'number' ? Math.round(batteryLevel * 100) : undefined,
    isCharging: batteryState === Battery.BatteryState.CHARGING || batteryState === Battery.BatteryState.FULL,
    networkType: normalizeNetworkType(networkState?.type || null),
    isConnected: networkState?.isConnected ?? undefined,
  };
};
