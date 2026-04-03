import { NativeModules, Platform } from 'react-native';

interface IFilePickerModule {
  pickAutoEqFile?: () => Promise<{ uri?: string; name?: string; content?: string } | null>;
}

const getModule = (): IFilePickerModule | undefined => {
  if (Platform.OS !== 'android') {
    return undefined;
  }
  return (NativeModules as Record<string, unknown>).PulseFilePickerModule as IFilePickerModule | undefined;
};

export const pickAutoEqFileNative = async (): Promise<{ uri: string; name?: string; content?: string } | null> => {
  const module = getModule();
  if (!module?.pickAutoEqFile) {
    return null;
  }
  const result = await module.pickAutoEqFile();
  if (!result?.uri) {
    return null;
  }
  return {
    uri: String(result.uri),
    name: result.name ? String(result.name) : undefined,
    content: result.content ? String(result.content) : undefined,
  };
};
