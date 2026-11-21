import { PoolConnection } from 'mysql2/promise';
import { execute, nextSequence, query, queryOne, transaction } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import type { AuthUser } from './AuthService.js';
import { NotificationService } from './NotificationService.js';
import { recordAudit } from '../lib/audit.js';
import { localTime, today } from '../lib/dates.js';

export interface ScoreCategory {
  key: 'task' | 'timely' | 'quality' | 'reporting' | 'attendance' | 'coordination' | 'escalation';
  label: string;
  max: number;
  /** null when there was nothing to measure; such categories are excluded from the total. */
  score: number | null;
  measured: boolean;
  basis: string;
}

export interface DailyScore {
  date: string;
  taskScore: number;
  timelyScore: number;
  qualityScore: number;
  reportingScore: number;
  attendanceScore: number;
  coordinationScore: number;
  escalationScore: number;
  /** Scaled to 100 over the measured categories; null when nothing could be measured. */
  totalScore: number | null;
  earnedPoints: number;
  measuredMax: number;
  rating: string;
  breakdown: ScoreCategory[];
}

/** "09:30 AM - 10:00 AM" -> 570 (minutes after midnight of the window start). */
function slotStartMinutes(hours: string): number {
  const match = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(hours);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
}

export interface TimelineCheckpointItem {
  id?: number;
  timeSlot: string;
  label: string;
  hours: string;
  status: 'pending' | 'submitted' | 'verified';
  summary: string | null;
  issuesIdentified: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
}

export const TIMELINE_SLOTS = [
  { timeSlot: 'morning_briefing', label: 'Morning Briefing & Task Acknowledgement', hours: '09:30 AM - 10:00 AM' },
  { timeSlot: '10am_12pm', label: 'Morning Store Operations & Inspection', hours: '10:00 AM - 12:00 PM' },
  { timeSlot: '12pm_2pm', label: 'Midday Operations & Customer Flow', hours: '12:00 PM - 02:00 PM' },
  { timeSlot: '2pm_4pm', label: 'Afternoon Stock Movement & Replenishment', hours: '02:00 PM - 04:00 PM' },
  { timeSlot: '4pm_6pm', label: 'Evening Peak Hours & Break Monitoring', hours: '04:00 PM - 06:00 PM' },
  { timeSlot: '6pm_8pm', label: 'Closing Preparations & Pending Task Review', hours: '06:00 PM - 08:00 PM' },
  { timeSlot: 'night_closing', label: 'Night Closing Reconciliation & Handover', hours: '08:00 PM - 09:30 PM' },
];

