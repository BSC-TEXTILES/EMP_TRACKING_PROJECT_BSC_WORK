export interface CurrentUser {
  id: number;
  employeeCode: string;
  fullName: string;
  email: string;
  mobile: string;
  photoUrl: string | null;
  status: string;
  roleId: number;
  roleSlug: string;
  roleName: string;
  roleLevel: number;
  departmentId: number | null;
  departmentName: string | null;
  designationId: number | null;
  designationTitle: string | null;
  managerId: number | null;
  managerName: string | null;
  locationId: number | null;
  locationName: string | null;
  locationCode?: string | null;
  groupId?: number | null;
  groupName?: string | null;
  groupCode?: string | null;
  teamLeaderId?: number | null;
  teamLeaderName?: string | null;
  allowedLocations?: Array<{ id: number; code: string; name: string }>;
  employmentType: string;
  joiningDate: string | null;
  permissions: string[];
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

export interface AttendanceState {
  id: number | null;
  date: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: string;
  totalMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  lateMinutes: number;
  earlyDeparture: boolean;
  autoClosed: boolean;
  isOnBreak: boolean;
  breakStartedAt: string | null;
  elapsedSeconds: number;
  serverNow: string;
  workStart: string;
  workEnd: string;
  isHoliday: boolean;
  holidayName: string | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  canBreak: boolean;
}

export interface TaskSummary {
  id: number;
  taskNo: string;
  title: string;
  description: string | null;
  category: string | null;
  priority: string;
  status: string;
  progress: number;
  departmentName: string | null;
  projectId: number | null;
  projectName: string | null;
  createdBy: number;
  creatorName: string | null;
  managerName: string | null;
  assigneeNames: string | null;
  assigneeIds: number[];
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  estimatedMinutes: number | null;
  recurrence: string;
  submittedAt: string | null;
  completedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string | null;
  isOverdue: boolean;
  totalLoggedMinutes?: number;
  instructions?: string | null;
  remarks?: string | null;
  timeSlot?: 'morning' | 'operations' | 'evening' | 'closing' | null;
  requiresEvidence?: boolean;
  evidenceType?: string | null;
  evidenceFileId?: number | null;
  requiresMetric?: boolean;
  metricLabel?: string | null;
  metricValue?: number | null;
  metricUnit?: string | null;
  verificationStatus?: string | null;
  assignments?: {
    id: number;
    employeeId: number;
    employeeName: string;
    status: string;
    assignedAt: string | null;
    acceptedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    timeSpentMinutes: number;
    completionNote: string | null;
  }[];
  subtasks?: { id: number; title: string; isDone: boolean }[];
  comments?: { id: number; authorId: number; authorName: string; body: string; createdAt: string }[];
  timeLogs?: { id: number; employeeName: string; startedAt: string; endedAt: string | null; minutes: number; note: string | null }[];
  attachments?: { id: number; file_id: number; original_name: string; mime_type: string; size_bytes: number }[];
}

export interface ConversationSummary {
  id: number;
  type: 'direct' | 'group' | 'channel';
  name: string;
  description: string | null;
  isAnnouncement: boolean;
  lastMessageAt: string | null;
  lastMessage: string | null;
  lastSender: string | null;
  unread: number;
  muted: boolean;
  otherEmployeeId: number | null;
  otherMobile?: string | null;
  otherPhoto?: string | null;
  memberCount: number;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  senderPhoto: string | null;
  body: string | null;
  type: string;
  replyToId: number | null;
  replyToBody: string | null;
  replyToSender: string | null;
  clientId?: string | null;
  editedAt: string | null;
  deleted: boolean;
  createdAt: string;
  recipientCount?: number;
  readCount?: number;
  pending?: boolean;
  failed?: boolean;
  attachments: { fileId: number; original_name: string; mime_type: string; size_bytes: number; duration_seconds?: number | null }[];
  reactions: { employeeId: number; name: string; emoji: string }[];
}

export interface TicketSummary {
  issueDetails?: Record<string, unknown>;
  id: number;
  ticketNo: string;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  departmentName: string | null;
  requesterId: number;
  requesterName: string | null;
  assignedTeam: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  slaDueAt: string | null;
  slaBreached: boolean;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolution: string | null;
  feedbackRating: number | null;
  feedbackComment: string | null;
  createdAt: string;
  updatedAt: string;
  comments?: { id: number; authorId: number; authorName: string; body: string; isInternal: boolean; createdAt: string }[];
  attachments?: { file_id: number; original_name: string; mime_type: string; size_bytes: number }[];
  assignmentHistory?: { id: number; employeeName: string; assignedAt: string; note: string | null }[];
}

export interface MeetingSummary {
  id: number;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string;
  status: string;
  locationType: string;
  roomName: string | null;
  meetingCode: string;
  organizerId: number;
  organizerName: string;
  myResponse: string;
  participantCount: number;
  acceptedCount: number;
  departmentName: string | null;
}

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  priority: string;
  senderName?: string | null;
  locationName?: string | null;
  locationCode?: string | null;
  createdAt: string | null;
  read: boolean;
}

