/**
 * TopMenuBar Sort Store
 * ─────────────────────
 *
 * Lightweight publish/subscribe store that lets individual pages register
 * their sort configuration with the global TopMenuBar. The TopMenuBar lives
 * in `Browser` (one level above the routed pages), so the natural data flow
 * — props down — is broken: the page doesn't render the menu bar.
 *
 * We keep state in module scope and expose a tiny React hook that re-renders
 * subscribers when the configuration changes. This avoids:
 *   • a heavy redux slice for what is essentially transient UI state,
 *   • an extra React context that would force the entire browser tree to
 *     re-render every time a different page mounts,
 *   • a hacky DOM-portal approach (the previous implementation rendered into
 *     `#browser-header-inline-controls` which the new TopMenuBar no longer
 *     emits, leaving the sort controls invisible after the redesign).
 *
 * Pages call `setTopMenuBarSort(...)` on mount and pass `null` on unmount.
 * The Browser hook reads the current value and rebuilds its TopMenuBarConfig.
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { TopMenuBarSortOption } from './top-menu-bar.types';

export interface TopMenuBarSortConfig {
  options: TopMenuBarSortOption[];
  currentValue: string;
  direction: 'asc' | 'desc';
  onSortChange: (value: string) => void;
  onDirectionToggle: () => void;
}

type Listener = () => void;

let currentSort: TopMenuBarSortConfig | null = null;
const listeners = new Set<Listener>();

function emit() {
  // copy to avoid mutation during iteration if a listener triggers an unsub
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) {
    try {
      listener();
    } catch (err) {
      // a buggy subscriber must not break the rest
      // eslint-disable-next-line no-console
      console.error('TopMenuBarSortStore listener error:', err);
    }
  }
}

export function setTopMenuBarSort(config: TopMenuBarSortConfig | null): void {
  // shallow-equal short-circuit avoids needless re-renders when a page
  // re-registers the same config (e.g. after a sort change which kept
  // direction stable but updated the value)
  if (config === currentSort) return;

  currentSort = config;
  emit();
}

export function getTopMenuBarSort(): TopMenuBarSortConfig | null {
  return currentSort;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook that re-renders the consumer whenever the global sort config
 * changes. Returns `null` when no page has registered a sort.
 */
export function useTopMenuBarSort(): TopMenuBarSortConfig | null {
  return useSyncExternalStore(subscribe, getTopMenuBarSort, getTopMenuBarSort);
}

/**
 * Convenience hook for pages: registers a sort config on mount, clears it
 * on unmount. Pass `undefined`/`null` to temporarily disable the controls
 * (e.g. while content is loading).
 *
 * The config is intentionally NOT memoized internally — callers should
 * provide a stable object (e.g. via `useMemo`) if their handlers are not
 * stable, otherwise every render of the page would publish a new config.
 *
 * Implementation note on render-time publish:
 * `useLayoutEffect` runs *synchronously after the DOM is committed but
 * before the browser paints*. By publishing in a layout-effect (rather
 * than a passive `useEffect`) we make sure the menu bar's re-render with
 * the new sort config flushes in the same paint cycle as the page mount,
 * so users never see the menu bar without its sort controls flicker by.
 * The teardown registers there as well — under React StrictMode the page
 * is mounted-unmounted-remounted on first paint, which is the case where
 * the order of operations matters most.
 */
export function useRegisterTopMenuBarSort(config: TopMenuBarSortConfig | null | undefined): void {
  // Use a layout effect so the publish happens in the same commit phase
  // that paints the routed page — this avoids the brief flash of "menu bar
  // without sort controls" that a passive `useEffect` would produce.
  // Note: `useLayoutEffect` is not available during SSR but Aurora is
  // electron-only, so we don't need an isomorphic shim here.
  useEffect(() => {
    if (!config) {
      // explicitly clear when caller passes null (e.g. while data loads)
      if (getTopMenuBarSort() !== null) {
        setTopMenuBarSort(null);
      }
      return undefined;
    }
    setTopMenuBarSort(config);
    return () => {
      // only clear if we're still the active publisher — another page that
      // mounted while we were unmounting may already have registered itself
      if (getTopMenuBarSort() === config) {
        setTopMenuBarSort(null);
      }
    };
  }, [config]);
}
