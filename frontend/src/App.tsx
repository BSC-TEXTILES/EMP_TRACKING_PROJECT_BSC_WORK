import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { AppShell } from './components/AppShell';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { CallProvider } from './components/CallInterface';
import { Skeleton } from './components/ui';

const Setup = lazy(() => import('./pages/Setup'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Attendance = lazy(() => import('./pages/Attendance'));
const Tasks = lazy(() => import('./pages/Tasks'));
const DailyReports = lazy(() => import('./pages/DailyReports'));
const Chat = lazy(() => import('./pages/Chat'));
const Mailbox = lazy(() => import('./pages/Mailbox'));
const Tickets = lazy(() => import('./pages/Tickets'));
const Calendar = lazy(() => import('./pages/Calendar'));
const Meetings = lazy(() => import('./pages/Meetings'));
const MeetingRoom = lazy(() => import('./pages/MeetingRoom'));
const Kpi = lazy(() => import('./pages/Kpi'));
const Activity = lazy(() => import('./pages/Activity'));
const Leave = lazy(() => import('./pages/Leave'));
const Projects = lazy(() => import('./pages/Projects'));
const Collections = lazy(() => import('./pages/Collections'));
const Employees = lazy(() => import('./pages/Employees'));
const Groups = lazy(() => import('./pages/Groups'));
const OrganizationSettings = lazy(() => import('./pages/OrganizationSettings'));
const Organization = lazy(() => import('./pages/Organization'));
const OfficeTimesAdmin = lazy(() => import('./pages/OfficeTimesAdmin'));
const Analytics = lazy(() => import('./pages/Analytics'));
const RolesAdmin = lazy(() => import('./pages/RolesAdmin'));
const SettingsAdmin = lazy(() => import('./pages/SettingsAdmin'));
const EmailConfiguration = lazy(() => import('./pages/EmailConfiguration'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Calls = lazy(() => import('./pages/Calls'));
const Settings = lazy(() => import('./pages/Settings'));
const Profile = lazy(() => import('./pages/Profile'));

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
