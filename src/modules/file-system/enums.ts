export enum FSAudioExtension {
  FLAC = 'flac',
  MP3 = 'mp3',
  M4A = 'm4a',
  WAV = 'wav',
  DSF = 'dsf',
  DFF = 'dff',
}

export enum FSImageExtension {
  JPG = 'jpg',
  JPEG = 'jpeg',
  PNG = 'png',
  WEBP = 'webp',
}

export const FSAudioExtensions = Object.values(FSAudioExtension);

export const FSImageExtensions = Object.values(FSImageExtension);
