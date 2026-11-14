import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime } from '../contexts/RealtimeContext';
import { api, errorMessage } from '../lib/api';
import { cx, formatTime, relativeTime } from '../lib/format';
import { Avatar, Badge, EmptyState } from './ui';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon } from './icons';
import type { NotificationItem } from '../lib/types';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  show: boolean;
  badge?: number;
}

export function AppShell() {
  const { user, logout, has, canAny, unreadNotifications, setUnreadNotifications } = useAuth();
  const { connected, onlineIds } = useRealtime();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [search, setSearch] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const nav: { label: string; items: NavItem[] }[] = useMemo(
    () => [
      {
        label: 'Workspace',
        items: [
          { to: '/', label: 'Dashboard', icon: 'dashboard', show: has('dashboard.view') },
          { to: '/attendance', label: 'Attendance', icon: 'clock', show: true },
          { to: '/tasks', label: 'Tasks', icon: 'tasks', show: canAny('tasks.view.own', 'tasks.view.team', 'tasks.view.all') },
          { to: '/reports', label: 'Daily Reports', icon: 'report', show: canAny('reports.view.own', 'reports.view.team', 'reports.view.all') },
          { to: '/chat', label: 'Messages', icon: 'chat', show: has('chat.use') },
          { to: '/tickets', label: 'Tickets', icon: 'ticket', show: canAny('tickets.create', 'tickets.view.own', 'tickets.view.all') },
          { to: '/calendar', label: 'Calendar', icon: 'calendar', show: true },
          { to: '/meetings', label: 'Meetings', icon: 'video', show: true },
          { to: '/kpi', label: 'Performance', icon: 'kpi', show: has('kpi.view.own') },
          { to: '/leave', label: 'Leave', icon: 'leave', show: has('leave.apply') },
          { to: '/projects', label: 'Projects', icon: 'project', show: has('projects.view') },
        ],
      },
      {
        label: 'Administration',
        items: [
          {
            to: '/admin/employees',
            label: 'Employees',
            icon: 'users',
            show: canAny('employees.view.team', 'employees.view.all'),
          },
          { to: '/organization', label: 'Organisation', icon: 'org', show: true },
          { to: '/admin/organization', label: 'Organization data', icon: 'building', show: has('org.manage') },
          {
            to: '/analytics',
            label: 'Analytics',
            icon: 'chart',
            show: canAny('analytics.view', 'analytics.view.all', 'admin.dashboard'),
          },
          { to: '/admin/roles', label: 'Roles & Access', icon: 'shield', show: has('roles.manage') },
          {
            to: '/admin/email',
            label: 'Email delivery',
            icon: 'mail',
            show: canAny('settings.manage', 'admin.dashboard'),
          },
          {
            to: '/admin/settings',
            label: 'Settings & Audit',
            icon: 'settings',
            show: canAny('settings.manage', 'audit.view', 'admin.dashboard'),
          },
        ],
      },
    ],
    [has, canAny],
  );

  const activeTitle = useMemo(() => {
    const all = nav.flatMap((group) => group.items);
    const match = all.find((item) => (item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)));
    if (match) return match.label;
    if (location.pathname.startsWith('/meetings/')) return 'Meeting room';
    if (location.pathname.startsWith('/profile')) return 'My profile';
    if (location.pathname.startsWith('/notifications')) return 'Notifications';
    return 'Workforce';
  }, [location.pathname, nav]);

  useEffect(() => {
    setMobileOpen(false);
    setNotificationsOpen(false);
    setProfileOpen(false);
  }, [location.pathname]);

  const loadNotifications = async () => {
    try {
      const result = await api.get<{ items: NotificationItem[]; unread: number }>('/notifications?limit=12');
      setNotifications(result.items);
      setUnreadNotifications(result.unread);
    } catch {
      /* keep previous list */
    }
  };

  useEffect(() => {
    const handler = () => void loadNotifications();
    window.addEventListener('notifications:changed', handler);
    return () => window.removeEventListener('notifications:changed', handler);
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false);
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    if (!search.trim()) return;
    navigate(`/admin/employees?search=${encodeURIComponent(search.trim())}`);
    setSearch('');
  };

  if (!user) return null;

  const sidebar = (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-ink-900 text-white">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">W</span>
        <div>
          <p className="text-sm font-semibold leading-tight">Workforce</p>
          <p className="text-[11px] text-ink-400">Enterprise Suite</p>
        </div>
      </div>
      <nav className="scroll-area flex-1 space-y-6 px-3 pb-6">
        {nav.map((group) => {
          const items = group.items.filter((item) => item.show);
          if (items.length === 0) return null;
          return (
            <div key={group.label}>
              <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-ink-500">{group.label}</p>
              <div className="space-y-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => cx('nav-link', isActive && 'nav-link-active')}
                  >
                    <Icon name={item.icon} size={17} />
                    <span className="flex-1">{item.label}</span>
                    {item.to === '/chat' && user && (
                      <span className="text-[10px] text-ink-400">{onlineIds.length} online</span>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-3">
        <Link to="/profile" className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/10">
          <Avatar name={user.fullName} src={user.photoUrl} size={34} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{user.fullName}</p>
            <p className="truncate text-[11px] text-ink-400">{user.designationTitle ?? user.roleName}</p>
          </div>
        </Link>
        <button type="button" onClick={() => void logout()} className="nav-link mt-1 w-full">
          <Icon name="logout" size={17} />
          Sign out
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen bg-ink-100">
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64">{sidebar}</div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-ink-900/60" onClick={() => setMobileOpen(false)} aria-hidden />
          <div className="relative z-10 h-full">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:ml-64">
        <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button type="button" className="btn-ghost btn-sm lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Icon name="menu" size={20} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-900">{activeTitle}</p>
              <p className="hidden text-[11px] text-ink-400 sm:block">
                {user.departmentName ?? 'Organisation'} · {user.employeeCode}
              </p>
            </div>

            <form onSubmit={submitSearch} className="ml-auto hidden max-w-xs flex-1 md:block">
              <div className="relative">
                <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search employees…"
                  className="input pl-9 py-1.5 text-sm"
                  aria-label="Search employees"
                />
              </div>
            </form>

            <div className="ml-auto flex items-center gap-1.5 md:ml-0">
              <span
                className={cx('hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium sm:flex', connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}
                title={connected ? 'Realtime connected' : 'Reconnecting…'}
              >
                <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')} />
                {connected ? 'Live' : 'Reconnecting'}
              </span>

              <div className="relative" ref={panelRef}>
                <button
                  type="button"
                  className="btn-ghost relative"
                  aria-label="Notifications"
                  onClick={() => {
                    setNotificationsOpen((open) => !open);
                    if (!notificationsOpen) void loadNotifications();
                  }}
                >
                  <Icon name="bell" size={19} />
                  {unreadNotifications > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                      {unreadNotifications > 9 ? '9+' : unreadNotifications}
                    </span>
                  )}
                </button>

                {notificationsOpen && (
                  <div className="absolute right-0 mt-2 w-[340px] max-w-[92vw] overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xl">
                    <div className="flex items-center justify-between border-b border-ink-200 px-4 py-2.5">
                      <p className="text-sm font-semibold">Notifications</p>
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-700 hover:underline"
                        onClick={async () => {
                          try {
                            await api.post('/notifications/read-all');
                            setUnreadNotifications(0);
                            setNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
                          } catch (error) {
                            console.error(errorMessage(error));
                          }
                        }}
                      >
                        Mark all read
                      </button>
                    </div>
                    <div className="max-h-80 scroll-area">
                      {notifications.length === 0 ? (
                        <EmptyState compact title="No notifications yet" description="Activity assigned to you will appear here." />
                      ) : (
                        notifications.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={cx('flex w-full gap-2 border-b border-ink-100 px-4 py-2.5 text-left hover:bg-ink-50', !item.read && 'bg-brand-50/50')}
                            onClick={async () => {
                              try {
                                await api.post(`/notifications/${item.id}/read`);
                                setUnreadNotifications((prev) => Math.max(0, prev - 1));
                                setNotifications((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)));
                              } catch {
                                /* ignore */
                              }
                              setNotificationsOpen(false);
                              if (item.link) navigate(item.link);
                            }}
                          >
                            <span className={cx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', item.read ? 'bg-ink-300' : 'bg-brand-600')} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-ink-800">{item.title}</span>
                              {item.body && <span className="block truncate text-xs text-ink-500">{item.body}</span>}
                              <span className="mt-0.5 block text-[11px] text-ink-400">{relativeTime(item.createdAt)}</span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <Link to="/notifications" className="block bg-ink-50 px-4 py-2 text-center text-xs font-medium text-brand-700" onClick={() => setNotificationsOpen(false)}>
                      View notification centre
                    </Link>
                  </div>
                )}
              </div>

              <div className="relative">
                <button type="button" className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-ink-100" onClick={() => setProfileOpen((open) => !open)}>
                  <Avatar name={user.fullName} src={user.photoUrl} size={32} />
                  <span className="hidden text-left sm:block">
                    <span className="block max-w-[120px] truncate text-xs font-semibold text-ink-800">{user.fullName}</span>
                    <span className="block text-[11px] text-ink-400">{formatTime(new Date().toISOString())}</span>
                  </span>
                </button>
                {profileOpen && (
                  <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xl">
                    <div className="border-b border-ink-100 px-4 py-3">
                      <p className="text-sm font-semibold text-ink-800">{user.fullName}</p>
                      <p className="text-xs text-ink-500">{user.email}</p>
                      <Badge tone="brand" className="mt-1.5">
                        {user.roleName}
                      </Badge>
                    </div>
                    <Link to="/profile" className="block px-4 py-2 text-sm hover:bg-ink-50">
                      My profile
                    </Link>
                    <Link to="/notifications" className="block px-4 py-2 text-sm hover:bg-ink-50">
                      Notification centre
                    </Link>
                    <button type="button" onClick={() => void logout()} className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50">
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
        <footer className="no-print border-t border-ink-200 px-4 py-3 text-center text-[11px] text-ink-400 sm:px-6">
          Workforce Enterprise Suite · {new Date().getFullYear()} · Data and actions are persisted to MySQL
        </footer>
      </div>
    </div>
  );
}
