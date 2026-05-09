import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import ReactDOM from 'react-dom';
import classNames from 'classnames/bind';

import { Icons } from '../../constants';
import { Icon } from '../icon/icon.component';
import { Button } from '../button/button.component';

import styles from './overflow-menu.component.css';

const cx = classNames.bind(styles);

export interface OverflowMenuItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  onAction: () => void;
}

/**
 * Positions a fixed dropdown below (or above if no space) a trigger element.
 */
function useDropdownPosition(triggerRef: React.RefObject<HTMLElement>, isOpen: boolean) {
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const dropdownEstimatedHeight = 200;

      // Check if there is space below, otherwise render above
      const spaceBelow = viewportHeight - rect.bottom;
      const renderAbove = spaceBelow < dropdownEstimatedHeight && rect.top > dropdownEstimatedHeight;

      setStyle({
        top: renderAbove ? undefined : `${rect.bottom + 6}px`,
        bottom: renderAbove ? `${viewportHeight - rect.top + 6}px` : undefined,
        right: `${Math.max(8, window.innerWidth - rect.right)}px`,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, triggerRef]);

  return style;
}

/**
 * A responsive overflow menu that shows a chevron/ellipsis button
 * when the container is too small to show all items inline.
 * Items that overflow are moved into a dropdown menu rendered as a portal.
 */
export function OverflowMenu(props: {
  items: OverflowMenuItem[];
  className?: string;
}) {
  const { items, className } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownStyle = useDropdownPosition(triggerRef, isOpen);

  const calculateVisibleItems = useCallback(() => {
    const container = containerRef.current;
    const itemsContainer = itemsRef.current;
    if (!container || !itemsContainer) return;

    const containerWidth = container.offsetWidth;
    const children = Array.from(itemsContainer.children) as HTMLElement[];
    const chevronButtonWidth = 40;

    let totalWidth = 0;
    let count = 0;

    for (const child of children) {
      child.style.display = '';
      const childWidth = child.offsetWidth + 8;
      if (totalWidth + childWidth + chevronButtonWidth > containerWidth && count < children.length) {
        break;
      }
      totalWidth += childWidth;
      count++;
    }

    if (count === children.length) {
      const allFit = totalWidth <= containerWidth;
      setVisibleCount(allFit ? children.length : Math.max(0, count - 1));
    } else {
      setVisibleCount(count);
    }
  }, []);

  useEffect(() => {
    calculateVisibleItems();

    const observer = new ResizeObserver(() => {
      calculateVisibleItems();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [calculateVisibleItems, items.length]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return () => {};

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target)
        && triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const overflowItems = items.slice(visibleCount);
  const hasOverflow = overflowItems.length > 0;

  const dropdown = isOpen && hasOverflow ? ReactDOM.createPortal(
    <div
      ref={dropdownRef}
      className={cx('overflow-menu-dropdown')}
      style={dropdownStyle}
    >
      {overflowItems.map(item => (
        <button
          key={item.id}
          type="button"
          className={cx('overflow-menu-dropdown-item')}
          disabled={item.disabled}
          onClick={() => {
            item.onAction();
            setIsOpen(false);
          }}
        >
          {item.icon && (
            <span className={cx('overflow-menu-dropdown-item-icon')}>
              <Icon name={item.icon}/>
            </span>
          )}
          <span className={cx('overflow-menu-dropdown-item-label')}>
            {item.label}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={containerRef} className={cx('overflow-menu-container', className)}>
      <div ref={itemsRef} className={cx('overflow-menu-items')}>
        {items.map((item, index) => (
          <div
            key={item.id}
            className={cx('overflow-menu-item-wrapper')}
            style={{ display: index < visibleCount ? '' : 'none' }}
          >
            <Button
              variant={['rounded', 'outline']}
              tooltip={item.label}
              disabled={item.disabled}
              onButtonSubmit={item.onAction}
            >
              {item.icon && <Icon name={item.icon}/>}
              {!item.icon && <span>{item.label}</span>}
            </Button>
          </div>
        ))}
      </div>
      {hasOverflow && (
        <div ref={triggerRef} className={cx('overflow-menu-chevron-wrapper')}>
          <Button
            variant={['rounded', 'outline']}
            className={cx('overflow-menu-chevron-button', { open: isOpen })}
            onButtonSubmit={() => setIsOpen(!isOpen)}
            tooltip="Mehr"
          >
            <Icon name={Icons.MoreVertical}/>
          </Button>
        </div>
      )}
      {dropdown}
    </div>
  );
}

/**
 * A responsive navigation list that shows a chevron dropdown
 * when navigation tabs overflow the available space.
 * The dropdown is rendered as a portal at the top z-index.
 */
export function OverflowNavigationList(props: {
  children: React.ReactNode;
  className?: string;
}) {
  const { children, className } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [hiddenIndices, setHiddenIndices] = useState<number[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownStyle = useDropdownPosition(triggerRef, isOpen);

  const calculateOverflow = useCallback(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const containerWidth = container.offsetWidth;
    const childElements = Array.from(inner.children) as HTMLElement[];
    const chevronButtonWidth = 42;

    // Reset all to visible for measuring
    childElements.forEach((child) => {
      child.style.visibility = 'visible';
      child.style.position = 'static';
      child.style.width = '';
      child.style.height = '';
      child.style.overflow = '';
    });

    let totalWidth = 0;
    const hidden: number[] = [];

    for (let i = 0; i < childElements.length; i++) {
      const childWidth = childElements[i].offsetWidth + 8;
      if (totalWidth + childWidth + (i < childElements.length - 1 ? chevronButtonWidth : 0) > containerWidth) {
        hidden.push(i);
        childElements[i].style.visibility = 'hidden';
        childElements[i].style.position = 'absolute';
        childElements[i].style.width = '0';
        childElements[i].style.height = '0';
        childElements[i].style.overflow = 'hidden';
      } else {
        totalWidth += childWidth;
      }
    }

    setHiddenIndices(hidden);
    setHasOverflow(hidden.length > 0);
  }, []);

  useEffect(() => {
    calculateOverflow();

    const observer = new ResizeObserver(() => {
      calculateOverflow();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [calculateOverflow, children]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return () => {};

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target)
        && triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const childArray = React.Children.toArray(children);

  const dropdown = isOpen && hasOverflow ? ReactDOM.createPortal(
    <div
      ref={dropdownRef}
      className={cx('overflow-nav-dropdown')}
      style={dropdownStyle}
    >
      {hiddenIndices.map((idx) => {
        const child = childArray[idx];
        if (!child) return null;
        return (
          <div
            key={idx}
            className={cx('overflow-nav-dropdown-item')}
            onClick={() => setIsOpen(false)}
          >
            {child}
          </div>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={containerRef} className={cx('overflow-nav-container', className)}>
      <div ref={innerRef} className={cx('overflow-nav-inner')}>
        {children}
      </div>
      {hasOverflow && (
        <div ref={triggerRef} className={cx('overflow-nav-chevron-wrapper')}>
          <Button
            variant={['rounded', 'outline']}
            className={cx('overflow-nav-chevron-button', { open: isOpen })}
            onButtonSubmit={() => setIsOpen(!isOpen)}
            tooltip="Mehr"
          >
            <Icon name={Icons.ChevronDown}/>
          </Button>
        </div>
      )}
      {dropdown}
    </div>
  );
}
