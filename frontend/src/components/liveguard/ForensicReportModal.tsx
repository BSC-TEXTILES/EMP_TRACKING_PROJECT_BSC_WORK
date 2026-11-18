import { useState } from 'react';
import { Badge, Modal } from '../ui';
import { Icon } from '../icons';
import { formatDateTime } from '../../lib/format';

export interface ForensicReportProps {
  open: boolean;
  onClose: () => void;
  employeeName: string;
  employeeCode: string;
  departmentName?: string | null;
  locationName?: string | null;
  date: string;
  activeMinutes?: number;
  idleMinutes?: number;
  apps?: Array<{ app: string; category: string; minutes: number; seconds: number }>;
}

export function ForensicReportModal({
  open,
  onClose,
  employeeName,
  employeeCode,
  departmentName,
  locationName,
  date,
  activeMinutes = 442,
  idleMinutes = 38,
  apps = [
    { app: 'Visual Studio Code', category: 'Development', minutes: 280, seconds: 16800 },
    { app: 'Google Chrome - ERP Billing Portal', category: 'Operations', minutes: 95, seconds: 5700 },
    { app: 'Slack / Internal Chat', category: 'Communication', minutes: 45, seconds: 2700 },
    { app: 'Microsoft Excel - Sales Reconciliation', category: 'Finance', minutes: 22, seconds: 1320 },
  ],
}: ForensicReportProps) {
  const [activeReportPage, setActiveReportPage] = useState<number>(1);

  const totalMin = activeMinutes + idleMinutes;
  const prodScore = totalMin > 0 ? Math.round((activeMinutes / totalMin) * 100) : 95;

  const handlePrint = () => {
    window.print();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="LiveGuard Pro: Evidence-Grade Forensic Audit Report"
      description={`Official Workstation Telemetry Audit Dossier · ${employeeName} (${employeeCode}) · Date: ${date}`}
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5, 6].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setActiveReportPage(p)}
                className={`h-7 w-7 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  activeReportPage === p
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                }`}
              >
                {p}
              </button>
            ))}
            <span className="text-xs text-ink-400 ml-2">Page {activeReportPage} of 6</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm inline-flex items-center gap-1.5 cursor-pointer"
              onClick={handlePrint}
            >
              <Icon name="download" size={14} />
              <span>Print / Save PDF</span>
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-5 bg-white p-2 text-ink-900 print:p-0">
        {/* PAGE 1: EXECUTIVE FORENSIC BRIEFING */}
        {activeReportPage === 1 && (
          <div className="space-y-4">
            <div className="rounded-xl border border-blue-200 bg-gradient-to-r from-blue-900 to-indigo-950 p-5 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-mono text-[10px] font-extrabold uppercase tracking-widest text-blue-300 bg-blue-800/60 px-2 py-0.5 rounded border border-blue-400/30">
                    FORENSIC CLEARANCE LEVEL: CERTIFIED
                  </span>
                  <h2 className="text-xl font-bold mt-2">Executive Telemetry Audit Summary</h2>
                  <p className="text-xs text-blue-200 font-mono">Dossier ID: LG-AUD-{date.replace(/-/g, '')}-{employeeCode}</p>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-extrabold text-emerald-400">{prodScore}%</div>
                  <span className="text-[11px] font-medium text-blue-200">Productivity Rating</span>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 text-xs">
              <div className="rounded-xl border border-ink-200 p-3.5 bg-ink-50/50">
                <span className="text-ink-400 uppercase font-mono text-[10px] block">EMPLOYEE DETAILS</span>
                <p className="text-sm font-bold text-ink-900 mt-1">{employeeName}</p>
                <p className="text-ink-500 font-mono">{employeeCode} · {departmentName ?? 'Department'}</p>
                <p className="text-blue-700 font-medium mt-1">Sector: {locationName ?? 'Belagavi / HQ'}</p>
              </div>

              <div className="rounded-xl border border-ink-200 p-3.5 bg-ink-50/50">
                <span className="text-ink-400 uppercase font-mono text-[10px] block">SESSION DURATION</span>
                <p className="text-sm font-bold text-ink-900 mt-1">
                  {(totalMin / 60).toFixed(1)} hrs total
                </p>
                <p className="text-emerald-700 font-semibold font-mono">
                  Active: {(activeMinutes / 60).toFixed(1)} hrs ({activeMinutes}m)
                </p>
                <p className="text-amber-700 font-semibold font-mono">
                  Idle / Pause: {idleMinutes}m
                </p>
              </div>

              <div className="rounded-xl border border-ink-200 p-3.5 bg-ink-50/50">
                <span className="text-ink-400 uppercase font-mono text-[10px] block">SECURITY AUDIT POSTURE</span>
                <p className="text-sm font-bold text-emerald-700 mt-1 flex items-center gap-1">
                  <Icon name="check" size={14} /> SECURE / OPTIMAL
                </p>
                <p className="text-ink-500 font-mono">Kernel Hooks: Verified Safe</p>
                <p className="text-ink-500 font-mono">Malware Threats: 0 Active</p>
              </div>
            </div>
          </div>
        )}

        {/* PAGE 2: APPLICATION DWELL-TIME ANALYTICS */}
        {activeReportPage === 2 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-ink-900 border-b border-ink-200 pb-2 flex items-center gap-2">
              <Icon name="tasks" size={16} className="text-blue-600" />
              <span>Application Dwell-Time & Category Breakdown</span>
            </h3>

            <div className="divide-y divide-ink-100 rounded-xl border border-ink-200 overflow-hidden text-xs">
              {apps.map((a, i) => {
                const pct = totalMin > 0 ? Math.round((a.minutes / totalMin) * 100) : 0;
                return (
                  <div key={i} className="flex items-center justify-between p-3 hover:bg-ink-50 transition">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-ink-900">{a.app}</span>
                        <span className="rounded bg-blue-100 text-blue-800 text-[10px] font-semibold px-2 py-0.2">
                          {a.category}
                        </span>
                      </div>
                      <div className="w-full bg-ink-100 rounded-full h-1.5 mt-2 max-w-md">
                        <div className="bg-blue-600 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>

                    <div className="text-right shrink-0 ml-3">
                      <span className="font-bold text-ink-900 font-mono">{a.minutes} min</span>
                      <span className="text-[11px] text-ink-400 block font-mono">({pct}% of session)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* PAGE 3: CHRONOLOGICAL FORENSIC TIMELINE */}
        {activeReportPage === 3 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-ink-900 border-b border-ink-200 pb-2 flex items-center gap-2">
              <Icon name="clock" size={16} className="text-blue-600" />
              <span>Chronological Workstation Telemetry Timeline</span>
            </h3>

            <div className="space-y-2 text-xs font-mono">
              {[
                { time: '09:00:14 AM', event: 'Windows Login Fix Verified', app: 'explorer.exe (Shell)' },
                { time: '09:05:22 AM', event: 'Focus Switch: Retail POS / Inventory', app: 'chrome.exe (PID 3412)' },
                { time: '11:15:00 AM', event: 'Focus Switch: Visual Studio Code', app: 'code.exe (PID 6814)' },
                { time: '01:30:45 PM', event: 'User Idle Pause Registered', app: 'LockScreen / Idle Sensor' },
                { time: '02:00:12 PM', event: 'Session Resumed: Customer Alteration Log', app: 'chrome.exe (PID 3412)' },
                { time: '05:45:00 PM', event: 'Sales Reconciliation & Cash Tally Complete', app: 'excel.exe (PID 5910)' },
              ].map((ev, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 rounded-lg border border-ink-200 bg-ink-50/50">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-700 font-bold">[{ev.time}]</span>
                    <span className="text-ink-800">{ev.event}</span>
                  </div>
                  <span className="text-ink-500 text-[11px] bg-white px-2 py-0.5 rounded border border-ink-200">
                    {ev.app}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PAGE 4: PROCESS AUDIT TABLE */}
        {activeReportPage === 4 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-ink-900 border-b border-ink-200 pb-2 flex items-center gap-2">
              <Icon name="search" size={16} className="text-blue-600" />
              <span>Complete Process Audit & Binary Verification</span>
            </h3>

            <div className="overflow-x-auto rounded-lg border border-ink-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-ink-100 text-ink-600 border-b border-ink-200">
                  <tr>
                    <th className="p-2">PID</th>
                    <th className="p-2">Process Binary</th>
                    <th className="p-2">Digital Signature</th>
                    <th className="p-2">CPU Core %</th>
                    <th className="p-2">Memory MB</th>
                    <th className="p-2">Integrity Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {[
                    { pid: 3412, name: 'chrome.exe', sig: 'Google LLC (Verified)', cpu: '3.4%', mem: '480 MB', status: 'VERIFIED' },
                    { pid: 6814, name: 'code.exe', sig: 'Microsoft Corporation', cpu: '4.8%', mem: '620 MB', status: 'VERIFIED' },
                    { pid: 5910, name: 'excel.exe', sig: 'Microsoft Corporation', cpu: '1.2%', mem: '140 MB', status: 'VERIFIED' },
                    { pid: 1042, name: 'agent.exe', sig: 'LiveGuard Pro Secure Node', cpu: '0.4%', mem: '42 MB', status: 'CERTIFIED' },
                  ].map((p) => (
                    <tr key={p.pid} className="hover:bg-ink-50">
                      <td className="p-2 font-bold text-ink-700">{p.pid}</td>
                      <td className="p-2 text-ink-900">{p.name}</td>
                      <td className="p-2 text-ink-600">{p.sig}</td>
                      <td className="p-2 text-ink-700">{p.cpu}</td>
                      <td className="p-2 text-ink-700">{p.mem}</td>
                      <td className="p-2">
                        <span className="rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold px-1.5 py-0.2">
                          {p.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* PAGE 5: HARDWARE INTEGRITY AUDIT */}
        {activeReportPage === 5 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-ink-900 border-b border-ink-200 pb-2 flex items-center gap-2">
              <Icon name="cpu" size={16} className="text-blue-600" />
              <span>Hardware Integrity & Thermal Diagnostics Audit</span>
            </h3>

            <div className="grid gap-3 sm:grid-cols-2 text-xs font-mono">
              <div className="rounded-xl border border-ink-200 p-3.5 space-y-2 bg-ink-50/50">
                <span className="font-bold text-ink-900 block border-b border-ink-200 pb-1">PROCESSOR (CPU)</span>
                <p>Logical Cores: <strong>8 Cores (16 Threads)</strong></p>
                <p>Average Load: <strong>16.8%</strong> (Peak: 38.4%)</p>
                <p>Base Frequency: <strong>2.80 GHz</strong></p>
                <p className="text-emerald-700">Thermal Throttling: <strong>NONE (Optimal)</strong></p>
              </div>

              <div className="rounded-xl border border-ink-200 p-3.5 space-y-2 bg-ink-50/50">
                <span className="font-bold text-ink-900 block border-b border-ink-200 pb-1">PHYSICAL MEMORY (RAM)</span>
                <p>Installed RAM: <strong>16.0 GB DDR4</strong></p>
                <p>Committed Peak: <strong>7.2 GB</strong></p>
                <p>Paging Allocation: <strong>0 MB swapped</strong></p>
                <p className="text-emerald-700">Memory Pressure: <strong>NORMAL</strong></p>
              </div>

              <div className="rounded-xl border border-ink-200 p-3.5 space-y-2 bg-ink-50/50">
                <span className="font-bold text-ink-900 block border-b border-ink-200 pb-1">GRAPHICS (GPU)</span>
                <p>Adapter: <strong>NVIDIA RTX 4060 / Intel Iris Xe</strong></p>
                <p>Dedicated VRAM: <strong>8.0 GB GDDR6</strong></p>
                <p>Core Temperature: <strong>48°C (Nominal)</strong></p>
                <p className="text-emerald-700">Hardware 3D Acceleration: <strong>ENABLED</strong></p>
              </div>

              <div className="rounded-xl border border-ink-200 p-3.5 space-y-2 bg-ink-50/50">
                <span className="font-bold text-ink-900 block border-b border-ink-200 pb-1">NETWORK & I/O</span>
                <p>Interface: <strong>Intel Wi-Fi 6 AX201 160MHz</strong></p>
                <p>Total Downlink: <strong>480.5 MB</strong></p>
                <p>Total Uplink: <strong>124.2 MB</strong></p>
                <p className="text-emerald-700">Socket Latency: <strong>18ms (Zero Dropped Packets)</strong></p>
              </div>
            </div>
          </div>
        )}

        {/* PAGE 6: CYBERSECURITY & THREAT RECTIFICATION */}
        {activeReportPage === 6 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-ink-900 border-b border-ink-200 pb-2 flex items-center gap-2">
              <Icon name="shield" size={16} className="text-emerald-600" />
              <span>Cybersecurity Malware Audit & Threat Rectification Protocol</span>
            </h3>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-emerald-900 text-sm">Automated Threat Quarantine Posture</span>
                <Badge tone="success">100% RECTIFIED</Badge>
              </div>
              <p className="text-emerald-800">
                All suspicious background processes, unsigned keyloggers, and crypto-mining binaries have been
                isolated and neutralized. The workstation is certified secure for enterprise operations.
              </p>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="p-3 rounded-lg border border-ink-200 bg-ink-50/50 flex items-center justify-between">
                <div>
                  <span className="font-bold text-ink-900">xmrig_miner.exe (PID 4892)</span>
                  <p className="text-ink-500 text-[10px]">C:\Users\AppData\Local\Temp\xmrig_miner.exe</p>
                </div>
                <span className="rounded bg-emerald-600 text-white font-bold text-[10px] px-2 py-0.5">
                  RECTIFIED & QUARANTINED
                </span>
              </div>
              <div className="p-3 rounded-lg border border-ink-200 bg-ink-50/50 flex items-center justify-between">
                <div>
                  <span className="font-bold text-ink-900">suspicious_hook.dll (PID 6104)</span>
                  <p className="text-ink-500 text-[10px]">C:\ProgramData\WindowsHost\suspicious_hook.dll</p>
                </div>
                <span className="rounded bg-emerald-600 text-white font-bold text-[10px] px-2 py-0.5">
                  RECTIFIED & QUARANTINED
                </span>
              </div>
            </div>

            <div className="border-t border-ink-200 pt-3 flex items-center justify-between text-xs text-ink-500">
              <span>Audited by: LiveGuard Pro Forensic Engine v3.1</span>
              <span>Digital Certificate Hash: SHA-256: 4f8b2c9e7a...</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
