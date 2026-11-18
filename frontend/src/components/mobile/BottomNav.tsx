import { NavLink } from 'react-router-dom';
import { cx } from '../../lib/format';
import { Icon } from '../icons';

export interface BottomNavItem {
  to: string;
  label: string;
  icon: string;
  badge?: number;
}

/**
 * Mobile app tab bar: four main screens plus "More", which opens the full
 * navigation drawer. Sits above the home indicator (safe area).
 */
export function BottomNav({ items, onMore, moreBadge }: { items: BottomNavItem[]; onMore: () => void; moreBadge?: number }) {
  return (
    <nav
      aria-label="Main"
      className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-surface/95 backdrop-blur safe-bottom"
    >
      <div className="mx-auto flex max-w-lg">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => cx(
              'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium select-none',
              isActive ? 'text-brand-700' : 'text-ink-500',
            )}
          >
            {({ isActive }) => (
              <>
                <span className={cx('flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-brand-50')}>
                  <Icon name={item.icon} size={20} />
                </span>
                <span className="max-w-full truncate px-1">{item.label}</span>
                {Boolean(item.badge) && <Dot value={item.badge!} />}
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={onMore}
          className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-500 select-none"
        >
          <span className="flex h-7 w-12 items-center justify-center rounded-full">
            <Icon name="menu" size={20} />
          </span>
          <span>More</span>
          {Boolean(moreBadge) && <Dot value={moreBadge!} />}
        </button>
      </div>
    </nav>
  );
}

function Dot({ value }: { value: number }) {
  return (
    <span className="absolute right-[calc(50%-1.4rem)] top-1.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
      {value > 99 ? '99+' : value}
    </span>
  );
}