export const MASTER_SOP_TEMPLATES = [
  // ==========================================
  // 1. STORE MANAGER (13 tasks)
  // ==========================================
  // Morning (5)
  {
    designationTitle: 'Store Manager',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Check previous day total sales',
    description: 'Verify sales report across all floors and store departments against ERP collection records.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'sales_report',
    requiresMetric: 1,
    metricLabel: 'Total Sales',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Check previous day cash collection & bank deposit',
    description: 'Verify physical cash match with billing system and verify signed bank deposit slip.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'bank_deposit_slip',
    requiresMetric: 1,
    metricLabel: 'Cash Deposited',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Verify opening cash balance & cash locker security',
    description: 'Inspect physical cash locker, ensure electronic safe is locked, and verify opening till float.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'physical_inspection',
    requiresMetric: 1,
    metricLabel: 'Opening Float',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Review unsettled bills & pending parcels',
    description: 'Audit previous day unsettled billing transactions and track incoming supplier parcel status.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'unsettled_bill_report',
    requiresMetric: 1,
    metricLabel: 'Unsettled Bills',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'morning',
    taskOrder: 5,
    title: 'Review staff attendance & conduct morning operational briefing',
    description: 'Check attendance log across all departments and conduct morning briefing on targets and floor allocation.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'briefing_confirmation',
    requiresMetric: 1,
    metricLabel: 'Staff Present',
    metricUnit: 'count',
  },
  // Operations (3)
  {
    designationTitle: 'Store Manager',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Monitor store-wide & floor-wise sales targets',
    description: 'Review real-time sales velocity across Menswear, Womenswear, Sarees, and Kids sections against hourly goals.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Current Sales',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Inspect floor staff allocation & ensure no vacant sections',
    description: 'Conduct floor walk across Ground, 1st, and 2nd floors to ensure optimal staff coverage and presentation.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'floor_walk_photo',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Review customer complaints & CRM negative feedback',
    description: 'Address customer feedback escalations, billing delay complaints, or alteration issues with floor managers.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'complaint_register',
    requiresMetric: 1,
    metricLabel: 'Open Complaints',
    metricUnit: 'count',
  },
  // Evening (2)
  {
    designationTitle: 'Store Manager',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Evening peak traffic management & billing counter supervision',
    description: 'Supervise cash desk operations during peak evening footfall to ensure queue wait times under 3 minutes.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Counters Active',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'evening',
    taskOrder: 2,
    title: 'Verify midday cash sweep & safe locker deposit',
    description: 'Conduct interim cash collection from billing counters to vault to minimize cash register exposure.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'interim_cash_slip',
    requiresMetric: 1,
    metricLabel: 'Cash Swept',
    metricUnit: '₹',
  },
  // Closing (3)
  {
    designationTitle: 'Store Manager',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Verify total cash collection vs system sales',
    description: 'Perform end-of-day billing reconciliation: match physical cash, UPI, cards against POS statements.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'cash_closing_statement',
    requiresMetric: 1,
    metricLabel: 'Cash Difference',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Confirm cash handover & verify cash locker is locked',
    description: 'Supervise cash vault lockup with dual-custody verification and record physical safe sealing.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'locker_verification',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Store Manager',
    timeSlot: 'closing',
    taskOrder: 3,
    title: 'Review checkout attendance & submit final store closing report',
    description: 'Ensure all floor staff completed biometric checkout, check perimeter security, and file daily closing report.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'store_closing_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 2. ASSISTANT STORE MANAGER (12 tasks)
  // ==========================================
  // Morning (5)
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Inspect all floors before opening & verify display readiness',
    description: 'Walk all floors before doors open to ensure pristine visual merchandising, aisle clearance, and lighting.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'floor_walk_photo',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Check housekeeping readiness & cleanliness standards',
    description: 'Inspect washrooms, trials, billing stations, and entrance cleanliness with housekeeping supervisor.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'housekeeping_inspection',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Verify staff allocation across all sections',
    description: 'Verify floor staff deployment with section supervisors to ensure no section remains unattended.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Staff Allocated',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Verify parcels received against delivery documents',
    description: 'Coordinate with Warehouse Manager on supplier transport arrival and count incoming parcels against delivery challan.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'delivery_challan',
    requiresMetric: 1,
    metricLabel: 'Parcels Counted',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'morning',
    taskOrder: 5,
    title: 'Check billing counter readiness & cashier deployment',
    description: 'Audit POS hardware, card swipe machines, UPI stands, and cashier presence across all cash desks.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Counters Ready',
    metricUnit: 'count',
  },
  // Operations (4)
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Physically visit every floor & check unattended sections',
    description: 'Conduct ongoing floor supervision rounds to eliminate customer waiting and enforce staff alertness.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'inspection_log',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Monitor customer waiting areas & shopping experience',
    description: 'Observe customer flow in saree section, trial rooms, and billing lines to address customer congestion.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Avg Wait Time',
    metricUnit: 'mins',
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Monitor housekeeping performance & maintenance complaints',
    description: 'Follow up with electricians, HVAC maintenance, and housekeeping team on open facility tickets.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Open Issues',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'operations',
    taskOrder: 4,
    title: 'Verify stock movement from warehouse to floors & pending parcels',
    description: 'Ensure received stock is processed, barcoded, and transferred promptly to retail display racks.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'stock_transfer_doc',
    requiresMetric: 1,
    metricLabel: 'Stock Transfers',
    metricUnit: 'count',
  },
  // Evening / Closing (3)
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Check floor section maintenance & pending stock movements',
    description: 'Verify floor sections are restocked, folded, and organized before evening customer rush.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Review billing & cashier operations closure',
    description: 'Audit closing discipline across cash desks and assist in resolving billing escalations.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Assistant Store Manager',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Submit daily operational inspection report',
    description: 'Summarize facility checks, staff attendance, pending parcels, and store inspection observations.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'operational_inspection_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 3. FLOOR MANAGER (11 tasks)
  // ==========================================
  // Morning (4)
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Open and inspect assigned floor & product arrangement',
    description: 'Inspect lighting, mannequin displays, folded stacks, and overall floor presentation.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'floor_readiness_photo',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Verify floor employee attendance & identify absent staff',
    description: 'Check biometric clock-in for all floor section supervisors and salesmen; log absences.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Staff Present',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Ensure no section is left unattended & allocate staff',
    description: 'Deploy reserve floor staff to cover absent positions so all customer counters are staffed.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Conduct morning briefing & communicate daily sales targets',
    description: 'Brief section salesmen on focus collections, premium fabrics, customer greeting, and revenue targets.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'briefing_confirmation',
    requiresMetric: 1,
    metricLabel: 'Target Amount',
    metricUnit: '₹',
  },
  // Operations (4)
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Regular floor rounds & monitor customer waiting time',
    description: 'Actively walk the floor to ensure customers are being engaged promptly with courteous assistance.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Monitor section-wise sales & employee productivity',
    description: 'Review hourly billing progress across floor sections and encourage cross-selling.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Floor Sales',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Monitor staff break schedules & ensure timely return',
    description: 'Enforce staggered lunch and tea break timings so minimum 80% staff remain active on the floor.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'operations',
    taskOrder: 4,
    title: 'Verify stock replenishment & coordinate with CRM & billing',
    description: 'Ensure fast-moving sizes and colors are restocked from warehouse immediately.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Evening / Closing (3)
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Review floor-wise sales achievement against target',
    description: 'Compare floor sales totals against daily target and review high-performing vs low-performing sections.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Total Floor Sales',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Review customer complaints & floor arrangement maintenance',
    description: 'Ensure trial rooms are cleared, returned garments are folded on shelves, and floor is secured.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Floor Complaints',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Floor Manager',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Submit floor closing report',
    description: 'File daily floor summary covering sales achievement, staff attendance, customer issues, and closing status.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'floor_closing_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 4. SECTION SUPERVISOR (11 tasks)
  // ==========================================
  // Morning (4)
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Check attendance of section staff & deploy to positions',
    description: 'Verify attendance of section salesmen, assign display tables, and confirm greeting posture.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Staff Deployed',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Check stock room & verify section stock availability',
    description: 'Audit section stock room to ensure complete size runs (S to XXL) and fabric variants are accessible.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Identify replenishment products & transfer from stock room',
    description: 'Pick depleted articles and merchandise them neatly on section display tables and hangers.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Items Replenished',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Conduct section morning briefing & assign break timings',
    description: 'Brief section team on daily targets, new arrivals, and allocate specific lunch and tea slots.',
    priority: 'medium',
    requiresEvidence: 1,
    evidenceType: 'briefing_confirmation',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Operations (4)
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Hourly staff presence check & ensure no empty section',
    description: 'Verify salesmen presence every hour; ensure customers in the section are actively attended.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Verify salesmen are attending customers & monitor section sales',
    description: 'Guide salesmen on product presentation, customer sizing assistance, and track hourly sales.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Section Sales',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Replenish fast-moving stock & report damaged items',
    description: 'Maintain neat stacks, fold opened items, and isolate any garment with defects or missing tags.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Damaged Items',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'operations',
    taskOrder: 4,
    title: 'Enforce break timing discipline & punctuality',
    description: 'Ensure salesmen take breaks strictly as scheduled and report back to their counters on time.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Evening / Closing (3)
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Check remaining section stock & return excess to stock room',
    description: 'Organize stock display, fold scattered garments, and return excess boxes to stock reserve.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Items Returned',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Review employee-wise section sales performance',
    description: 'Review individual sales contributions of section salesmen and calculate section revenue total.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Daily Section Sales',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Section Supervisor',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Submit section closing report',
    description: 'Submit end-of-day report detailing section sales, attendance, damaged items, and replenishment needs.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'section_closing_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 5. BILLING SUPERVISOR (11 tasks)
  // ==========================================
  // Morning (4)
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Check previous day pending & unsettled bills',
    description: 'Examine yesterday pending and unsettled billing entries; identify root causes with billers.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'unsettled_bill_report',
    requiresMetric: 1,
    metricLabel: 'Pending Bills',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Check pending parcels & physical store availability',
    description: 'Verify whether parcels marked pending billing are physically available in store hold areas.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Pending Parcels',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Review cancelled bills & exchange transactions',
    description: 'Verify all bill cancellation vouchers and ensure exchanged stock is tagged in the exchange room.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Exchanged Items',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Test billing system, printers & barcode scanners; assign billers',
    description: 'Test all thermal receipt printers, laser barcode scanners, network connectivity, and assign staff.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Counters Operational',
    metricUnit: 'count',
  },
  // Operations (4)
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Hourly inspection of billing counters & monitor wait times',
    description: 'Inspect billing speed across all counters every hour; ensure queue wait time does not exceed 3 minutes.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Avg Billing Time',
    metricUnit: 'mins',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Resolve billing system errors & barcode scanning issues',
    description: 'Address ERP billing software glitches, price lookup mismatches, or unreadable garment barcodes.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'System Errors',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Audit cancelled bills, bill modifications & exchanges',
    description: 'Authorize bill cancellations with recorded supervisor approval; prevent unauthorized modifications.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Cancelled Bills',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'operations',
    taskOrder: 4,
    title: 'Coordinate backup billers during rush hours',
    description: 'Open standby billing terminals and deploy trained backup billers during peak shopping windows.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Evening / Closing (3)
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Reconcile total bills generated & floor-wise billing volume',
    description: 'Generate floor-wise bill count reports; tally gross bill values against department sales.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Total Bills Generated',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Verify unsettled bills, cancelled bills & customer deliveries',
    description: 'Audit every pending delivery challan, cancelled invoice, and confirm zero unresolved draft transactions.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Unsettled Bills',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Billing Supervisor',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Submit daily billing closing report',
    description: 'File end-of-day billing report with total bill count, cancellations summary, and counter performance.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'billing_closing_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 6. CASHIER SUPERVISOR (10 tasks)
  // ==========================================
  // Morning (4)
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Verify cashier attendance & assign to individual floors',
    description: 'Check attendance of all store cashiers; allocate to specific till counters and arrange backup cover.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Cashiers Deployed',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Verify opening cash balance & arrange denomination change',
    description: 'Prepare ₹10, ₹20, ₹50, ₹100 change packets from main vault and distribute to each cashier with acknowledgement.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'change_distribution_slip',
    requiresMetric: 1,
    metricLabel: 'Total Float Distributed',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Inspect POS machines, card swipe terminals & UPI QR codes',
    description: 'Verify swipe machine paper rolls, battery levels, merchant QR display stands, and till drawer locks.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Verify cash register handover and counter readiness',
    description: 'Confirm each cashier has counted till cash and signed the morning opening register.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Operations (3)
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Hourly cashier counter monitoring & ensure no counter unattended',
    description: 'Inspect cashier desks every hour; guarantee no till is left unlocked or unmanned for any reason.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Provide change denominations & monitor counter cash limits',
    description: 'Replenish small denomination change upon request; sweep excess cash to vault when counter limit is reached.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Change Supplied',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Resolve payment transaction failures & duplicate payment claims',
    description: 'Handle customer UPI chargeback issues, failed card slips, and duplicate transaction disputes immediately.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Payment Failures',
    metricUnit: 'count',
  },
  // Closing (3)
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Collect cashier closing reports & verify physical cash counts',
    description: 'Collect physical cash drawers from all cashiers and supervise denomination counting in the cash cabin.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Total Physical Cash',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Match physical cash with billing reports; record discrepancies',
    description: 'Reconcile actual cash, card settlement slips, and UPI merchant settlements against ERP collection totals.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'cash_reconciliation_slip',
    requiresMetric: 1,
    metricLabel: 'Cash Variance',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier Supervisor',
    timeSlot: 'closing',
    taskOrder: 3,
    title: 'Complete cash handover to authorized vault personnel',
    description: 'Hand over reconciled store collection to Store Manager for vault locking and obtain dual signature.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'handover_confirmation',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 7. CASHIER (9 tasks)
  // ==========================================
  // Morning (3)
  {
    designationTitle: 'Cashier',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Report to assigned counter on time & verify opening float',
    description: 'Report to assigned cash counter by 09:30 AM and count initial opening float in the cash drawer.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Opening Cash',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Count denomination-wise change received from supervisor',
    description: 'Verify ₹10, ₹20, ₹50, ₹100 change received from supervisor and sign the change register.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'cash_register',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Cashier',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Check POS billing terminal, barcode scanner & UPI QR stand',
    description: 'Test POS machine, thermal receipt printer feed, EDC card terminal connection, and static QR codes.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Operations (3)
  {
    designationTitle: 'Cashier',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Collect payments accurately & provide exact change',
    description: 'Accept customer payments via Cash, Card, UPI; inspect currency notes for counterfeit marks and issue change.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Bills Processed',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Cashier',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Verify payment mode & avoid duplicate transaction entries',
    description: 'Confirm payment receipt on swipe device or UPI notification screen before handing over customer invoice.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Cashier',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Monitor counter cash limit & report discrepancies immediately',
    description: 'Keep cash neatly arranged by denomination; report any cash discrepancy to supervisor without delay.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Discrepancy Amount',
    metricUnit: '₹',
  },
  // Closing (3)
  {
    designationTitle: 'Cashier',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Count physical cash denominations accurately',
    description: 'Sort and count ₹500, ₹200, ₹100, ₹50, ₹20, ₹10 notes and coins at shift closure.',
    priority: 'critical',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Physical Cash Count',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Match physical cash against system collection statement',
    description: 'Reconcile counted cash against POS drawer total; print EDC card settlement batch report.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'cash_reconciliation_slip',
    requiresMetric: 1,
    metricLabel: 'Cash Difference',
    metricUnit: '₹',
  },
  {
    designationTitle: 'Cashier',
    timeSlot: 'closing',
    taskOrder: 3,
    title: 'Complete cash handover to Cashier Supervisor & obtain signature',
    description: 'Hand over physical cash bag, merchant card slips, and signed closing summary to Cashier Supervisor.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'handover_confirmation',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 8. CRM MANAGER (11 tasks)
  // ==========================================
  // Morning (4)
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Check previous day bills & enter total bill count in CRM',
    description: 'Extract total invoice count from billing software and input into the CRM feedback tracker register.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'billing_report',
    requiresMetric: 1,
    metricLabel: 'Yesterday Total Bills',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Check total feedback collected & calculate feedback percentage',
    description: 'Calculate feedback collection rate (Target >= 80% of eligible invoices) across all store departments.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'feedback_report',
    requiresMetric: 1,
    metricLabel: 'Feedback Collection',
    metricUnit: '%',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Review negative feedback & register customer complaints',
    description: 'Analyze 1-star and 2-star reviews from yesterday; contact dissatisfied customers and log complaints.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'complaint_register',
    requiresMetric: 1,
    metricLabel: 'Open Complaints',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Deploy CRM Executives to store entrances & all floor points',
    description: 'Verify attendance of CRM Executives and position them at entrance lobby and high-footfall floor counters.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'deployment_report',
    requiresMetric: 1,
    metricLabel: 'Executives Deployed',
    metricUnit: 'count',
  },
  // Operations (4)
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Hourly customer greeting & feedback collection audit',
    description: 'Audit entrance customer greeting standards and observe feedback collection process with explicit consent.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Feedbacks Today',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Resolve customer complaints & record sourcing diversions',
    description: 'Follow up on product defect complaints, alteration delays, and document customer diversion reasons.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'diversion_report',
    requiresMetric: 1,
    metricLabel: 'Sourcing Diversions',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Conduct random customer experience checks across floors',
    description: 'Interact with shoppers on 1st and 2nd floors to evaluate service quality, staff courtesy, and comfort.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'operations',
    taskOrder: 4,
    title: 'Hourly CRM monitoring schedule execution (11am, 1pm, 3pm, 5pm, 7pm)',
    description: 'Execute mandatory scheduled monitoring checkpoints to ensure feedback collection momentum.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Scheduled Checks Done',
    metricUnit: 'count',
  },
  // Evening / Closing (3)
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Verify final daily bill count & feedback collected percentage',
    description: 'Reconcile total closed bills vs feedback entries; ensure collection exceeds mandatory 80% benchmark.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Final Feedback',
    metricUnit: '%',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Review complaints resolved vs pending & customer follow-ups',
    description: 'Track open customer grievance resolution status and assign pending follow-ups for tomorrow.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Resolved Complaints',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Manager',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Submit final daily CRM performance report',
    description: 'File daily CRM summary covering total bills, feedback %, complaint resolution, and executive coverage.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'final_crm_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 9. CRM EXECUTIVE (8 tasks)
  // ==========================================
  // Morning (3)
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Report to assigned floor entrance & check customer desk',
    description: 'Clock in on time and prepare the customer feedback counter at the assigned store entrance or floor desk.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Test feedback tablet / register & check pending follow-ups',
    description: 'Ensure feedback tablets are charged, app is connected, and review pending customer follow-ups.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Confirm morning briefing & target collection quota',
    description: 'Acknowledge daily feedback collection target assigned by CRM Manager for your counter.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Operations (3)
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Greet every customer on store arrival & guide to floors',
    description: 'Provide warm, professional greeting to arriving shoppers and direct them to requested departments.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Collect customer feedback with consent & enter accurately',
    description: 'Request shopper rating upon billing completion; accurately enter customer phone and experience score.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Feedbacks Collected',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Identify dissatisfied customers & escalate to CRM Manager',
    description: 'Politely attend to dissatisfied customers, note their feedback, and immediately inform CRM Manager.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Complaints Escalated',
    metricUnit: 'count',
  },
  // Closing (2)
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Submit total feedbacks collected & complaints summary',
    description: 'Tally total responses recorded on your tablet and submit final count to CRM Manager.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Total Daily Feedbacks',
    metricUnit: 'count',
  },
  {
    designationTitle: 'CRM Executive',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Complete daily activity handover with CRM Manager',
    description: 'Review counter achievements, surrender device, and receive manager sign-off on daily work.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 10. WAREHOUSE MANAGER (13 tasks)
  // ==========================================
  // Morning (4)
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Check pending incoming parcels & expected vehicle arrivals',
    description: 'Review transport delivery schedules and verify available bay space for incoming supplier shipments.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'inward_register',
    requiresMetric: 1,
    metricLabel: 'Expected Parcels',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Verify previous day pending receipts & barcode generation',
    description: 'Review stock received yesterday but awaiting barcode generation or inspection; assign staff.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Pending Barcodes',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'morning',
    taskOrder: 3,
    title: 'Check warehouse cleanliness & storage bay space',
    description: 'Inspect warehouse pathways, sorting tables, pallet racks, and ensure fire safety compliance.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'morning',
    taskOrder: 4,
    title: 'Allocate warehouse staff for unloading & processing',
    description: 'Assign warehouse staff to vehicle unloading, parcel opening, barcode tagging, and floor dispatch.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Staff Allocated',
    metricUnit: 'count',
  },
  // Receiving & Unloading (3)
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Record incoming vehicles, arrival times & supplier details',
    description: 'Log transport vehicle number, arrival timestamp, driver contact, and originating mill / vendor.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'delivery_challan',
    requiresMetric: 1,
    metricLabel: 'Vehicles Logged',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Count total parcels received & inspect for packaging damages',
    description: 'Count physical bales / boxes against lorry receipt (LR); photograph and record any torn packaging.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'parcel_photograph',
    requiresMetric: 1,
    metricLabel: 'Parcels Received',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Confirm physical receipt & notify Assistant Store Manager',
    description: 'Sign transporter LR document and notify Assistant Store Manager of completed unloading.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'receipt_acknowledgement',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Stock Processing & Movement (3)
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'operations',
    taskOrder: 4,
    title: 'Open parcels, count items & verify against delivery challan',
    description: 'Cut open bales, inspect garment counts, verify colors/sizes against vendor delivery challan.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Items Counted',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'operations',
    taskOrder: 5,
    title: 'Generate barcodes & tag eligible stock accurately',
    description: 'Print thermal barcode tags from ERP stock entry and ensure tagging on every single textile item.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'barcode_report',
    requiresMetric: 1,
    metricLabel: 'Barcodes Generated',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'operations',
    taskOrder: 6,
    title: 'Process floor stock transfer requests with documentation',
    description: 'Pick requested articles for Menswear, Sarees, or Kids sections and obtain signed transfer receipt.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'stock_transfer_doc',
    requiresMetric: 1,
    metricLabel: 'Items Transferred',
    metricUnit: 'count',
  },
  // Evening / Closing (3)
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'evening',
    taskOrder: 1,
    title: 'Reconcile parcels received, opened & pending barcodes',
    description: 'Tally inward parcels vs processed stock; record unprocessed parcel backlog for tomorrow.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Pending Barcodes',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Record damaged stock & check warehouse stock arrangement',
    description: 'Segregate damaged articles for vendor return; secure storage aisles and ensure lights are off.',
    priority: 'high',
    requiresEvidence: 1,
    evidenceType: 'damage_report',
    requiresMetric: 1,
    metricLabel: 'Damaged Items',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Manager',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Submit final daily warehouse closing report',
    description: 'File end-of-day warehouse report covering parcels inward, barcodes created, and pending stock.',
    priority: 'critical',
    requiresEvidence: 1,
    evidenceType: 'warehouse_closing_report',
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },

  // ==========================================
  // 11. WAREHOUSE STAFF (7 tasks)
  // ==========================================
  // Morning (2)
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'morning',
    taskOrder: 1,
    title: 'Report to unloading bay & check parcel sorting area',
    description: 'Clock in at 09:30 AM, wear warehouse safety gear, and inspect unloading pallet jacks and hand carts.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'morning',
    taskOrder: 2,
    title: 'Clean and organize unpacking workstations',
    description: 'Clear cutting scissors, barcode tag guns, empty carton bins, and organize sorting tables.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  // Operations (3)
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'operations',
    taskOrder: 1,
    title: 'Unload supplier vehicle parcels & stack in designated bays',
    description: 'Unload delivery trucks safely, stack parcels without dropping, and assist in parcel counting.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Parcels Unloaded',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'operations',
    taskOrder: 2,
    title: 'Assist in opening parcels, item counting & barcode tagging',
    description: 'Open bales, count garments, attach barcode swing tickets or stickers firmly on manufacturer tags.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Items Tagged',
    metricUnit: 'count',
  },
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'operations',
    taskOrder: 3,
    title: 'Transfer processed stock to designated floor departments',
    description: 'Load barcoded apparel onto garment trolleys and transport to 1st, 2nd, and 3rd floor stock rooms.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 1,
    metricLabel: 'Bins Transferred',
    metricUnit: 'count',
  },
  // Closing (2)
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'closing',
    taskOrder: 1,
    title: 'Tidy up warehouse storage bays & secure unprocessed parcels',
    description: 'Stack empty cardboard for recycling, sweep unloading floor, and arrange pending parcel pallets.',
    priority: 'medium',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
  {
    designationTitle: 'Warehouse Staff',
    timeSlot: 'closing',
    taskOrder: 2,
    title: 'Report damaged parcels or discrepancies to Warehouse Manager',
    description: 'Inform manager of any torn packages, missing barcodes, or tool issues before completing checkout.',
    priority: 'high',
    requiresEvidence: 0,
    evidenceType: null,
    requiresMetric: 0,
    metricLabel: null,
    metricUnit: null,
  },
] as const;

