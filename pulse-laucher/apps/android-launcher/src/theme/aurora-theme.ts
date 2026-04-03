export type AuroraThemeMode = 'dark' | 'light';

const sharedRadius = {
  card: 14,
  cardLarge: 18,
  button: 10,
};

export const getAuroraTheme = (mode: AuroraThemeMode = 'dark') => {
  if (mode === 'light') {
    return {
      mode,
      colors: {
        stageBackground: '#f4f7fb',
        stageContent: '#ffffff',
        stageOverlay: '#eef3f8',
        stageHighlight: '#e3f4ea',
        outline: '#d4dce5',
        outlineSoft: '#c7d2de',
        textPrimary: '#13202b',
        textSecondary: '#3d556b',
        textMuted: '#688097',
        accent: '#12a054',
        accentPressed: '#0c8042',
        warning: '#ffc107',
      },
      radius: sharedRadius,
    };
  }

  return {
    mode,
    colors: {
      stageBackground: '#101418',
      stageContent: '#1a2128',
      stageOverlay: '#141a21',
      stageHighlight: '#20352a',
      outline: '#28323b',
      outlineSoft: '#33414d',
      textPrimary: '#f2f5f7',
      textSecondary: '#b4c0ca',
      textMuted: '#8a98a5',
      accent: '#17a554',
      accentPressed: '#128343',
      warning: '#ffc107',
    },
    radius: sharedRadius,
  };
};
