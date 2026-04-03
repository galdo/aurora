import { ContentRoute, ILauncherSection, IMenuEntry } from '../models/launcher';

export const burgerMenuEntries: IMenuEntry[] = [
  { key: 'library', label: 'Musik', subtitle: 'Titel, Alben, Künstler, Playlists', icon: '◈' },
  { key: 'podcasts', label: 'Podcasts', subtitle: 'Neue Folgen und Abo-Feed', icon: '◎' },
  { key: 'apps', label: 'Apps', subtitle: 'Installierte Android Apps', icon: '▦' },
  { key: 'equalizer', label: 'Equalizer', subtitle: 'Klangprofile und Frequenz', icon: '≋' },
  { key: 'settings', label: 'Settings', subtitle: 'Gerät und Player', icon: '⚙' },
];

export const pinnedEntries = [
];

const emptySection = (title: string): ILauncherSection[] => [
  {
    id: `${title.toLowerCase()}-empty`,
    title,
    items: [],
  },
];

export const routeSections = (route: ContentRoute): ILauncherSection[] => {
  if (route === 'library') {
    return emptySection('Sammlung');
  }
  if (route === 'albums') {
    return emptySection('Alben');
  }
  if (route === 'playlists') {
    return emptySection('Playlists');
  }
  if (route === 'artists') {
    return emptySection('Künstler');
  }
  if (route === 'podcasts') {
    return emptySection('Podcasts');
  }
  if (route === 'equalizer') {
    return [
      {
        id: 'equalizer-presets',
        title: 'Equalizer Presets',
        items: [
          { id: 'eq-flat', title: 'Flat', subtitle: 'Neutrales Profil', meta: '0 dB', collectionType: 'setting' },
          { id: 'eq-warm', title: 'Warm', subtitle: 'Bass leicht angehoben', meta: '+2 dB', collectionType: 'setting' },
          { id: 'eq-vocal', title: 'Vocal', subtitle: 'Mittenfokus für Stimmen', meta: '+3 dB', collectionType: 'setting' },
          { id: 'eq-live', title: 'Live', subtitle: 'Breitere Bühne', meta: '+1 dB', collectionType: 'setting' },
        ],
      },
    ];
  }
  if (route === 'settings') {
    return [
      {
        id: 'settings-system',
        title: 'System',
        items: [
          { id: 'set-media-library', title: 'Musikbibliothek importieren', subtitle: 'Audio-Berechtigung und Medienindex', meta: 'Einrichten', collectionType: 'setting' },
          { id: 'set-equalizer', title: 'Equalizer', subtitle: '10-Band und Parametric EQ', meta: 'Konfigurieren', collectionType: 'setting' },
          { id: 'set-audio', title: 'Audioausgabe', subtitle: 'Lokale Ausgabe und DLNA', meta: 'Auto', collectionType: 'setting' },
          { id: 'set-bitperfect', title: 'Bit-Perfect', subtitle: 'DSD Modus', meta: 'Ein' },
          { id: 'set-sync', title: 'DAP Sync', subtitle: 'Geräte-Synchronisierung', meta: 'Bereit' },
          { id: 'set-default-launcher', title: 'Standard-Launcher', subtitle: 'Android Home-App festlegen', meta: 'Dialog öffnen', collectionType: 'setting' },
        ],
      },
    ];
  }
  return [];
};

export const routeHeading = (route: ContentRoute): string => {
  const found = burgerMenuEntries.find((entry) => entry.key === route);
  return found ? found.label : 'Bibliothek';
};

export const routeSubtitle = (route: ContentRoute): string => {
  if (route === 'library') {
    return 'Musikfokus mit Direktstart';
  }
  if (route === 'apps') {
    return 'Android App Launcher';
  }
  if (route === 'podcasts') {
    return 'Podcasts mit neue Inhalte Marker';
  }
  if (route === 'settings') {
    return 'Aurora Pulse Einstellungen';
  }
  if (route === 'equalizer') {
    return 'Klangprofil für den Player';
  }
  return 'Aurora Pulse Musikansicht';
};
