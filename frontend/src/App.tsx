import { Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { AppShell } from './components/AppShell';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { CallProvider } from './components/CallInterface';
import { Skeleton } from './components/ui';
import { lazyWithRetry } from './lib/lazyWithRetry';

const Setup = lazyWithRetry(() => import('./pages/Setup'), 'setup');
const Login = lazyWithRetry(() => import('./pages/Login'), 'login');
const Register = lazyWithRetry(() => import('./pages/Register'), 'register');
const ForgotPassword = lazyWithRetry(() => import('./pages/ForgotPassword'), 'forgot-password');
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'), 'dashboard');
const Attendance = lazyWithRetry(() => import('./pages/Attendance'), 'attendance');
const Tasks = lazyWithRetry(() => import('./pages/Tasks'), 'tasks');
const DailyReports = lazyWithRetry(() => import('./pages/DailyReports'), 'reports');
const Chat = lazyWithRetry(() => import('./pages/Chat'), 'chat');
const Mailbox = lazyWithRetry(() => import('./pages/Mailbox'), 'mailbox');
const Tickets = lazyWithRetry(() => import('./pages/Tickets'), 'tickets');
const Issues = lazyWithRetry(() => import('./pages/Issues'), 'issues');
const Calendar = lazyWithRetry(() => import('./pages/Calendar'), 'calendar');
const Meetings = lazyWithRetry(() => import('./pages/Meetings'), 'meetings');
const MeetingRoom = lazyWithRetry(() => import('./pages/MeetingRoom'), 'meeting-room');
const Kpi = lazyWithRetry(() => import('./pages/Kpi'), 'kpi');
const Activity = lazyWithRetry(() => import('./pages/Activity'), 'activity');
const Leave = lazyWithRetry(() => import('./pages/Leave'), 'leave');
const Projects = lazyWithRetry(() => import('./pages/Projects'), 'projects');
const Collections = lazyWithRetry(() => import('./pages/Collections'), 'collections');
const Employees = lazyWithRetry(() => import('./pages/Employees'), 'employees');
const Groups = lazyWithRetry(() => import('./pages/Groups'), 'groups');
const OrganizationSettings = lazyWithRetry(() => import('./pages/OrganizationSettings'), 'org-settings');
const Organization = lazyWithRetry(() => import('./pages/Organization'), 'organization');
const OfficeTimesAdmin = lazyWithRetry(() => import('./pages/OfficeTimesAdmin'), 'office-times');
const Analytics = lazyWithRetry(() => import('./pages/Analytics'), 'analytics');
const RolesAdmin = lazyWithRetry(() => import('./pages/RolesAdmin'), 'roles-admin');
const SettingsAdmin = lazyWithRetry(() => import('./pages/SettingsAdmin'), 'settings-admin');
const EmailConfiguration = lazyWithRetry(() => import('./pages/EmailConfiguration'), 'email-config');
const Notifications = lazyWithRetry(() => import('./pages/Notifications'), 'notifications');
const Calls = lazyWithRetry(() => import('./pages/Calls'), 'calls');
const Settings = lazyWithRetry(() => import('./pages/Settings'), 'settings');
const Profile = lazyWithRetry(() => import('./pages/Profile'), 'profile');

function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-100">
      <div className="card w-full max-w-md p-6">
        <Skeleton lines={5} />
      </div>
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading, canAny } = useAuth();
  if (loading) return <FullPageLoader />;
  const isAuthorized = Boolean(
    user && (
      ['super_admin', 'admin', 'hr', 'hr_manager', 'store_manager', 'department_manager', 'location_manager', 'manager'].includes(user.roleSlug) ||
      (user.roleLevel ?? 0) >= 40 ||
      canAny('employees.view.team', 'employees.view.all', 'org.manage', 'roles.manage', 'settings.manage', 'audit.view', 'admin.dashboard')
    )
  );
  if (!isAuthorized) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageLoader />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Notification taps while the app is open navigate in place instead of reloading the page. */
function ServiceWorkerBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const url = (event as CustomEvent<string>).detail;
      if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) navigate(url);
    };
    window.addEventListener('sw:navigate', onNavigate);
    return () => window.removeEventListener('sw:navigate', onNavigate);
  }, [navigate]);
  return null;
}

export function App() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <ServiceWorkerBridge />
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route
          path="/login"
          element={
            <GuestOnly>
              <Login />
              {/* Install-app popup: shown on the sign-in page only. */}
              <PWAInstallPrompt />
            </GuestOnly>
          }
        />
        <Route
          path="/register"
          element={
            <GuestOnly>
              <Register />
            </GuestOnly>
          }
        />
        <Route
          path="/forgot-password"
          element={
            <GuestOnly>
              <ForgotPassword />
            </GuestOnly>
          }
        />

        <Route
          element={
            <Protected>
              <CallProvider>
                <AppShell />
              </CallProvider>
            </Protected>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="attendance" element={<Attendance />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="reports" element={<DailyReports />} />
          <Route path="chat" element={<Chat />} />
          <Route path="mailbox" element={<Mailbox />} />
          <Route path="tickets" element={<Tickets />} />
          <Route path="issues" element={<Issues />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="meetings" element={<Meetings />} />
          <Route path="meetings/:id/room" element={<MeetingRoom />} />
          <Route path="kpi" element={<Kpi />} />
          <Route path="activity" element={<Activity />} />
          <Route path="leave" element={<Leave />} />
          <Route path="projects" element={<Projects />} />
          <Route path="collections" element={<Collections />} />
          <Route path="groups" element={<RequireAdmin><Groups /></RequireAdmin>} />
          <Route path="admin/employees" element={<RequireAdmin><Employees /></RequireAdmin>} />
          <Route path="organization" element={<RequireAdmin><Organization /></RequireAdmin>} />
          <Route path="admin/organization" element={<RequireAdmin><OrganizationSettings /></RequireAdmin>} />
          <Route path="admin/office-times" element={<RequireAdmin><OfficeTimesAdmin /></RequireAdmin>} />
          <Route path="analytics" element={<RequireAdmin><Analytics /></RequireAdmin>} />
          <Route path="admin/roles" element={<RequireAdmin><RolesAdmin /></RequireAdmin>} />
          <Route path="admin/settings" element={<RequireAdmin><SettingsAdmin /></RequireAdmin>} />
          <Route path="admin/email" element={<RequireAdmin><EmailConfiguration /></RequireAdmin>} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="calls" element={<Calls />} />
          <Route path="settings" element={<Settings />} />
          <Route path="profile" element={<Profile />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