export interface KpiItem {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  designationTitle: string | null;
  period: string;
  totalScore: number;
  category: string;
  status: string;
  computedAt: string | null;
  publishedAt: string | null;
  managerComment: string | null;
  strengths: string | null;
  improvements: string | null;
}

export interface EmployeeRow {
  id: number;
  employeeCode: string;
  fullName: string;
  email: string;
  mobile: string;
  photoUrl: string | null;
  status: string;
  employmentType: string;
  joiningDate: string | null;
  departmentId: number | null;
  departmentName: string | null;
  designationTitle: string | null;
  roleName: string;
  roleSlug: string;
  managerId: number | null;
  managerName: string | null;
  locationId?: number | null;
  locationName: string | null;
  locationCode?: string | null;
  groupId?: number | null;
  groupName?: string | null;
  groupCode?: string | null;
  teamLeaderId?: number | null;
  teamLeaderName?: string | null;
  attendanceStatus: string | null;
  checkInAt: string | null;
  openTasks: number;
}

export interface ProjectSummary {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: string;
  progress: number;
  startDate: string | null;
  endDate: string | null;
  managerName: string | null;
  departmentName: string | null;
  memberCount: number;
  taskCount: number;
  completedTasks: number;
  conversationId: number | null;
}

export interface LeaveItem {
  documentFileId: number | null;
  locationName: string | null;
  managerName: string | null;
  hrName: string | null;
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: string;
  decisionNote: string | null;
  managerActionAt: string | null;
  hrActionAt: string | null;
  createdAt: string | null;
  canApproveManager: boolean;
  canApproveHr: boolean;
  canCancel: boolean;
}

export interface PickerEmployee {
  id: number;
  full_name: string;
  phone?: string | null;
  email?: string | null;
  photo_url?: string | null;
  employee_code?: string;
  designation_title: string | null;
  department_name: string | null;
  manager_id: number | null;
}

export interface DashboardData {
  employee: {
    id: number;
    name: string;
    code: string;
    email: string;
    mobile: string;
    photoUrl: string | null;
    designation: string | null;
    department: string | null;
    location: string | null;
    manager: string | null;
    role: string;
    employmentType: string;
    joiningDate: string | null;
  };
  serverNow: string;
  today: {
    date: string;
    isHoliday: boolean;
    holidayName: string | null;
    attendance: AttendanceState;
    report: { id: number; status: string; submittedAt: string | null; summary: string } | null;
  };
  tasks: { active: number; completed: number; pending: number; overdue: number; awaitingApproval: number; completedThisMonth: number };
  tickets: { assigned: number; open: number; resolved: number };
  kpi: { id: number; period: string; score: number; category: string; status: string } | null;
  meetings: { id: number; title: string; startAt: string; endAt: string; organizerName: string }[];
  unreadNotifications: number;
  unreadChat: number;
  weeklyHours: { date: string; hours: number }[];
  attendanceSummary: {
    period: string;
    presentDays: number;
    lateDays: number;
    halfDays: number;
    onLeaveDays: number;
    holidayCount: number;
    totalMinutes: number;
    averageMinutesPerDay: number;
    attendancePercent: number;
    breakdown: { status: string; count: number; minutes: number }[];
  };
  date: string;
}
