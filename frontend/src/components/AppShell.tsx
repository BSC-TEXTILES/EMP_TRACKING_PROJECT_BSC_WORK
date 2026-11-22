import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime, useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { api, errorMessage } from '../lib/api';
import { cx, formatTime, relativeTime } from '../lib/format';
import { Avatar, Badge, EmptyState, Field, Modal } from './ui';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon } from './icons';
import { BottomNav, type BottomNavItem } from './mobile/BottomNav';
import { PullToRefresh } from './mobile/NativeShell';
import { isNative } from '../lib/native';
import { NotificationPermissionBanner } from './NotificationPermissionBanner';
import type { NotificationItem } from '../lib/types';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  show: boolean;
  badge?: number;
}

const AVAILABILITY_OPTIONS: { key: string; label: string; color: string; dot: string; desc: string }[] = [
  { key: 'active', label: 'Available', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', desc: 'Ready for tasks & calls' },
  { key: 'away', label: 'Away', color: 'text-amber-700 bg-amber-50 border-amber-200', dot: 'bg-amber-500', desc: 'Stepped away temporarily' },
  { key: 'dnd', label: 'Do Not Disturb', color: 'text-rose-700 bg-rose-50 border-rose-200', dot: 'bg-rose-500', desc: 'Mute alerts & calls' },
  { key: 'in_meeting', label: 'In a Meeting', color: 'text-purple-700 bg-purple-50 border-purple-200', dot: 'bg-purple-500', desc: 'In a scheduled call/meeting' },
  { key: 'on_break', label: 'On Break', color: 'text-blue-700 bg-blue-50 border-blue-200', dot: 'bg-blue-500', desc: 'Taking a shift break' },
  { key: 'inactive', label: 'Inactive', color: 'text-slate-700 bg-slate-50 border-slate-200', dot: 'bg-slate-400', desc: 'Off duty / not working' },
];

export function AppShell() {
  const { user, logout, has, canAny, unreadNotifications, setUnreadNotifications, refresh: refreshAuth } = useAuth();
  const displayName = user?.fullName ?? '';
  const displayCode = user?.employeeCode ?? '';
  const displayDept = user?.departmentName ?? 'Organisation';
  const displayEmail = user?.email ?? '';
  const { connected, onlineIds, status, retry } = useRealtime();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  /** Mobile app: bumping this remounts the current screen (pull to refresh). */
  const [refreshKey, setRefreshKey] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [search, setSearch] = useState('');
  const [notificationError, setNotificationError] = useState('');
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [profileOpen, setProfileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('wfm_sidebar_collapsed') === '1');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);

  const [presenceStatus, setPresenceStatus] = useState('active');
  const [signOutModalOpen, setSignOutModalOpen] = useState(false);
  const [keepNotificationsOnSignOut, setKeepNotificationsOnSignOut] = useState(true);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);

  useEffect(() => {
    if (user?.id) {
      api.get<{ presence: { status: string; label: string } }>('/presence/me')
        .then((res) => {
          if (res?.presence?.status) {
            const normalized = res.presence.status === 'inactive_today' ? 'inactive' : res.presence.status;
            setPresenceStatus(normalized);
          }
        })
        .catch(() => undefined);
    }
  }, [user?.id]);

  // An admin/manager changed their own location (possibly on another device): reload the session.
  useSocketEvent('profile:location_changed', () => {
    void refreshAuth();
    setRefreshKey((key) => key + 1);
  });

  useSocketEvent('presence:status', (raw: unknown) => {
    const data = raw as { employeeId?: number; status?: string } | null | undefined;
    if (data && typeof data === 'object' && data.employeeId === user?.id && data.status) {
      const normalized = data.status === 'inactive_today' ? 'inactive' : data.status;
      setPresenceStatus(normalized);
    }
  });

  const updatePresence = async (statusKey: string) => {
    try {
      setPresenceStatus(statusKey);
      await api.put('/presence/me', { status: statusKey });
      const opt = AVAILABILITY_OPTIONS.find((o) => o.key === statusKey);
      toast.success(`Availability status set to ${opt?.label ?? statusKey}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error('New passwords do not match.');
      return;
    }
    setPasswordBusy(true);
    try {
      await api.post('/auth/password/change', {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      toast.success('Password updated successfully.');
      setPasswordModalOpen(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPasswordBusy(false);
    }
  };

  const currentPresence = useMemo(() => {
    const normalized = presenceStatus === 'inactive_today' ? 'inactive' : presenceStatus;
    return AVAILABILITY_OPTIONS.find((o) => o.key === normalized) ?? AVAILABILITY_OPTIONS[0];
  }, [presenceStatus]);

  useEffect(() => {
    localStorage.setItem('wfm_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  // Internal module usage is recorded only while an authorised monitoring session
  // is active; the API ignores it otherwise and never stores page content.
  useEffect(() => {
    if (!user) return;
    const modules: [RegExp, string][] = [
      [/^\/hr/, 'HR Management'],
      [/^\/tasks/, 'Task Management'],
      [/^\/reports/, 'Daily Work Report'],
      [/^\/attendance/, 'Attendance'],
      [/^\/tickets/, 'Ticket Management'],
      [/^\/issues/, 'Issue Management & Escalation'],
      [/^\/chat/, 'Chat'],
      [/^\/mailbox/, 'Email Mailbox'],
      [/^\/projects/, 'Project Management'],
      [/^\/calendar/, 'Calendar'],
      [/^\/meetings/, 'Meetings'],
      [/^\/kpi/, 'KPI'],
      [/^\/analytics/, 'Reports'],
      [/^\/admin/, 'Administration'],
      [/^\/organization/, 'Administration'],
      [/^\/activity/, 'Activity Monitoring'],
      [/^\/$/, 'Dashboard'],
    ];
    const module = modules.find(([pattern]) => pattern.test(location.pathname))?.[1] ?? 'Platform';
    // Tells supervisors which section is open (the route name only, e.g. 'tasks').
    const section = location.pathname.split('/').filter(Boolean).slice(0, location.pathname.startsWith('/admin/') ? 2 : 1).join('-') || 'dashboard';
    if (document.visibilityState === 'visible') void api.post('/presence/ping', { module: section.slice(0, 48) }).catch(() => undefined);
    // Only time while the page is visible AND the user interacted recently is
    // active work. Hidden tabs and idle periods are never counted. Interaction
    // is just a timestamp: no keys, clicks targets or content are recorded.
    const IDLE_MS = 5 * 60 * 1000;
    const startedAt = Date.now();
    let segmentStart: number | null = document.visibilityState === 'visible' ? startedAt : null;
    let accumulatedMs = 0;
    let lastInteraction = startedAt;

    const closeSegment = (now: number) => {
      if (segmentStart === null) return;
      // Never count beyond the idle cut-off after the last interaction.
      const end = Math.min(now, lastInteraction + IDLE_MS);
      if (end > segmentStart) accumulatedMs += end - segmentStart;
      segmentStart = null;
    };
    const flush = () => {
      const now = Date.now();
      const visible = document.visibilityState === 'visible';
      closeSegment(now);
      const seconds = Math.round(accumulatedMs / 1000);
      if (visible && now - lastInteraction < IDLE_MS) segmentStart = now;
      if (seconds < 5) return;
      accumulatedMs = 0;
      void api
        .post('/activity/module-activity', {
          module,
          pagePath: location.pathname,
          enteredAt: new Date(startedAt).toISOString(),
          exitedAt: new Date(now).toISOString(),
          activeSeconds: seconds,
        })
        .catch(() => undefined);
    };
    const onInteraction = () => {
      const now = Date.now();
      const wasIdle = now - lastInteraction >= IDLE_MS;
      lastInteraction = now;
      if (document.visibilityState === 'visible' && (segmentStart === null || wasIdle)) {
        if (wasIdle) closeSegment(now);
        segmentStart = now;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else {
        lastInteraction = Date.now();
        segmentStart = Date.now();
      }
    };
    const interactionEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of interactionEvents) window.addEventListener(name, onInteraction, { passive: true });
    const interval = window.setInterval(flush, 60000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const name of interactionEvents) window.removeEventListener(name, onInteraction);
      flush();
    };
  }, [location.pathname, user]);

  const isAdministrative = Boolean(
    user && (
      ['super_admin', 'admin', 'hr', 'hr_manager', 'store_manager', 'department_manager', 'location_manager', 'manager'].includes(user.roleSlug) ||
      (user.roleLevel ?? 0) >= 40 ||
      canAny('employees.view.team', 'employees.view.all', 'org.manage', 'roles.manage', 'settings.manage', 'audit.view', 'admin.dashboard')
    )
  );

  const isHrOrAdmin = Boolean(
    user && (
      ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_executive', 'payroll_admin'].includes(user.roleSlug) ||
      (user.roleLevel ?? 0) >= 40 ||
      canAny('employees.view.team', 'employees.view.all', 'employees.manage', 'admin.dashboard')
    )
  );

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
          { to: '/mailbox', label: 'Email', icon: 'mail', show: true },
          { to: '/tickets', label: 'Tickets', icon: 'ticket', show: canAny('tickets.create', 'tickets.view.own', 'tickets.view.all') },
          { to: '/issues', label: 'Issues & Escalation', icon: 'alertTriangle', show: true },
          { to: '/calendar', label: 'Calendar', icon: 'calendar', show: true },
          { to: '/meetings', label: 'Meetings', icon: 'video', show: true },
          { to: '/kpi', label: 'Performance', icon: 'kpi', show: has('kpi.view.own') },
          { to: '/activity', label: 'Activity', icon: 'activity', show: canAny('activity.view.own', 'activity.view.team', 'activity.view.all') },
          { to: '/leave', label: 'Leave', icon: 'leave', show: has('leave.apply') },
          { to: '/projects', label: 'Projects', icon: 'project', show: has('projects.view') },
          {
            to: '/collections',
            label: 'Collections',
            icon: 'wallet',
            show: canAny('collections.view.own', 'collections.view.team', 'collections.view.all'),
          },
        ],
      },
      ...(isHrOrAdmin
        ? [
            {
              label: 'Human Resources',
              items: [
                { to: '/hr/dashboard', label: 'HR Dashboard', icon: 'dashboard', show: true },
                { to: '/admin/employees', label: 'Employee Directory', icon: 'users', show: canAny('employees.view.team', 'employees.view.all') },
                { to: '/attendance', label: 'Attendance Records', icon: 'clock', show: true },
                { to: '/leave', label: 'Leave Approvals', icon: 'leave', show: true },
                { to: '/hr/payroll', label: 'Salary & Payroll', icon: 'wallet', show: canAny('employees.manage', 'org.manage', 'admin.dashboard') },
                { to: '/hr/documents', label: 'Employee Documents', icon: 'file', show: canAny('employees.manage', 'employees.view.all') },
                { to: '/hr/announcements', label: 'HR Announcements', icon: 'bell', show: true },
              ],
            },
          ]
        : []),
      ...(isAdministrative
        ? [
            {
              label: 'Administration',
              items: [
                {
                  to: '/groups',
                  label: 'Groups & Teams',
                  icon: 'users',
                  show: canAny('groups.view.own', 'groups.view.all', 'groups.manage', 'employees.view.team', 'employees.view.all'),
                },
                {
                  to: '/organization',
                  label: 'Organisation',
                  icon: 'org',
                  show: canAny('org.manage', 'locations.manage', 'hierarchy.view.all', 'employees.view.all'),
                },
                {
                  to: '/admin/office-times',
                  label: 'Office times',
                  icon: 'clock',
                  show: has('settings.manage') || has('org.manage') || (user?.roleLevel ?? 0) >= 60 || user?.roleSlug === 'super_admin',
                },
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
          ]
        : []),
    ],
    [has, canAny, user, isAdministrative, isHrOrAdmin],
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
    setNotificationsLoading(true);
    setNotificationError('');
    try {
      const result = await api.get<{ items: NotificationItem[]; unread: number }>('/notifications?limit=12');
      setNotifications(result.items);
      setUnreadNotifications(result.unread);
    } catch (error) {
      setNotificationError(errorMessage(error));
    } finally {
      setNotificationsLoading(false);
    }
  };

  useEffect(() => {
    const handler = () => void loadNotifications();
    window.addEventListener('notifications:changed', handler);
    return () => window.removeEventListener('notifications:changed', handler);
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(target)) {
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

  // Mobile app tab bar: the first four screens this user can open; everything else is under More.
  const tabCandidates: (BottomNavItem & { show: boolean })[] = [
    { to: '/', label: 'Home', icon: 'dashboard', show: has('dashboard.view') },
    { to: '/attendance', label: 'Attendance', icon: 'clock', show: true },
    { to: '/tasks', label: 'Tasks', icon: 'tasks', show: canAny('tasks.view.own', 'tasks.view.team', 'tasks.view.all') },
    { to: '/chat', label: 'Messages', icon: 'chat', show: has('chat.use') },
    { to: '/leave', label: 'Leave', icon: 'leave', show: has('leave.apply') },
    { to: '/notifications', label: 'Alerts', icon: 'bell', show: true, badge: unreadNotifications },
  ];
  const tabs = tabCandidates.filter((t) => t.show).slice(0, 4);
  const pullRefresh = () => {
    setRefreshKey((k) => k + 1);
    window.dispatchEvent(new CustomEvent('notifications:changed'));
  };

  const renderSidebar = (collapsedMode: boolean) => (
    <aside className={cx('flex h-full shrink-0 flex-col bg-ink-900 text-white', collapsedMode ? 'w-[72px]' : 'w-64')}>
      <div className={cx('flex items-center py-5', collapsedMode ? 'flex-col gap-2 px-2' : 'gap-2.5 px-5')}>
        <img src="/icons/icon.svg" alt="BSC Textiles" className="h-9 w-9 shrink-0 rounded-xl shadow-xs object-cover" />
        {!collapsedMode && (
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight tracking-wide text-white">BSC Textiles</p>
            <p className="text-[11px] font-semibold text-emerald-400">Workforce & Meet</p>
          </div>
        )}
        <button
          type="button"
          className="hidden rounded-md p-1.5 text-ink-400 hover:bg-white/10 hover:text-white lg:block"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsedMode ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsedMode ? 'Expand navigation' : 'Collapse navigation'}
        >
          <Icon name="menu" size={16} />
        </button>
      </div>
      <nav className="scroll-area flex-1 space-y-6 px-3 pb-6">
        {nav.map((group) => {
          const items = group.items.filter((item) => item.show);
          if (items.length === 0) return null;
          return (
            <div key={group.label}>
              {!collapsedMode && (
                <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-ink-500">{group.label}</p>
              )}
              <div className="space-y-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    title={collapsedMode ? item.label : undefined}
                    className={({ isActive }) => cx('nav-link', isActive && 'nav-link-active', collapsedMode && 'justify-center px-2')}
                  >
                    <Icon name={item.icon} size={17} />
                    {!collapsedMode && <span className="flex-1">{item.label}</span>}
                    {!collapsedMode && item.to === '/chat' && user && (
                      <span className="text-[10px] text-ink-400">{onlineIds.length} online</span>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-3 space-y-1">
        <Link
          to="/profile"
          title={collapsedMode ? 'View My Profile' : undefined}
          className={cx('flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/10', collapsedMode && 'justify-center')}
        >
          <Avatar name={user.fullName} src={user.photoUrl} size={34} />
          {!collapsedMode && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user.fullName}</p>
              <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
                <span className={cx('h-1.5 w-1.5 rounded-full shrink-0', currentPresence.dot)} />
                <span className="truncate">{currentPresence.label} · {user.employeeCode}</span>
              </div>
            </div>
          )}
        </Link>

        {!collapsedMode && (
          <div className="grid grid-cols-2 gap-1 pt-0.5">
            <button
              type="button"
              onClick={() => setPasswordModalOpen(true)}
              className="text-[11px] text-ink-300 hover:text-white px-2 py-1 rounded hover:bg-white/10 text-left inline-flex items-center gap-1.5"
            >
              <Icon name="lock" size={13} />
              <span>Password</span>
            </button>
            <Link
              to="/notifications"
              className="text-[11px] text-ink-300 hover:text-white px-2 py-1 rounded hover:bg-white/10 text-left inline-flex items-center gap-1.5"
            >
              <Icon name="bell" size={13} />
              <span>Alerts{unreadNotifications > 0 ? ` (${unreadNotifications})` : ''}</span>
            </Link>
          </div>
        )}

        <button
          type="button"
          onClick={() => setSignOutModalOpen(true)}
          title={collapsedMode ? 'Sign out' : undefined}
          className={cx('nav-link mt-1 w-full text-rose-300 hover:text-rose-100 hover:bg-rose-950/40', collapsedMode && 'justify-center px-2')}
        >
          <Icon name="logout" size={17} />
          {!collapsedMode && 'Sign out'}
        </button>
      </div>
    </aside>
  );

  return (
    <div className="app-shell flex min-h-screen bg-ink-100">
      <div className={cx('hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex', collapsed ? 'lg:w-[72px]' : 'lg:w-64')}>
        {renderSidebar(collapsed)}
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-ink-900/60" onClick={() => setMobileOpen(false)} aria-hidden />
          <div className="relative z-10 h-full w-64 bg-ink-900 safe-top safe-bottom">{renderSidebar(false)}</div>
        </div>
      )}

      <div className={cx('flex min-w-0 flex-1 flex-col transition-[margin] duration-200', collapsed ? 'lg:ml-[72px]' : 'lg:ml-64')}>
        <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/95 backdrop-blur safe-top">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button type="button" className={cx('btn-ghost btn-sm lg:hidden', isNative && 'hidden')} onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Icon name="menu" size={20} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-900">{activeTitle}</p>
              <p className="hidden text-[11px] text-ink-400 sm:block">
                {displayDept} · {displayCode}
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
              <button
                type="button"
                onClick={connected || status === 'connecting' ? undefined : retry}
                disabled={connected || status === 'connecting'}
                className={cx(
                  'hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium sm:flex',
                  connected ? 'bg-emerald-50 text-emerald-700' : status === 'offline' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700',
                )}
                title={connected ? 'Realtime connected' : status === 'offline' ? 'Realtime unavailable — click to retry' : 'Connecting to realtime…'}
              >
                <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : status === 'offline' ? 'bg-red-500' : 'bg-amber-500')} />
                {connected ? 'Live' : status === 'offline' ? 'Offline · Retry' : 'Connecting'}
              </button>

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
                      {notificationError ? (
                        <div role="alert" className="p-4 text-sm text-red-600">
                          {notificationError}
                          <button type="button" className="btn-secondary mt-2" onClick={() => void loadNotifications()}>Retry</button>
                        </div>
                      ) : notificationsLoading ? (
                        <p role="status" className="p-4 text-sm text-ink-500">Loading notifications…</p>
                      ) : notifications.length === 0 ? (
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
                              <span className="flex items-center justify-between gap-1.5">
                                <span className="truncate text-sm font-medium text-ink-800">{item.title}</span>
                                {item.locationCode && (
                                  <span className="shrink-0 rounded px-1.5 py-0.2 text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                    {item.locationCode}
                                  </span>
                                )}
                              </span>
                              {item.body && <span className="block truncate text-xs text-ink-500">{item.body}</span>}
                              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                                {item.senderName && <span>{item.senderName} ·</span>}
                                <span>{relativeTime(item.createdAt)}</span>
                              </span>
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

              <div className="relative" ref={profileRef}>
                <button type="button" className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-ink-100 transition-colors cursor-pointer" onClick={() => setProfileOpen((open) => !open)}>
                  <div className="relative">
                    <Avatar name={displayName} src={user.photoUrl} size={32} />
                    <span className={cx('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', currentPresence.dot)} />
                  </div>
                  <span className="hidden text-left sm:block">
                    <span className="block max-w-[140px] truncate text-xs font-semibold text-ink-800">{displayName}</span>
                    <span className="block text-[11px] text-ink-400 truncate">
                      {user.locationCode ? `${user.locationCode} · ${currentPresence.label}` : currentPresence.label}
                    </span>
                  </span>
                </button>
                {profileOpen && (
                  <div
                    className="absolute right-0 mt-2 w-72 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xl z-50"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div className="border-b border-ink-100 p-3.5 bg-ink-50/50">
                      <Link
                        to="/profile"
                        onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-2.5 hover:opacity-90 transition-opacity cursor-pointer group"
                      >
                        <Avatar name={displayName} src={user.photoUrl} size={38} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-ink-900 truncate group-hover:text-blue-600 transition-colors">{displayName}</p>
                          <p className="text-xs text-ink-500 truncate font-mono">{displayCode} · {displayEmail}</p>
                          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                            <Badge tone="brand">{user.roleName}</Badge>
                            {user.locationName ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                <Icon name="map-pin" size={10} />
                                <span className="truncate max-w-[110px]">{user.locationCode ? `${user.locationCode} · ${user.locationName}` : user.locationName}</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                                All Locations
                              </span>
                            )}
                            <span className={cx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border', currentPresence.color)}>
                              <span className={cx('h-1.5 w-1.5 rounded-full', currentPresence.dot)} />
                              {currentPresence.label}
                            </span>
                          </div>
                        </div>
                      </Link>

                      {/* Availability Status Selector */}
                      <div className="mt-3 pt-2.5 border-t border-ink-200/60" onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider">Set Availability Status</label>
                          <span className={cx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold border', currentPresence.color)}>
                            <span className={cx('h-1.5 w-1.5 rounded-full', currentPresence.dot)} />
                            {currentPresence.label}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {AVAILABILITY_OPTIONS.map((opt) => {
                            const isSelected = presenceStatus === opt.key || (presenceStatus === 'inactive_today' && opt.key === 'inactive');
                            return (
                              <button
                                key={opt.key}
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void updatePresence(opt.key);
                                }}
                                className={cx(
                                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-left transition-all cursor-pointer border',
                                  isSelected
                                    ? 'bg-ink-900 text-white font-bold border-ink-900 shadow-xs'
                                    : 'bg-white text-ink-700 hover:bg-ink-50 border-ink-200/70 font-medium',
                                )}
                                title={opt.desc}
                              >
                                <span className={cx('h-2 w-2 rounded-full shrink-0', opt.dot)} />
                                <span className="truncate flex-1">{opt.label}</span>
                                {isSelected && (
                                  <Icon name="check" size={13} className="shrink-0 text-white" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="py-1">
                      <Link to="/profile" onClick={() => setProfileOpen(false)} className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50 cursor-pointer transition">
                        <Icon name="user" size={16} className="text-ink-500" />
                        <span>View My Profile</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => { setProfileOpen(false); setPasswordModalOpen(true); }}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50 text-left cursor-pointer transition"
                      >
                        <Icon name="lock" size={16} className="text-ink-500" />
                        <span>Update Password</span>
                      </button>
                      <Link to="/notifications" onClick={() => setProfileOpen(false)} className="flex items-center justify-between px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50 cursor-pointer transition">
                        <div className="flex items-center gap-2.5">
                          <Icon name="bell" size={16} className="text-ink-500" />
                          <span>Notifications</span>
                        </div>
                        {unreadNotifications > 0 && (
                          <span className="rounded-full bg-brand-600 px-1.5 py-0.2 text-[10px] font-bold text-white">
                            {unreadNotifications}
                          </span>
                        )}
                      </Link>
                      <a
                        href="/downloads/bsc-hrms-release.apk"
                        download="bsc-hrms-release.apk"
                        onClick={() => setProfileOpen(false)}
                        className="flex items-center justify-between px-4 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 cursor-pointer transition"
                      >
                        <div className="flex items-center gap-2.5">
                          <Icon name="smartphone" size={16} className="text-emerald-600" />
                          <span>Download Android App</span>
                        </div>
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                          APK
                        </span>
                      </a>
                    </div>

                    <div className="border-t border-ink-100 p-1.5">
                      <button
                        type="button"
                        onClick={() => { setProfileOpen(false); setSignOutModalOpen(true); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 rounded-lg text-left cursor-pointer transition"
                      >
                        <Icon name="logout" size={16} />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <NotificationPermissionBanner />

        <main className={cx('mx-auto w-full flex-1 px-4 py-5 sm:px-6 sm:py-6', location.pathname.startsWith('/tasks') ? 'max-w-[1920px]' : 'max-w-[1400px]', isNative && 'pb-[calc(5rem+env(safe-area-inset-bottom))]')}>
          {isNative ? (
            <PullToRefresh onRefresh={pullRefresh}>
              <ErrorBoundary key={refreshKey}>
                <Outlet />
              </ErrorBoundary>
            </PullToRefresh>
          ) : (
            <ErrorBoundary key={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          )}
        </main>
        {isNative && <BottomNav items={tabs} onMore={() => setMobileOpen(true)} moreBadge={tabs.some((t) => t.to === '/notifications') ? 0 : unreadNotifications} />}
        <footer hidden={isNative} className="no-print border-t border-ink-200 px-4 py-3 text-center text-[11px] text-ink-400 sm:px-6">
          Workforce Enterprise Suite · {new Date().getFullYear()} · Data and actions are persisted to MySQL
        </footer>

        {/* Sign Out Confirmation Modal */}
        <Modal
          open={signOutModalOpen}
          onClose={() => setSignOutModalOpen(false)}
          title="Confirm Sign Out"
          description="Terminates your active authenticated session and records your departure."
          size="sm"
          footer={
            <div className="flex w-full items-center justify-end gap-2">
              <button type="button" className="btn-secondary btn-sm" onClick={() => setSignOutModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary btn-sm !bg-rose-600 hover:!bg-rose-700 !text-white !border-rose-600"
                onClick={async () => {
                  setSignOutModalOpen(false);
                  await logout({ keepNotifications: keepNotificationsOnSignOut });
                }}
              >
                Sign Out
              </button>
            </div>
          }
        >
          <div className="text-sm text-ink-700 space-y-2 py-1">
            <p>Are you sure you want to sign out from Workforce?</p>
            <p className="text-xs text-ink-500">
              • Your active monitoring session will be cleanly concluded.<br />
              • Any pending work logs will be synchronized with the server.<br />
              • To resume work later, you will need to sign in again.
            </p>
            <label className="mt-3 flex items-start gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={keepNotificationsOnSignOut}
                onChange={(event) => setKeepNotificationsOnSignOut(event.target.checked)}
              />
              <span>
                <span className="block font-semibold text-ink-900">Keep call and message notifications on this device</span>
                Incoming calls will still ring here after you sign out. Message text is hidden until you sign in again.
                Turn this off on a shared device.
              </span>
            </label>
          </div>
        </Modal>

        {/* Update Password Modal */}
        <Modal
          open={passwordModalOpen}
          onClose={() => setPasswordModalOpen(false)}
          title="Update Password"
          description="Change your account password securely. All other active sessions will be revoked."
          size="md"
          footer={null}
        >
          <form onSubmit={handlePasswordSubmit} className="space-y-4 py-1">
            <Field label="Current password" required>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showCurrentPassword ? 'text' : 'password'}
                  value={passwordForm.currentPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1 rounded"
                  title={showCurrentPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showCurrentPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
            </Field>
            <Field label="New password" hint="At least 10 characters with upper, lower, number and symbol." required>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showNewPassword ? 'text' : 'password'}
                  minLength={10}
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1 rounded"
                  title={showNewPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showNewPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
            </Field>
            <Field label="Confirm new password" required>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showConfirmNewPassword ? 'text' : 'password'}
                  minLength={10}
                  value={passwordForm.confirmPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmNewPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1 rounded"
                  title={showConfirmNewPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showConfirmNewPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
            </Field>
            {passwordForm.confirmPassword && (
              <div>
                {passwordForm.newPassword === passwordForm.confirmPassword ? (
                  <p className="text-xs font-medium text-emerald-600 flex items-center gap-1">✓ Passwords match</p>
                ) : (
                  <p className="text-xs font-medium text-red-600 flex items-center gap-1">✕ Passwords do not match</p>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
              <button type="button" className="btn-secondary btn-sm" onClick={() => setPasswordModalOpen(false)} disabled={passwordBusy}>
                Cancel
              </button>
              <button type="submit" className="btn-primary btn-sm" disabled={passwordBusy}>
                {passwordBusy ? 'Updating…' : 'Update Password'}
              </button>
            </div>
          </form>
        </Modal>
      </div>
    </div>
  );
}