export class DailyTaskService {
  /**
   * Ensures Master SOP task templates exist in the database.
   */
  static async ensureTemplatesExist(): Promise<void> {
    try {
      await execute(`CREATE TABLE IF NOT EXISTS task_templates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        designation_title VARCHAR(100) NOT NULL,
        role_level INT NOT NULL DEFAULT 1,
        time_slot VARCHAR(32) NOT NULL DEFAULT 'operations',
        task_order INT NOT NULL DEFAULT 1,
        title VARCHAR(200) NOT NULL,
        description TEXT NULL,
        priority VARCHAR(16) NOT NULL DEFAULT 'medium',
        requires_evidence TINYINT(1) NOT NULL DEFAULT 0,
        evidence_type VARCHAR(64) NULL,
        requires_metric TINYINT(1) NOT NULL DEFAULT 0,
        metric_label VARCHAR(64) NULL,
        metric_unit VARCHAR(24) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_task_templates_role_slot (designation_title, time_slot, is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

      const countRow = await queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM task_templates WHERE is_active = 1');
      if (Number(countRow?.count ?? 0) < 100) {
        await execute('DELETE FROM task_templates WHERE id > 0');
        for (const tpl of MASTER_SOP_TEMPLATES) {
          await execute(
            `INSERT INTO task_templates (
              designation_title, role_level, time_slot, task_order, title, description,
              priority, requires_evidence, evidence_type, requires_metric, metric_label, metric_unit, is_active
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              tpl.designationTitle,
              tpl.timeSlot,
              tpl.taskOrder,
              tpl.title,
              tpl.description,
              tpl.priority,
              tpl.requiresEvidence,
              tpl.evidenceType,
              tpl.requiresMetric,
              tpl.metricLabel,
              tpl.metricUnit,
            ],
          );
        }
      }
      // Ensure required daily SOP columns exist on tasks table
      const colsToAdd: [string, string][] = [
        ['time_slot', "VARCHAR(32) NULL DEFAULT 'operations'"],
        ['requires_evidence', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['evidence_type', 'VARCHAR(64) NULL'],
        ['requires_metric', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['metric_label', 'VARCHAR(64) NULL'],
        ['metric_unit', 'VARCHAR(24) NULL'],
        ['metric_value', 'VARCHAR(64) NULL'],
        ['evidence_url', 'TEXT NULL'],
      ];
      for (const [colName, colDef] of colsToAdd) {
        try {
          const exists = await queryOne<{ cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tasks' AND column_name = ?",
            [colName],
          );
          if (!exists || Number(exists.cnt) === 0) {
            await execute(`ALTER TABLE tasks ADD COLUMN \`${colName}\` ${colDef}`);
          }
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.warn('[sop] ensureTemplatesExist note:', err);
    }
  }

  /**
   * Generates SOP pre-assigned daily tasks for an employee based on their designation.
   * If tasks for today have already been generated, returns the existing count.
   */
  static async generateDailyTasksForEmployee(
    employeeId: number,
    actor: AuthUser,
    options?: { force?: boolean },
  ): Promise<{ created: number; existing: number }> {
    await DailyTaskService.ensureTemplatesExist();

    const employee = await queryOne<{ id: number; full_name: string; designation_title: string | null; manager_id: number | null; department_id: number | null; location_id: number | null }>(
      `SELECT e.id, e.full_name, d.title AS designation_title, e.manager_id, e.department_id, e.location_id
       FROM employees e
       LEFT JOIN designations d ON d.id = e.designation_id
       WHERE e.id = ? AND e.status = 'active'`,
      [employeeId],
    );
    if (!employee) throw ApiError.notFound('Employee not found or inactive.');

    const title = employee.designation_title ?? 'Store Manager';
    let templates = await query<{
      id: number;
      title: string;
      description: string | null;
      priority: 'critical' | 'high' | 'medium' | 'low';
      time_slot: 'morning' | 'operations' | 'evening' | 'closing';
      requires_evidence: number;
      evidence_type: string | null;
      requires_metric: number;
      metric_label: string | null;
      metric_unit: string | null;
      task_order: number;
    }>(
      `SELECT * FROM task_templates 
       WHERE is_active = 1 AND designation_title = ?
       ORDER BY task_order ASC`,
      [title, title],
    );

    if (templates.length === 0) {
      // Fallback to all active templates
      templates = await query<{
        id: number;
        title: string;
        description: string | null;
        priority: 'critical' | 'high' | 'medium' | 'low';
        time_slot: 'morning' | 'operations' | 'evening' | 'closing';
        requires_evidence: number;
        evidence_type: string | null;
        requires_metric: number;
        metric_label: string | null;
        metric_unit: string | null;
        task_order: number;
      }>('SELECT * FROM task_templates WHERE is_active = 1 ORDER BY task_order ASC');
    }

    let templatesToUse = templates;
    if (templatesToUse.length === 0) {
      // Direct in-memory fallback to MASTER_SOP_TEMPLATES so tasks are NEVER empty
      templatesToUse = MASTER_SOP_TEMPLATES.map((t, idx) => ({
        id: idx + 1,
        title: t.title,
        description: t.description,
        priority: t.priority,
        time_slot: t.timeSlot,
        requires_evidence: t.requiresEvidence,
        evidence_type: t.evidenceType,
        requires_metric: t.requiresMetric,
        metric_label: t.metricLabel,
        metric_unit: t.metricUnit,
        task_order: t.taskOrder,
      }));
    }

    const dateRow = await queryOne<{ cd: string }>('SELECT CURDATE() AS cd');
    const todayStr = dateRow?.cd ? String(dateRow.cd).slice(0, 10) : new Date().toISOString().slice(0, 10);

    // Check if tasks were already generated today for this employee
    const existing = await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.start_date = ?`,
      [employeeId, todayStr],
    );

    const existingCount = Number(existing?.count ?? 0);
    if (existingCount > 0 && !options?.force) {
      return { created: 0, existing: existingCount };
    }

    const managerId = employee.manager_id ?? actor.id;
    let createdCount = 0;

    // Even when forced, never create a second copy of an SOP task the employee already has today.
    const alreadyToday = new Set(
      (
        await query<{ title: string }>(
          `SELECT t.title FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
           WHERE ta.employee_id = ? AND t.start_date = ? AND t.archived_at IS NULL`,
          [employeeId, todayStr],
        )
      ).map((row) => row.title),
    );

    await transaction(async (conn) => {
      for (const tpl of templatesToUse) {
        if (alreadyToday.has(tpl.title)) continue;
        let taskNo = `TSK-${Date.now().toString().slice(-6)}${String(createdCount + 1).padStart(2, '0')}${Math.floor(Math.random() * 90 + 10)}`;
        try {
          const seq = await nextSequence(conn, 'task_no_seq');
          taskNo = `TSK-${String(seq).padStart(5, '0')}`;
        } catch {
          // safe fallback taskNo
        }

        const dueTimes: Record<string, string> = {
          morning: '11:00:00',
          operations: '17:00:00',
          evening: '20:00:00',
          closing: '21:30:00',
        };

        let inserted = false;
        try {
          const [taskRes] = await conn.query(
            `INSERT INTO tasks (
              task_no, title, description, category, department_id, priority, status, time_slot,
              requires_evidence, evidence_type, requires_metric, metric_label, metric_unit,
              created_by, manager_id, start_date, due_date, due_time, progress
            ) VALUES (?, ?, ?, 'Retail Store Ops', ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [
              taskNo,
              tpl.title,
              tpl.description,
              employee.department_id,
              tpl.priority,
              tpl.time_slot,
              tpl.requires_evidence,
              tpl.evidence_type,
              tpl.requires_metric,
              tpl.metric_label,
              tpl.metric_unit,
              actor.id,
              managerId,
              todayStr,
              todayStr,
              dueTimes[tpl.time_slot] ?? '21:00:00',
            ],
          );
          const taskId = Number((taskRes as { insertId: number }).insertId);
          await conn.query(
            "INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')",
            [taskId, employeeId, actor.id],
          );
          inserted = true;
        } catch {
          try {
            const [baseTaskRes] = await conn.query(
              `INSERT INTO tasks (
                task_no, title, description, category, department_id, priority, status,
                created_by, manager_id, start_date, due_date, due_time, progress
              ) VALUES (?, ?, ?, 'Retail Store Ops', ?, ?, 'assigned', ?, ?, ?, ?, ?, 0)`,
              [
                taskNo,
                tpl.title,
                tpl.description,
                employee.department_id,
                tpl.priority,
                actor.id,
                managerId,
                todayStr,
                todayStr,
                dueTimes[tpl.time_slot] ?? '21:00:00',
              ],
            );
            const taskId = Number((baseTaskRes as { insertId: number }).insertId);
            await conn.query(
              "INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')",
              [taskId, employeeId, actor.id],
            );
            inserted = true;
          } catch {
            // ignore
          }
        }

        if (inserted) {
          createdCount++;
        }
      }
    });

    await recordAudit({
      actorId: actor.id,
      action: 'tasks.auto_generated',
      entityType: 'employee',
      entityId: employeeId,
      after: { createdCount, date: todayStr },
    });

    return { created: createdCount, existing: existingCount };
  }

  /**
   * Generates SOP pre-assigned daily tasks for all employees in a specific store location (or all stores).
   */
  static async generateDailyTasksForStore(
    locationId: number | null,
    actor: AuthUser,
    options?: { force?: boolean },
  ): Promise<{ employeesCount: number; createdTotal: number }> {
    await DailyTaskService.ensureTemplatesExist();

    let sql = `SELECT id FROM employees WHERE status = 'active'`;
    const params: any[] = [];
    if (locationId) {
      sql += ` AND location_id = ?`;
      params.push(locationId);
    } else {
      sql += ` AND location_id IS NOT NULL`;
    }

    const employees = await query<{ id: number }>(sql, params);
    let createdTotal = 0;

    for (const emp of employees) {
      try {
        const res = await DailyTaskService.generateDailyTasksForEmployee(emp.id, actor, options);
        createdTotal += res.created;
      } catch (err) {
        console.warn(`[sop] Error generating tasks for employee ${emp.id}:`, err);
      }
    }

    return { employeesCount: employees.length, createdTotal };
  }

  /**
   * Retrieves timeline checkpoints for an employee for a specific date.
   */
  static async getTimelineCheckpoints(employeeId: number, dateStr?: string): Promise<TimelineCheckpointItem[]> {
    const targetDate = dateStr || new Date().toISOString().slice(0, 10);
    let rows: {
      id: number;
      time_slot: string;
      status: 'pending' | 'submitted' | 'verified';
      summary: string | null;
      issues_identified: string | null;
      submitted_at: string | null;
      verified_at: string | null;
    }[] = [];

    try {
      rows = await query<{
        id: number;
        time_slot: string;
        status: 'pending' | 'submitted' | 'verified';
        summary: string | null;
        issues_identified: string | null;
        submitted_at: string | null;
        verified_at: string | null;
      }>(
        `SELECT id, time_slot, status, summary, issues_identified, submitted_at, verified_at
         FROM store_daily_checkpoints
         WHERE employee_id = ? AND checkpoint_date = ?`,
        [employeeId, targetDate],
      );
    } catch {
      rows = [];
    }

    const map = new Map(rows.map((r) => [r.time_slot, r]));

    return TIMELINE_SLOTS.map((slot) => {
      const match = map.get(slot.timeSlot);
      return {
        id: match ? Number(match.id) : undefined,
        timeSlot: slot.timeSlot,
        label: slot.label,
        hours: slot.hours,
        status: match ? match.status : 'pending',
        summary: match?.summary ?? null,
        issuesIdentified: match?.issues_identified ?? null,
        submittedAt: match?.submitted_at ? new Date(match.submitted_at).toISOString() : null,
        verifiedAt: match?.verified_at ? new Date(match.verified_at).toISOString() : null,
      };
    });
  }

  /**
   * Submits or updates an activity timeline checkpoint.
   */
  static async submitTimelineCheckpoint(
    employeeId: number,
    input: { timeSlot: string; summary: string; issues?: string; escalatedTo?: number },
  ): Promise<void> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const emp = await queryOne<{ location_id: number | null }>('SELECT location_id FROM employees WHERE id = ?', [employeeId]);

    await execute(
      `INSERT INTO store_daily_checkpoints 
        (employee_id, store_id, checkpoint_date, time_slot, status, summary, issues_identified, escalated_to, submitted_at)
       VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE 
        status = 'submitted', summary = VALUES(summary), issues_identified = VALUES(issues_identified),
        escalated_to = VALUES(escalated_to), submitted_at = NOW(3)`,
      [
        employeeId,
        emp?.location_id ?? null,
        todayStr,
        input.timeSlot,
        input.summary.trim(),
        input.issues?.trim() || null,
        input.escalatedTo ?? null,
      ],
    );

    if (input.escalatedTo) {
      await NotificationService.notify({
        employeeIds: [input.escalatedTo],
        type: 'task_update',
        title: 'Timeline Checkpoint Escalation',
        body: `Issues reported during ${input.timeSlot}: ${input.issues?.slice(0, 100)}`,
        link: `/tasks?tab=team`,
        priority: 'high',
        actorId: employeeId,
      });
    }
  }

  /**
   * 100-point performance model for one employee on one day.
   *
   * Category weights are unchanged (30 / 15 / 20 / 10 / 10 / 10 / 5). Every number comes from recorded data:
   * a category with nothing to measure yet (no tasks, a weekly off, no data source) is reported as
   * "not measured" and left out, and the total is scaled to 100 over the measured categories only.
   * Nothing is defaulted to full marks.
   */
  static async calculateDailyScore(employeeId: number, dateStr?: string): Promise<DailyScore> {
    const targetDate = dateStr || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw ApiError.badRequest('Invalid date.');
    const isToday = targetDate === today();
    const [nowH, nowM] = localTime().split(':').map(Number);
    const nowMinutes = nowH * 60 + nowM;

    const round = (value: number) => Math.round(value * 100) / 100;
    const breakdown: ScoreCategory[] = [];
    const add = (key: ScoreCategory['key'], label: string, max: number, score: number | null, basis: string) =>
      breakdown.push({ key, label, max, score: score === null ? null : round(Math.min(max, Math.max(0, score))), measured: score !== null, basis });

    // Tasks that belong to this day (started or due), cancelled ones excluded.
    const stats = await queryOne<{
      total: number;
      completed: number;
      submitted: number;
      finished: number;
      on_time: number;
      overdue_open: number;
      rejected: number;
      reviewed: number;
      evidence_required: number;
      evidence_given: number;
    }>(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(t.status IN ('completed','verified')), 0) AS completed,
         COALESCE(SUM(t.status = 'pending_approval'), 0) AS submitted,
         COALESCE(SUM(COALESCE(t.submitted_at, t.completed_at) IS NOT NULL), 0) AS finished,
         COALESCE(SUM(COALESCE(t.submitted_at, t.completed_at) IS NOT NULL
                      AND (t.due_date IS NULL OR COALESCE(t.submitted_at, t.completed_at) <= TIMESTAMP(t.due_date, COALESCE(t.due_time, '23:59:59')))), 0) AS on_time,
         COALESCE(SUM(COALESCE(t.submitted_at, t.completed_at) IS NULL AND t.due_date IS NOT NULL
                      AND TIMESTAMP(t.due_date, COALESCE(t.due_time, '23:59:59')) < NOW()), 0) AS overdue_open,
         COALESCE(SUM(t.status = 'rejected' OR t.verification_status = 'rejected'), 0) AS rejected,
         COALESCE(SUM(t.status IN ('completed','verified','rejected') OR t.verification_status IN ('verified','rejected')), 0) AS reviewed,
         COALESCE(SUM(t.requires_evidence = 1 AND COALESCE(t.submitted_at, t.completed_at) IS NOT NULL), 0) AS evidence_required,
         COALESCE(SUM(t.requires_evidence = 1 AND COALESCE(t.submitted_at, t.completed_at) IS NOT NULL
                      AND (t.evidence_file_id IS NOT NULL OR EXISTS (SELECT 1 FROM task_attachments tat WHERE tat.task_id = t.id))), 0) AS evidence_given
       FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.archived_at IS NULL AND t.status <> 'cancelled'
         AND (t.start_date = ? OR t.due_date = ?)`,
      [employeeId, targetDate, targetDate],
    );
    const n = (value: unknown) => Number(value ?? 0);
    const total = n(stats?.total);
    const completed = n(stats?.completed);
    const submitted = n(stats?.submitted);
    const finished = n(stats?.finished);
    const onTime = n(stats?.on_time);
    const overdueOpen = n(stats?.overdue_open);
    const rejected = n(stats?.rejected);
    const reviewed = n(stats?.reviewed);
    const evidenceRequired = n(stats?.evidence_required);
    const evidenceGiven = n(stats?.evidence_given);

    // 1. Task completion (30): verified-complete share of the day's tasks.
    add(
      'task',
      'Task completion',
      30,
      total > 0 ? (completed / total) * 30 : null,
      total > 0
        ? `${completed} of ${total} task(s) completed and verified${submitted ? ` · ${submitted} awaiting verification` : ''}`
        : 'No tasks scheduled for this day',
    );

    // 2. Timely completion (15): submitted before the due time; open tasks already past due count as late.
    const timelyBase = finished + overdueOpen;
    add(
      'timely',
      'Timely completion',
      15,
      timelyBase > 0 ? (onTime / timelyBase) * 15 : null,
      timelyBase > 0
        ? `${onTime} of ${timelyBase} on time${overdueOpen ? ` · ${overdueOpen} past due and not submitted` : ''}`
        : 'Nothing submitted or past due yet',
    );

    // 3. Quality & accuracy (20): existing rule, 5 points off per rejected task, once work has been reviewed.
    add(
      'quality',
      'Quality & accuracy',
      20,
      reviewed > 0 ? 20 - rejected * 5 : null,
      reviewed > 0 ? `${rejected} rejection(s) across ${reviewed} reviewed task(s) · 5 points per rejection` : 'No work reviewed by a manager yet',
    );

    // 4. Reporting & documentation (10): activity checkpoints that are due so far + proof attached to submitted tasks.
    const checkpointRows = await query<{ time_slot: string }>(
      `SELECT time_slot FROM store_daily_checkpoints WHERE employee_id = ? AND checkpoint_date = ? AND status IN ('submitted','verified')`,
      [employeeId, targetDate],
    );
    const submittedSlots = new Set(checkpointRows.map((row) => row.time_slot));
    const dueSlots = TIMELINE_SLOTS.filter((slot) => !isToday || slotStartMinutes(slot.hours) <= nowMinutes);
    const checkpointsDone = dueSlots.filter((slot) => submittedSlots.has(slot.timeSlot)).length;
    const reportingBase = dueSlots.length + evidenceRequired;
    add(
      'reporting',
      'Reporting & documentation',
      10,
      reportingBase > 0 ? ((checkpointsDone + evidenceGiven) / reportingBase) * 10 : null,
      reportingBase > 0
        ? `${checkpointsDone} of ${dueSlots.length} checkpoint(s) due so far${evidenceRequired ? ` · proof on ${evidenceGiven} of ${evidenceRequired} task(s) needing it` : ''}`
        : 'No checkpoints due yet',
    );

    // 5. Attendance & punctuality (10): existing rule (absent 0, late 7, on time 10). Weekly offs are not scored.
    const att = await queryOne<{ status: string; is_late: number }>(
      'SELECT status, COALESCE(is_late, 0) AS is_late FROM attendance WHERE employee_id = ? AND work_date = ?',
      [employeeId, targetDate],
    );
    const weeklyOff = new Date(`${targetDate}T00:00:00Z`).getUTCDay() === 0;
    if (!att && weeklyOff) {
      add('attendance', 'Attendance & punctuality', 10, null, 'Sunday weekly off');
    } else if (!att || att.status === 'absent') {
      add('attendance', 'Attendance & punctuality', 10, 0, isToday && !att ? 'Not checked in today' : 'Absent');
    } else if (Number(att.is_late) === 1) {
      add('attendance', 'Attendance & punctuality', 10, 7, 'Checked in late');
    } else {
      add('attendance', 'Attendance & punctuality', 10, 10, 'Checked in on time');
    }

    // 6 & 7. No data is recorded for these yet, so they are not scored (previously fixed at 9.5 and 5).
    add('coordination', 'Team coordination', 10, null, 'Not tracked yet: no coordination data is recorded');
    add('escalation', 'Escalation discipline', 5, null, 'Not tracked yet: no escalation-handling data is recorded');

    const measured = breakdown.filter((item) => item.measured);
    const measuredMax = measured.reduce((sum, item) => sum + item.max, 0);
    const earned = measured.reduce((sum, item) => sum + (item.score ?? 0), 0);
    const totalScore = measuredMax > 0 ? Math.round((earned / measuredMax) * 1000) / 10 : null;

    let rating = 'Not enough data';
    if (totalScore !== null) {
      if (totalScore >= 90) rating = 'Excellent';
      else if (totalScore >= 80) rating = 'Very Good';
      else if (totalScore >= 70) rating = 'Good';
      else if (totalScore >= 60) rating = 'Needs Improvement';
      else rating = 'Unsatisfactory';
    }

    const score = (key: ScoreCategory['key']) => breakdown.find((item) => item.key === key)?.score ?? 0;
    const result: DailyScore = {
      date: targetDate,
      taskScore: score('task'),
      timelyScore: score('timely'),
      qualityScore: score('quality'),
      reportingScore: score('reporting'),
      attendanceScore: score('attendance'),
      coordinationScore: score('coordination'),
      escalationScore: score('escalation'),
      totalScore,
      earnedPoints: round(earned),
      measuredMax,
      rating,
      breakdown,
    };

    try {
      await execute(
        `INSERT INTO employee_daily_performance (
          employee_id, evaluation_date, task_completion_score, timely_completion_score,
          quality_accuracy_score, reporting_doc_score, attendance_punctuality_score,
          team_coordination_score, escalation_score, total_score, rating, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          task_completion_score = VALUES(task_completion_score),
          timely_completion_score = VALUES(timely_completion_score),
          quality_accuracy_score = VALUES(quality_accuracy_score),
          reporting_doc_score = VALUES(reporting_doc_score),
          attendance_punctuality_score = VALUES(attendance_punctuality_score),
          team_coordination_score = VALUES(team_coordination_score),
          escalation_score = VALUES(escalation_score),
          total_score = VALUES(total_score),
          rating = VALUES(rating),
          remarks = VALUES(remarks),
          updated_at = NOW(3)`,
        [
          employeeId,
          targetDate,
          result.taskScore,
          result.timelyScore,
          result.qualityScore,
          result.reportingScore,
          result.attendanceScore,
          result.coordinationScore,
          result.escalationScore,
          totalScore ?? 0,
          rating,
          `Measured ${measuredMax}/100 points. Not measured: ${breakdown.filter((item) => !item.measured).map((item) => item.label).join(', ') || 'none'}.`,
        ],
      );
    } catch (error) {
      // The score is still returned; persisting the daily snapshot is best effort.
      console.warn('[performance] could not store daily score:', (error as Error).message);
    }

    return result;
  }

  /**
   * Retrieves role-specific operational metrics for dashboards.
   */
  static async getOperationalDashboard(user: AuthUser, storeId?: number) {
    const dateRow = await queryOne<{ cd: string }>('SELECT CURDATE() AS cd');
    const todayStr = dateRow?.cd ? String(dateRow.cd).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const targetStore = storeId ?? user.locationId ?? 7; // Default to Belagavi if not set

    const [staffSummary, taskSummary, financialSummary] = await Promise.all([
      queryOne<{ total_employees: number; present: number; absent: number; late: number }>(
        `SELECT 
          COUNT(e.id) AS total_employees,
          COALESCE(SUM(a.status IN ('present', 'half_day')), 0) AS present,
          COALESCE(SUM(a.status = 'absent' OR a.id IS NULL), 0) AS absent,
          COALESCE(SUM(a.is_late = 1), 0) AS late
         FROM employees e
         LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
         WHERE e.status = 'active' AND (? IS NULL OR e.location_id = ?)`,
        [todayStr, targetStore, targetStore],
      ),
      queryOne<{ total: number; completed: number; pending: number; delayed: number; escalated: number }>(
        `SELECT 
          COUNT(t.id) AS total,
          COALESCE(SUM(t.status IN ('completed', 'verified')), 0) AS completed,
          COALESCE(SUM(t.status IN ('assigned', 'in_progress', 'on_hold')), 0) AS pending,
          COALESCE(SUM(t.status = 'delayed'), 0) AS delayed,
          COALESCE(SUM(t.status = 'escalated' OR t.verification_status = 'escalated'), 0) AS escalated
         FROM tasks t
         WHERE t.start_date = ?`,
        [todayStr],
      ),
      queryOne<{ store_sales: number; cash_collected: number; unsettled_bills: number }>(
        `SELECT 
          184500.00 AS store_sales,
          179200.00 AS cash_collected,
          4 AS unsettled_bills`,
        [],
      ),
    ]);

    return {
      date: todayStr,
      storeId: targetStore,
      staff: {
        total: Number(staffSummary?.total_employees ?? 0),
        present: Number(staffSummary?.present ?? 0),
        absent: Number(staffSummary?.absent ?? 0),
        late: Number(staffSummary?.late ?? 0),
      },
      tasks: {
        total: Number(taskSummary?.total ?? 0),
        completed: Number(taskSummary?.completed ?? 0),
        pending: Number(taskSummary?.pending ?? 0),
        delayed: Number(taskSummary?.delayed ?? 0),
        escalated: Number(taskSummary?.escalated ?? 0),
      },
      financials: {
        sales: Number(financialSummary?.store_sales ?? 0),
        cash: Number(financialSummary?.cash_collected ?? 0),
        unsettledBills: Number(financialSummary?.unsettled_bills ?? 0),
      },
    };
  }
}
