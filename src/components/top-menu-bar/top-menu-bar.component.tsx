import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactDOM from 'react-dom';
import classNames from 'classnames/bind';
import { useHistory, useLocation } from 'react-router-dom';

import { Icons } from '../../constants';
import { I18nService } from '../../services';
import { Icon } from '../icon/icon.component';
import { Button } from '../button/button.component';
import { Slider } from '../slider/slider.component';

import { TopMenuBarConfig, TopMenuBarAction } from './top-menu-bar.types';

import styles from './top-menu-bar.component.css';

const cx = classNames.bind(styles);
const ZoomStorageKey = 'aurora:ui-zoom-factor';
const ZoomStep = 0.1;
const ZoomMin = 0.7;
const ZoomMax = 1.5;

/**
 * TopMenuBar — A fully configurable, responsive top navigation bar.
 *
 * Features:
 * - Configurable per-view (navigation, search, segments, sort, cover size, actions)
 * - Dynamic overflow: items that don't fit move into a "More" (⋮) dropdown
 * - OS-aware: reserves space for window controls (macOS traffic lights, Windows buttons)
 * - Fullscreen-aware: hides window control padding in fullscreen
 * - Portal-rendered dropdown at highest z-index
 */
export function TopMenuBar(props: { config: TopMenuBarConfig; children?: React.ReactNode }) {
  const { config, children } = props;
  const {
    showNavigation = true,
    showSearch = false,
    segments,
    sort,
    coverSize,
    actions = [],
    showZoom = true,
  } = config;

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const segmentsRef = useRef<HTMLDivElement>(null);
  // Overflow level: 0 = all inline, 1 = Info/Sync/Shuffle in menu, 2 = + Zoom, 3 = + Segments
  const [overflowLevel, setOverflowLevel] = useState(0);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const history = useHistory();
  const location = useLocation();

  // Derive isCompact from overflowLevel (for segments visibility)
  const isCompact = overflowLevel >= 3;

  // --- Staged overflow detection ---
  // Calculates the correct overflow level in ONE pass based on estimated element widths.
  // No incremental changes → no flicker.
  // Only runs on window resize / initial mount.
  useEffect(() => {
    const gap = 10;
    // Estimated widths of element groups (px)
    const navWidth = showNavigation ? 78 : 0;
    const searchWidth = showSearch ? 280 : 0;
    const segWidth = segments?.length ? (segments.length * 70 + 10) : 0; // ~70px per tab + padding
    const spacersWidth = segments?.length ? 20 : 0; // 2 spacers minimal width
    const actionsLevel0Width = actions.filter(a => !a.alwaysInMenu).length * 44; // each button ~44px
    const actionsLevel1Width = actions.filter(a => !a.alwaysInMenu && (a.priority || 0) >= 41).length * 44;
    const actionsLevel2Width = actions.filter(a => !a.alwaysInMenu && (a.priority || 0) >= 51).length * 44;
    const moreButtonWidth = 44;

    // Total width at each level:
    // Level 0: nav + search + spacers + segments + allActions (no more button)
    // Level 1: nav + search + spacers + segments + highPrioActions + moreButton
    // Level 2: nav + search + spacers + segments + zoomActions + moreButton
    // Level 3: nav + search + moreButton (segments hidden)
    const baseWidth = navWidth + searchWidth;
    const widthAtLevel0 = baseWidth + spacersWidth + segWidth + actionsLevel0Width + (actions.length > 0 ? (actions.filter(a => !a.alwaysInMenu).length - 1) * gap : 0);
    const widthAtLevel1 = baseWidth + spacersWidth + segWidth + actionsLevel1Width + moreButtonWidth;
    const widthAtLevel2 = baseWidth + spacersWidth + segWidth + actionsLevel2Width + moreButtonWidth;
    const widthAtLevel3 = baseWidth + moreButtonWidth;

    const calculateLevel = () => {
      const container = containerRef.current;
      if (!container) return;
      const availableWidth = container.clientWidth;
      if (availableWidth <= 0) return;

      const minWhitespace = availableWidth * 0.10; // 10% minimum whitespace

      let newLevel = 0;
      if (widthAtLevel0 + minWhitespace > availableWidth) newLevel = 1;
      if (widthAtLevel1 + minWhitespace > availableWidth) newLevel = 2;
      if (widthAtLevel2 + minWhitespace > availableWidth) newLevel = 3;

      setOverflowLevel(prev => (prev !== newLevel ? newLevel : prev));
    };

    calculateLevel();
    window.addEventListener('resize', calculateLevel);

    return () => {
      window.removeEventListener('resize', calculateLevel);
    };
  }, [segments, actions, showNavigation, showSearch]);

  // --- Menu positioning ---
  useEffect(() => {
    if (!isMenuOpen || !triggerRef.current) return;
    const updatePos = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vh = window.innerHeight;
      const below = vh - rect.bottom > 380;
      setMenuStyle({
        top: below ? `${rect.bottom + 6}px` : undefined,
        bottom: !below ? `${vh - rect.top + 6}px` : undefined,
        right: `${Math.max(8, window.innerWidth - rect.right)}px`,
      });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    return () => window.removeEventListener('resize', updatePos);
  }, [isMenuOpen]);

  // --- Close menu on outside click ---
  useEffect(() => {
    if (!isMenuOpen) return () => {};
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t) && triggerRef.current && !triggerRef.current.contains(t)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isMenuOpen]);

  // Close on route change
  useEffect(() => { setIsMenuOpen(false); }, [location.pathname]);

  // --- Navigation handlers ---
  const handleBack = useCallback(() => history.go(-1), [history]);
  const handleForward = useCallback(() => history.go(1), [history]);

  // --- Zoom handlers ---
  const handleZoomIn = useCallback(() => {
    const c = Number(localStorage.getItem(ZoomStorageKey) || '1');
    const n = Math.min(ZoomMax, Math.round((c + ZoomStep) * 100) / 100);
    localStorage.setItem(ZoomStorageKey, String(n));
    try { (window as any).require('electron').webFrame.setZoomFactor(n); } catch (e) {}
  }, []);

  const handleZoomOut = useCallback(() => {
    const c = Number(localStorage.getItem(ZoomStorageKey) || '1');
    const n = Math.max(ZoomMin, Math.round((c - ZoomStep) * 100) / 100);
    localStorage.setItem(ZoomStorageKey, String(n));
    try { (window as any).require('electron').webFrame.setZoomFactor(n); } catch (e) {}
  }, []);

  // --- Determine what's inline vs in menu based on overflow level ---
  // Level 0: all inline
  // Level 1: Info(10), Sync(30), Shuffle(40) → menu (priority <= 40)
  // Level 2: + Zoom out(50), Zoom in(45) → menu (priority <= 50)
  // Level 3: + Segments → menu
  const inlineActions = useMemo(() => {
    if (overflowLevel >= 3) return []; // All actions in menu at level 3
    const minPriorityToKeep = overflowLevel === 0 ? -1 : overflowLevel === 1 ? 41 : 51;
    return actions
      .filter(a => !a.alwaysInMenu && (a.priority || 0) >= minPriorityToKeep)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }, [actions, overflowLevel]);

  const menuActions = useMemo(() => {
    if (overflowLevel >= 3) return actions;
    if (overflowLevel === 0) return actions.filter(a => a.alwaysInMenu);
    const minPriorityToKeep = overflowLevel === 1 ? 41 : 51;
    return actions.filter(a => a.alwaysInMenu || (a.priority || 0) < minPriorityToKeep);
  }, [actions, overflowLevel]);

  const showSegmentsInline = overflowLevel < 3 && !!segments?.length;
  const showSortInline = overflowLevel < 3 && !!sort;
  const showCoverSizeInline = overflowLevel < 3 && !!coverSize;

  // --- Render the More dropdown ---
  const dropdown = isMenuOpen ? ReactDOM.createPortal(
    <div ref={menuRef} className={cx('tmb-dropdown')} style={menuStyle}>
      {/* Overflowed segments */}
      {isCompact && segments && segments.length > 0 && (
        <>
          <div className={cx('tmb-dropdown-section')}>{I18nService.getString('label_section_navigation')}</div>
          {segments.map(seg => (
            <button
              key={seg.id}
              type="button"
              className={cx('tmb-dropdown-item', { 'tmb-dropdown-item-active': seg.isActive })}
              onClick={() => { seg.onSelect(); setIsMenuOpen(false); }}
            >
              <span className={cx('tmb-dropdown-item-icon')}><Icon name={Icons.NavigationForward}/></span>
              <span className={cx('tmb-dropdown-item-label')}>{seg.label}</span>
            </button>
          ))}
          <div className={cx('tmb-dropdown-divider')}/>
        </>
      )}

      {/* Overflowed sort */}
      {isCompact && sort && (
        <>
          <div className={cx('tmb-dropdown-section')}>{I18nService.getString('label_section_sort')}</div>
          {sort.options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={cx('tmb-dropdown-item', { 'tmb-dropdown-item-active': sort.currentValue === opt.value })}
              onClick={() => { sort.onSortChange(opt.value); setIsMenuOpen(false); }}
            >
              <span className={cx('tmb-dropdown-item-icon')}>
                <Icon name={sort.currentValue === opt.value ? (sort.direction === 'asc' ? Icons.SortAsc : Icons.SortDesc) : Icons.NavigationForward}/>
              </span>
              <span className={cx('tmb-dropdown-item-label')}>{opt.label}</span>
            </button>
          ))}
          <div className={cx('tmb-dropdown-divider')}/>
        </>
      )}

      {/* Menu actions */}
      {menuActions.map(action => (
        <button
          key={action.id}
          type="button"
          className={cx('tmb-dropdown-item')}
          disabled={action.disabled}
          onClick={() => { action.onAction(); setIsMenuOpen(false); }}
        >
          <span className={cx('tmb-dropdown-item-icon')}><Icon name={action.icon}/></span>
          <span className={cx('tmb-dropdown-item-label')}>{action.label}</span>
        </button>
      ))}

      {/* Zoom */}
      {showZoom && (
        <>
          <div className={cx('tmb-dropdown-divider')}/>
          <button type="button" className={cx('tmb-dropdown-item')} onClick={() => { handleZoomIn(); }}>
            <span className={cx('tmb-dropdown-item-icon')}><Icon name={Icons.ZoomIn}/></span>
            <span className={cx('tmb-dropdown-item-label')}>{I18nService.getString('label_zoom_in')}</span>
          </button>
          <button type="button" className={cx('tmb-dropdown-item')} onClick={() => { handleZoomOut(); }}>
            <span className={cx('tmb-dropdown-item-icon')}><Icon name={Icons.ZoomOut}/></span>
            <span className={cx('tmb-dropdown-item-label')}>{I18nService.getString('label_zoom_out')}</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <div
      ref={containerRef}
      className={cx('tmb', 'app-window-drag')}
    >
      {/* Navigation */}
      {showNavigation && (
        <div className={cx('tmb-nav')}>
          <Button variant={['rounded', 'outline']} className={cx('tmb-nav-btn')} onButtonSubmit={handleBack}>
            <Icon name={Icons.NavigationBack}/>
          </Button>
          <Button variant={['rounded', 'outline']} className={cx('tmb-nav-btn')} onButtonSubmit={handleForward}>
            <Icon name={Icons.NavigationForward}/>
          </Button>
        </div>
      )}

      {/* Search slot — children are rendered here inline */}
      {showSearch && children && (
        <div ref={searchRef} className={cx('tmb-search')}>
          {children}
        </div>
      )}

      {/* Left spacer for centering segments */}
      {showSegmentsInline && <div className={cx('tmb-spacer')}/>}

      {/* Inline Segments — centered between search and actions */}
      {/* Always rendered for measurement, hidden via CSS when compact */}
      {segments && segments.length > 0 && (
        <div
          ref={segmentsRef}
          className={cx('tmb-segments')}
          style={isCompact ? { visibility: 'hidden', position: 'absolute', pointerEvents: 'none' } : undefined}
        >
          {segments.map(seg => (
            <button
              key={seg.id}
              type="button"
              className={cx('tmb-segment', { 'tmb-segment-active': seg.isActive })}
              onClick={seg.onSelect}
            >
              {seg.label}
            </button>
          ))}
        </div>
      )}

      {/* Right spacer for centering segments */}
      {showSegmentsInline && <div className={cx('tmb-spacer')}/>}

      {/* Inline Sort */}
      {showSortInline && sort && (
        <div className={cx('tmb-sort')}>
          <select
            className={cx('tmb-sort-select')}
            value={sort.currentValue}
            onChange={e => sort.onSortChange(e.target.value)}
          >
            {sort.options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <Button
            variant={['rounded', 'outline']}
            className={cx('tmb-sort-dir-btn')}
            onButtonSubmit={sort.onDirectionToggle}
            tooltip={sort.direction === 'asc' ? I18nService.getString('tooltip_sort_ascending') : I18nService.getString('tooltip_sort_descending')}
          >
            <Icon name={sort.direction === 'asc' ? Icons.SortAsc : Icons.SortDesc}/>
          </Button>
        </div>
      )}

      {/* Inline Cover Size */}
      {showCoverSizeInline && coverSize && (
        <div className={cx('tmb-cover-size')}>
          <Icon name={Icons.Image}/>
          <Slider
            className={cx('tmb-cover-slider')}
            min={coverSize.min}
            max={coverSize.max}
            value={coverSize.value}
            onSliderChange={coverSize.onChange}
          />
        </div>
      )}

      {/* Inline Actions */}
      {inlineActions.length > 0 && (
        <div className={cx('tmb-actions')}>
          {inlineActions.map(action => (
            <Button
              key={action.id}
              variant={['rounded', 'outline']}
              tooltip={action.label}
              disabled={action.disabled}
              onButtonSubmit={action.onAction}
            >
              <Icon name={action.icon}/>
            </Button>
          ))}
        </div>
      )}

      {/* More button (⋮) — only visible when overflowLevel > 0 (items are in menu) */}
      {overflowLevel > 0 && (
        <div ref={triggerRef} className={cx('tmb-more')}>
          <Button
            variant={['rounded', 'outline']}
            className={cx('tmb-more-btn', { open: isMenuOpen })}
            onButtonSubmit={() => setIsMenuOpen(!isMenuOpen)}
            tooltip={I18nService.getString('tooltip_more_menu')}
          >
            <Icon name={Icons.MoreVertical}/>
          </Button>
        </div>
      )}

      {dropdown}
    </div>
  );
}
