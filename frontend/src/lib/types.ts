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
  /** Temporary password issued by HR/an administrator: must be replaced before using the app. */
  temporaryPassword?: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

export interface AttendanceSessionItem {
  id: number;
  sessionNumber: number;
  checkInAt: string | null;
  checkOutAt: string | null;
  totalMinutes: number;
  breakMinutes: number;
  status: string;
  isLate: boolean;
  isActive: boolean;
}

export interface AttendanceState {
  id: number | null;
  sessionNumber?: number;
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
  sessions?: AttendanceSessionItem[];
  activeSessionId?: number | null;
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
  managerId?: number | null;
  managerName: string | null;
  /** Store codes of the assignees, e.g. "BEL" or "DAV, SHI". */
  locationCodes?: string | null;
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
  /** Audit trail of every action taken on the task (newest first). */
  history?: { id: number; action: string; actorName: string | null; status: string | null; note: string | null; createdAt: string | null }[];
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

export interface IssueItem {
  id: number;
  issue_no: string;
  title: string;
  description: string;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'new' | 'pending' | 'in_progress' | 'on_hold' | 'escalated' | 'resolved' | 'closed' | 'reopened' | 'cancelled';
  affected_module: string | null;
  reporter_id: number;
  reporter_name: string;
  reporter_code: string;
  reporter_photo: string | null;
  assigned_to: number;
  assigned_to_name: string;
  assigned_to_code: string;
  assigned_to_photo: string | null;
  location_id: number | null;
  location_name: string | null;
  location_code: string | null;
  department_id: number | null;
  department_name: string | null;
  routing_mode: 'auto' | 'manual';
  escalation_level: number;
  escalation_exhausted: number;
  acknowledged_at: string | null;
  due_at: string | null;
  last_escalated_at: string | null;
  resolved_at: string | null;
  resolved_by: number | null;
  resolved_by_name?: string | null;
  resolution: string | null;
  reopen_count: number;
  comment_count?: number;
  attachment_count?: number;
  created_at: string;
  updated_at: string;
}

export interface IssueCommentItem {
  id: number;
  issue_id: number;
  author_id: number;
  author_name: string;
  author_code: string;
  author_photo: string | null;
  author_role: string;
  kind: string;
  body: string;
  is_internal: number;
  created_at: string;
}

export interface IssueAttachmentItem {
  id: number;
  issue_id: number;
  comment_id: number | null;
  file_id: number;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  download_url: string;
  uploaded_by_name: string;
  is_internal: number;
  created_at: string;
}

export interface IssueEscalationHistoryItem {
  id: number;
  issue_id: number;
  from_employee_id: number | null;
  from_employee_name: string | null;
  to_employee_id: number;
  to_employee_name: string;
  from_level: number;
  to_level: number;
  escalation_type: string;
  reason: string;
  escalated_by: number | null;
  escalated_by_name: string | null;
  notification_status: string;
  created_at: string;
}

export interface IssueActivityLogItem {
  id: number;
  issue_id: number;
  actor_id: number | null;
  actor_name: string | null;
  actor_code: string | null;
  action: string;
  from_status: string | null;
  to_status: string | null;
  details: any;
  is_internal: number;
  created_at: string;
}

export interface IssueDetailData {
  issue: IssueItem;
  comments: IssueCommentItem[];
  attachments: IssueAttachmentItem[];
  escalationHistory: IssueEscalationHistoryItem[];
  activityLogs: IssueActivityLogItem[];
  canSeeInternal: boolean;
}

export interface EscalationRuleItem {
  id: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  ack_reminder_minutes: number;
  escalate_after_minutes: number;
  resolve_within_hours: number;
  overdue_repeat_minutes: number;
  max_level: number;
  notify_higher_immediately: number;
  is_active: number;
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
  exitDate?: string | null;
  exitReason?: string | null;
  hrRepresentativeId?: number | null;
  hrRepresentativeName?: string | null;
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
  managerId?: number | null;
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
  isHalfDay?: boolean;
  halfDaySlot?: 'first_half' | 'second_half' | null;
  /** Sundays inside the range that were not charged (null for requests made before this was tracked). */
  weeklyOffDays?: number | null;
  /** Public holidays inside the range that were not charged. */
  holidayDays?: number | null;
  reason: string;
  status: string;
  managerStatus?: string | null;
  hrStatus?: string | null;
  managerNote?: string | null;
  hrNote?: string | null;
  designationTitle?: string | null;
  locationCode?: string | null;
  decisionNote: string | null;
  managerActionAt: string | null;
  hrActionAt: string | null;
  createdAt: string | null;
  canApproveManager: boolean;
  canApproveHr: boolean;
  canCancel: boolean;
  /** 'weekly_off' and 'half_day' come from the dedicated applications; 'leave' is a historic / generic request. */
  requestKind?: 'leave' | 'weekly_off' | 'half_day';
  leaveTypeCode?: string;
  /** Approval trail: submitted → manager decision → HR decision (or cancellation). */
  history?: { action: string; fromStatus: string | null; toStatus: string; note: string | null; at: string | null; actorName: string | null }[];
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
    weeklyOffCount?: number;
    totalMinutes: number;
    averageMinutesPerDay: number;
    attendancePercent: number;
    breakdown: { status: string; count: number; minutes: number }[];
  };
  myTasks?: TaskSummary[];
  teamTasks?: TaskSummary[];
  dailyPerformance?: {
    date: string;
    attendance: {
      status: string;
      checkInAt: string | null;
      checkOutAt: string | null;
      totalMinutes: number;
      breakMinutes: number;
      elapsedSeconds: number;
      isLate: boolean;
      earlyDeparture: boolean;
    };
    tasks: {
      assigned: number;
      completed: number;
      inProgress: number;
      pending: number;
      underReview: number;
      approved: number;
      overdue: number;
      completionRate: number;
    };
    score: {
      totalScore: number | null;
      earnedPoints: number;
      measuredMax: number;
      rating: string;
      breakdown: {
        key: string;
        label: string;
        max: number;
        score: number | null;
        measured: boolean;
        basis: string;
      }[];
    } | null;
    report: {
      status: string;
      submittedAt: string | null;
      reviewedBy: string | null;
      reviewedAt: string | null;
      reviewNote: string | null;
    } | null;
    timeline: {
      id: number;
      time_slot: string;
      status: 'pending' | 'submitted' | 'verified';
      summary: string | null;
      issues_identified: string | null;
      submitted_at: string | null;
      verified_at: string | null;
    }[];
  };
  date: string;
}
