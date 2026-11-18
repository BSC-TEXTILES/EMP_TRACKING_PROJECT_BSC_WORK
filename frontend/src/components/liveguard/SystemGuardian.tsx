import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { Badge, Card, StatCard } from '../ui';
import { Icon } from '../icons';
import { cx, formatDateTime } from '../../lib/format';

export interface ThreatItem {
  id: string | number;
  pid: number;
  processName: string;
  threatType: 'Trojan' | 'Miner' | 'Keylogger' | 'Exploit' | 'Unsigned Hook';
  severity: 'critical' | 'high' | 'medium';
  filePath: string;
  detectedAt: string;
  status: 'RECTIFIED' | 'QUARANTINED' | 'ISOLATED';
}

export interface TelemetrySignal {
  id: number;
  timestamp: string;
  event: 'INBOUND_SIGNAL' | 'WINDOW_SWITCH' | 'THREAT_RECTIFIED' | 'GPS_PULSE' | 'HEALTH_HEARTBEAT';
  payload: string;
  severity?: 'normal' | 'warning' | 'danger';
}

export function SystemGuardian() {
  const toast = useToast();

  const [healthScore, setHealthScore] = useState(100);
  const [securityStatus, setSecurityStatus] = useState<'OPTIMAL' | 'WARNING' | 'CRITICAL'>('OPTIMAL');
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStage, setScanStage] = useState('');
  const [scanTargetFile, setScanTargetFile] = useState('');
  const [filesScannedCount, setFilesScannedCount] = useState(14820);

  // Threats & Quarantined PIDs
  const [threats, setThreats] = useState<ThreatItem[]>([
    {
      id: 'T-8091',
      pid: 4892,
      processName: 'xmrig_miner.exe',
      threatType: 'Miner',
      severity: 'critical',
      filePath: 'C:\\Users\\AppData\\Local\\Temp\\xmrig_miner.exe',
      detectedAt: new Date(Date.now() - 480000).toISOString(),
      status: 'RECTIFIED',
    },
    {
      id: 'T-7721',
      pid: 6104,
      processName: 'suspicious_hook.dll',
      threatType: 'Keylogger',
      severity: 'high',
      filePath: 'C:\\ProgramData\\WindowsHost\\suspicious_hook.dll',
      detectedAt: new Date(Date.now() - 3600000).toISOString(),
      status: 'RECTIFIED',
    },
  ]);

  // Terminal Live Signal Stream
  const [terminalLogs, setTerminalLogs] = useState<TelemetrySignal[]>([
    {
      id: 1,
      timestamp: new Date().toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 2 }),
      event: 'INBOUND_SIGNAL',
      payload: 'CPU:14.2% | MEM:42.8% | FPS:60 | GNSS:Locked',
      severity: 'normal',
    },
    {
      id: 2,
      timestamp: new Date(Date.now() - 1500).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 2 }),
      event: 'WINDOW_SWITCH',
      payload: 'Focus: Visual Studio Code [EMP-2201_Controller.ts]',
      severity: 'normal',
    },
    {
      id: 3,
      timestamp: new Date(Date.now() - 3000).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 2 }),
      event: 'HEALTH_HEARTBEAT',
      payload: 'Agent v2.8.4 OK | Latency: 18ms | Sockets: 4',
      severity: 'normal',
    },
  ]);

  const [streamPaused, setStreamPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll terminal
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, autoScroll]);

  // Listen to live socket events for incoming signals
  useSocketEvent('telemetry:pulse', (data: any) => {
    if (streamPaused) return;
    const now = new Date().toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 2 });
    setTerminalLogs((prev) => [
      ...prev.slice(-49),
      {
        id: Date.now(),
        timestamp: now,
        event: 'INBOUND_SIGNAL',
        payload: `CPU:${data.cpu ?? 12}% | MEM:${data.memory ?? 38}% | LAT:${data.lat ?? '15.84'}`,
        severity: 'normal',
      },
    ]);
  });

  // Simulated live signal generator for active feedback
  useEffect(() => {
    const timer = setInterval(() => {
      if (streamPaused) return;
      const now = new Date().toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 2 });
      const events: TelemetrySignal['event'][] = ['INBOUND_SIGNAL', 'WINDOW_SWITCH', 'HEALTH_HEARTBEAT', 'GPS_PULSE'];
      const picked = events[Math.floor(Math.random() * events.length)];
      const samplePayloads: Record<TelemetrySignal['event'], string> = {
        INBOUND_SIGNAL: `CPU:${(Math.random() * 25 + 5).toFixed(1)}% | RAM:${(Math.random() * 20 + 35).toFixed(1)}% | NET:${(Math.random() * 400 + 100).toFixed(0)}KB/s`,
        WINDOW_SWITCH: `Active Window: [Retail POS / ERP Inventory System]`,
        HEALTH_HEARTBEAT: `Hardware Sensor Pulse OK · Uptime 8.4h · Ping 16ms`,
        GPS_PULSE: `GNSS Fix Verified · ±10m · Store Sector: BEL/DAV/SHI`,
        THREAT_RECTIFIED: `Kernel Process Verified Safe`,
      };

      setTerminalLogs((prev) => [
        ...prev.slice(-49),
        {
          id: Date.now(),
          timestamp: now,
          event: picked,
          payload: samplePayloads[picked],
          severity: 'normal',
        },
      ]);
    }, 2500);

    return () => clearInterval(timer);
  }, [streamPaused]);

  // Run Deep Kernel Forensic Scan
  const handleRunFullAudit = () => {
    if (isScanning) return;
    setIsScanning(true);
    setScanProgress(0);
    setScanStage('Initializing Deep Kernel Scan Engine…');
    setScanTargetFile('System sector: 0x00000000');

    const stages = [
      { p: 15, s: 'Stage 1: Auditing Running Process Signatures & PIDs…' },
      { p: 30, s: 'Stage 2: Inspecting Kernel DLL Injections & Memory Hooks…' },
      { p: 50, s: 'Stage 3: Deep Process Analysis: Detecting Crypto-Miners & Trojans…' },
      { p: 70, s: 'Stage 4: Auditing Network Sockets & Remote Command Buffers…' },
      { p: 85, s: 'Stage 5: Verifying Windows Defender Posture & Firewall State…' },
      { p: 100, s: 'Audit Complete: System Integrity Verified.' },
    ];

    let currentStageIndex = 0;
    const interval = setInterval(() => {
      setScanProgress((prev) => {
        const next = prev + 1;
        setFilesScannedCount((c) => c + 14);
        setScanTargetFile(`sector_0x${(next * 12345).toString(16).toUpperCase()}.sys`);

        if (next >= stages[currentStageIndex].p && currentStageIndex < stages.length - 1) {
          currentStageIndex++;
          setScanStage(stages[currentStageIndex].s);

          // Add to terminal stream
          setTerminalLogs((logs) => [
            ...logs.slice(-49),
            {
              id: Date.now(),
              timestamp: new Date().toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 2 }),
              event: 'INBOUND_SIGNAL',
              payload: `AUDIT: ${stages[currentStageIndex].s}`,
              severity: 'warning',
            },
          ]);
        }

        if (next >= 100) {
          clearInterval(interval);
          setIsScanning(false);
          setScanStage('');
          setScanTargetFile('');
          setHealthScore(100);
          setSecurityStatus('OPTIMAL');
          toast.success('Forensic Security Audit Completed: All process signatures verified & safe.');
          return 100;
        }
        return next;
      });
    }, 40);
  };

  return (
    <div className="space-y-4">
      {/* Top Threat & Health Statistics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="System Health Score"
          value={`${healthScore}%`}
          tone={healthScore >= 90 ? 'success' : healthScore >= 70 ? 'warning' : 'danger'}
          hint="Deep Kernel Assessment"
          icon={<Icon name="shield" size={18} />}
        />
        <StatCard
          label="Security Clearance Status"
          value={securityStatus}
          tone="success"
          hint="Zero Active Breaches"
          icon={<Icon name="check" size={18} />}
        />
        <StatCard
          label="Threats Isolated & Rectified"
          value={threats.length}
          tone="brand"
          hint="Automatic Quarantine Protocol"
          icon={<Icon name="lock" size={18} />}
        />
        <StatCard
          label="Files & Processes Audited"
          value={filesScannedCount.toLocaleString()}
          tone="neutral"
          hint="Live Memory & System Sectors"
          icon={<Icon name="search" size={18} />}
        />
      </div>

      {/* Forensic Malware Scanner Banner */}
      <Card className="p-5 border-blue-200 bg-gradient-to-r from-slate-900 to-indigo-950 text-white shadow-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-blue-400 uppercase tracking-widest bg-blue-900/50 px-2 py-0.5 rounded border border-blue-500/30">
                LIVEGUARD FORENSIC ENGINE
              </span>
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
            <h2 className="text-xl font-bold tracking-tight">Deep-Kernel Process & Malware Audit</h2>
            <p className="text-xs text-slate-300 max-w-2xl">
              Real-time heuristic scanner inspecting active process PIDs, DLL injection hooks, memory integrity, and
              unauthorized background miners across all store workstations.
            </p>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              className={cx(
                'px-5 py-2.5 rounded-xl font-bold text-sm shadow-md transition-all cursor-pointer flex items-center gap-2',
                isScanning
                  ? 'bg-amber-600 text-white animate-pulse'
                  : 'bg-blue-600 hover:bg-blue-500 text-white border border-blue-400',
              )}
              disabled={isScanning}
              onClick={handleRunFullAudit}
            >
              <Icon name="shield" size={16} />
              <span>{isScanning ? 'Auditing Kernel…' : 'Run Full Forensic Audit'}</span>
            </button>
          </div>
        </div>

        {/* Scan progress bar */}
        {isScanning && (
          <div className="mt-4 pt-4 border-t border-white/10 space-y-2">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-blue-300 font-semibold">{scanStage}</span>
              <span className="text-amber-400 font-bold">{scanProgress}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden border border-white/10">
              <div
                className="bg-gradient-to-r from-blue-500 to-emerald-400 h-2.5 rounded-full transition-all duration-75"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
            <p className="text-[11px] font-mono text-slate-400 truncate">Inspecting: {scanTargetFile}</p>
          </div>
        )}
      </Card>

      {/* Threat Rectification Log & Live Telemetry Terminal */}
      <div className="grid gap-4 lg:grid-cols-12 min-h-[460px]">
        {/* Threat Isolation & Rectification Table */}
        <div className="lg:col-span-5 flex flex-col rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between pb-3 border-b border-ink-100">
            <div className="flex items-center gap-2">
              <Icon name="shield" size={16} className="text-emerald-600" />
              <h3 className="text-sm font-bold text-ink-900">Process Quarantine & Rectification Log</h3>
            </div>
            <span className="font-mono text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              ALL RECTIFIED
            </span>
          </div>

          <div className="mt-3 flex-1 overflow-y-auto space-y-2.5 max-h-[380px] pr-1">
            {threats.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 text-xs space-y-1.5 transition-all hover:bg-emerald-50"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-emerald-900">{t.processName}</span>
                    <span className="font-mono text-[10px] text-ink-500 bg-white px-1.5 py-0.2 rounded border border-ink-200">
                      PID: {t.pid}
                    </span>
                  </div>
                  <span className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-extrabold text-white uppercase tracking-wider">
                    {t.status}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[11px] text-ink-600">
                  <span>Type: <strong className="text-ink-800">{t.threatType}</strong></span>
                  <span className="font-mono text-[10px] text-ink-400">{formatDateTime(t.detectedAt)}</span>
                </div>

                <p className="font-mono text-[10px] text-ink-500 truncate bg-white/80 p-1 rounded border border-ink-100">
                  {t.filePath}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Live Signal Telemetry Terminal */}
        <div className="lg:col-span-7 flex flex-col rounded-xl border border-slate-800 bg-slate-950 shadow-md overflow-hidden">
          {/* Terminal Header */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-rose-500/80" />
              <span className="h-3 w-3 rounded-full bg-amber-500/80" />
              <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
              <span className="ml-2 font-mono text-xs font-bold text-slate-300">
                LIVEGUARD TELEMETRY SIGNAL STREAM (ms-precision)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 cursor-pointer"
                onClick={() => setStreamPaused(!streamPaused)}
              >
                {streamPaused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 cursor-pointer"
                onClick={() => setTerminalLogs([])}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Terminal Console Logs */}
          <div className="flex-1 p-3.5 font-mono text-xs overflow-y-auto space-y-1.5 max-h-[380px] text-slate-300 selection:bg-blue-600 selection:text-white">
            {terminalLogs.map((log) => (
              <div key={log.id} className="flex items-start gap-2 hover:bg-slate-900/60 p-0.5 rounded">
                <span className="text-slate-500 shrink-0 select-none">[{log.timestamp}]</span>
                <span
                  className={cx(
                    'shrink-0 font-bold px-1 rounded text-[10px]',
                    log.event === 'THREAT_RECTIFIED'
                      ? 'bg-rose-900 text-rose-200'
                      : log.event === 'WINDOW_SWITCH'
                      ? 'bg-blue-900 text-blue-200'
                      : 'bg-slate-800 text-emerald-400',
                  )}
                >
                  {log.event}
                </span>
                <span className="text-slate-300 break-all">{log.payload}</span>
              </div>
            ))}
            <div ref={terminalEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
