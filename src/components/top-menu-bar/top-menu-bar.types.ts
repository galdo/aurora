/**
 * TopMenuBar — Configurable top menu bar component types.
 *
 * Each view declares which controls to show via TopMenuBarConfig.
 * The TopMenuBar measures available space and moves overflowing items
 * into a "More" (⋮) dropdown menu dynamically.
 */

export interface TopMenuBarSegment {
  id: string;
  label: string;
  isActive?: boolean;
  onSelect: () => void;
}

export interface TopMenuBarSortOption {
  value: string;
  label: string;
}

export interface TopMenuBarAction {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  onAction: () => void;
  /** If true, this action is always shown in the "More" menu, never inline */
  alwaysInMenu?: boolean;
  /** Priority for inline display (higher = shown first). Default: 0 */
  priority?: number;
}

export interface TopMenuBarConfig {
  /** Show back/forward navigation buttons */
  showNavigation?: boolean;
  /** Show search input */
  showSearch?: boolean;
  /** Segment switcher items (e.g. Titel/Künstler/Album/Playlist) */
  segments?: TopMenuBarSegment[];
  /** Sort controls */
  sort?: {
    options: TopMenuBarSortOption[];
    currentValue: string;
    direction: 'asc' | 'desc';
    onSortChange: (value: string) => void;
    onDirectionToggle: () => void;
  };
  /** Cover size slider */
  coverSize?: {
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
  };
  /** Action buttons (shuffle, sync, info, create, etc.) */
  actions?: TopMenuBarAction[];
  /** Whether to show zoom controls in the "More" menu */
  showZoom?: boolean;
}

export type OverflowState = {
  /** Which action IDs are currently overflowing into the menu */
  overflowedActionIds: Set<string>;
  /** Whether segments are overflowing */
  segmentsOverflowed: boolean;
  /** Whether sort/cover controls are overflowing */
  controlsOverflowed: boolean;
};
