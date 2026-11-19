export type ActivityRecordType = 'app' | 'browser' | 'module' | 'work' | 'session' | 'summary';

export interface Policy {
  id: number;
  name: string;
  version: number;
  policyText: string;
  screenshotEnabled: boolean;
  screenshotIntervalMinutes: number;
  locationTrackingEnabled?: boolean;
  locationIntervalMinutes?: number;
  retentionDays: number;
  allowedApps: string[];
  allowedDomains: string[];
}

export interface Device {
  id: number;
  deviceName: string;
  osName: string;
  status: string;
  lastSeenAt: string | null;
  agentVersion?: string | null;
}

export interface AppUsage {
  id?: number;
  app: string;
  category: string;
  minutes: number;
  seconds: number;
}

export interface ModuleUsage {
  id?: number;
  module: string;
  seconds: number;
  visits: number;
}

export interface KeyIssue {
  title: string;
  severity: string;
  category: string;
  ticketId: number | null;
}

export interface DailySummary {
  id: number | null;
  date: string;
  attendanceMinutes: number;
  breakMinutes: number;
  activeMinutes: number;
  appBreakdown: AppUsage[];
  moduleBreakdown: ModuleUsage[];
  taskSummary: {
    assigned?: number;
    pending?: number;
    completed?: number;
    loggedMinutes?: number;
    completedItems?: { id: number; taskNo: string; title: string; project: string | null }[];
  };
  keyActivities: string[];
  issues: KeyIssue[];
  tickets: { id: number; ticket_no: string; subject: string; status: string; priority: string }[];
  employeeNotes: string | null;
  status: string;
  managerNote: string | null;
  employee?: {
    full_name: string;
    employee_code: string;
    department_name: string | null;
    designation_title: string | null;
  } | null;
}

export interface WeeklyReport {
  id: number;
  weekStart: string;
  weekEnd: string;
  score: number;
  grade: string;
  status: string;
  previousScore: number | null;
  metrics: Record<string, unknown>;
  managerRemarks: string | null;
  employeeFeedback: string | null;
}

export interface BrowserActivityItem {
  id?: number;
  domain: string;
  category: string;
  minutes: number;
}

export interface SelfDashboard {
  date: string;
  targetEmployee?: {
    id: number;
    full_name: string;
    email: string;
    employee_code: string;
    department_name: string | null;
    designation_title: string | null;
    location_name: string | null;
  } | null;
  policy: Policy;
  consent: { acknowledged: boolean; acknowledgedAt: string | null };
  session: { id: number; deviceName: string; startedAt: string } | null;
  devices: Device[];
  daily: DailySummary;
  errors: { id: number; description: string; severity: string; ticketId: number | null; occurredAt: string }[];
  tickets: { id: number; ticket_no: string; subject: string; status: string; priority: string; created_at: string }[];
  browser: BrowserActivityItem[];
  weekly: WeeklyReport[];
  sessions: { id: number; started_at: string; ended_at: string | null; status: string; device_name: string }[];
}

export interface TeamRow {
  id: number;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  department: string | null;
  designation: string | null;
  location?: string | null;
  active: boolean;
  sessionStartedAt: string | null;
  lastHeartbeatAt?: string | null;
  currentApp?: string | null;
  currentCategory?: string | null;
  idleSeconds?: number;
  activeMinutes: number;
  tasksCompleted: number;
  dailyStatus: string | null;
  keyActivities: string[];
  weeklyScore: number | null;
  weeklyGrade: string | null;
  needsAssistance: boolean;
}

export interface MonthlyApplication {
  app: string;
  category: string;
  minutes: number;
  seconds: number;
  sessions: number;
}

export interface MonthlyDashboard {
  month: string;
  self: {
    month: string;
    start: string;
    end: string;
    employee: {
      id: number;
      name: string;
      employeeCode: string;
      department: string | null;
      designation: string | null;
      manager: string | null;
      location: string | null;
    };
    totals: {
      attendanceDays: number;
      attendanceMinutes: number;
      activeMinutes: number;
      tasksAssigned: number;
      tasksCompleted: number;
      daysMonitored: number;
      daysSubmitted: number;
      daysApproved: number;
      incidents: number;
      tickets: number;
      averageWeeklyScore: number | null;
    };
    applications: MonthlyApplication[];
    days: { date: string; status: string; activeMinutes: number; attendanceMinutes: number; tasksCompleted: number }[];
    weekly: { weekStart: string; weekEnd: string; score: number; grade: string; status: string }[];
    completedTasks: { id: number; taskNo: string; title: string; project: string | null; completedAt: string }[];
    pendingTasks: { id: number; taskNo: string; title: string; dueDate: string; priority: string; project: string | null }[];
    keyActivities: string[];
  };
  team: {
    scope: 'team' | 'all';
    employees: {
      id: number;
      name: string;
      employeeCode: string;
      department: string | null;
      designation: string | null;
      activeMinutes: number;
      attendanceDays: number;
      tasksCompleted: number;
      submittedDays: number;
      averageWeeklyScore: number | null;
    }[];
    totals: {
      employees: number;
      activeMinutes: number;
      tasksCompleted: number;
      submittedDays: number;
      averageWeeklyScore: number | null;
    };
  } | null;
}

export interface TeamOverview {
  scope: 'team' | 'all';
  date: string;
  employees?: TeamRow[];
  totals: Record<string, number | null>;
  departments?: { department: string; employees: number; minutes: number }[];
  applications?: { app: string; category: string; minutes: number }[];
  incidents?: { id: number; title: string; severity: string; status: string; occurrences: number; lastSeenAt: string; ticketNo: string | null }[];
  devices?: { id: number; device_name: string; os_name: string; status: string; last_seen_at: string | null; full_name?: string }[];
  activeSessions?: { id: number; full_name: string; device_name: string; started_at: string; last_heartbeat_at: string | null }[];
}

export interface LoginAuditItem {
  id: number;
  sessionId: number | null;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  location: string;
  loginAt: string;
  logoutAt: string | null;
  durationMinutes: number;
  browser: string;
  os: string;
  ip: string | null;
  loginStatus: string;
  logoutReason: string;
  terminationStatus: string;
}

export interface LoginHistoryResponse {
  total: number;
  summary: { total: number; active: number; ended: number; avgDurationMinutes: number };
  items: LoginAuditItem[];
}

export interface TimelineSegment {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  startedAt: string;
  endedAt?: string | null;
  durationMinutes?: number;
  category?: string;
  status?: string;
}

export interface TrashItem {
  id: number;
  type: ActivityRecordType;
  typeLabel: string;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  title: string;
  detail: string;
  durationMinutes: number;
  recordedAt: string | null;
  deletedAt: string;
  deletedBy: { id: number; name: string } | null;
  deleteReason: string | null;
}

export interface TrashResponse {
  items: TrashItem[];
  total: number;
}

export function formatMinutes(value: number): string {
  const hours = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}
