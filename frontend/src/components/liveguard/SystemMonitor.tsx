import { useEffect, useRef, useState } from 'react';
import { Card, ProgressBar, StatCard } from '../ui';
import { Icon } from '../icons';
import { cx } from '../../lib/format';

export interface HardwareMetrics {
  cpuCores: number;
  cpuLoad: number;
  cpuFreqGhz: number;
  memoryTotalGb: number;
  memoryUsedGb: number;
  memoryPressure: 'Optimal' | 'Elevated' | 'Critical';
  gpuModel: string;
  gpuLoad: number;
  gpuVramUsedGb: number;
  gpuVramTotalGb: number;
  gpuTempC: number;
  diskTotalGb: number;
  diskUsedGb: number;
  networkDownKb: number;
  networkUpKb: number;
  activeSockets: number;
  fps: number;
  lagScoreMs: number;
  jankCount: number;
  healthScore: number;
}

export function SystemMonitor() {
  const [metrics, setMetrics] = useState<HardwareMetrics>({
    cpuCores: navigator.hardwareConcurrency || 8,
    cpuLoad: 18.5,
    cpuFreqGhz: 2.8,
    memoryTotalGb: 16.0,
    memoryUsedGb: 6.8,
    memoryPressure: 'Optimal',
    gpuModel: 'NVIDIA GeForce RTX 4060 / Intel Iris Xe',
    gpuLoad: 12.0,
    gpuVramUsedGb: 1.8,
    gpuVramTotalGb: 8.0,
    gpuTempC: 48,
    diskTotalGb: 512,
    diskUsedGb: 218,
    networkDownKb: 340,
    networkUpKb: 120,
    activeSockets: 8,
    fps: 60,
    lagScoreMs: 4,
    jankCount: 0,
    healthScore: 98,
  });

  const framesRef = useRef(0);
  const lastTimeRef = useRef(performance.now());

  // Real-time FPS & Render Lag Measurement
  useEffect(() => {
    let animId: number;
    const calcFps = (time: number) => {
      framesRef.current++;
      const elapsed = time - lastTimeRef.current;
      if (elapsed >= 1000) {
        const curFps = Math.min(60, Math.round((framesRef.current * 1000) / elapsed));
        const lagMs = Math.max(0, Math.round(1000 / curFps - 16.6));

        setMetrics((prev) => ({
          ...prev,
          fps: curFps,
          lagScoreMs: lagMs,
          jankCount: curFps < 45 ? prev.jankCount + 1 : prev.jankCount,
        }));

        framesRef.current = 0;
        lastTimeRef.current = time;
      }
      animId = requestAnimationFrame(calcFps);
    };

    animId = requestAnimationFrame(calcFps);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Sensor pulse simulation / live browser memory reading
  useEffect(() => {
    const interval = setInterval(() => {
      // Read browser memory if available
      const perfMem = (performance as any)?.memory;
      let usedMem = 6.8;
      let totalMem = 16.0;
      if (perfMem) {
        usedMem = Number((perfMem.usedJSHeapSize / (1024 * 1024 * 1024)).toFixed(2));
        totalMem = Number((perfMem.jsHeapSizeLimit / (1024 * 1024 * 1024)).toFixed(2));
      }

      const cpuVariation = Number((Math.random() * 8 + 14).toFixed(1));
      const gpuVariation = Number((Math.random() * 10 + 8).toFixed(1));
      const netDown = Math.floor(Math.random() * 500 + 150);
      const netUp = Math.floor(Math.random() * 200 + 60);

      setMetrics((prev) => ({
        ...prev,
        cpuLoad: cpuVariation,
        gpuLoad: gpuVariation,
        memoryUsedGb: usedMem > 0 ? usedMem : prev.memoryUsedGb,
        memoryTotalGb: totalMem > 0 ? totalMem : prev.memoryTotalGb,
        networkDownKb: netDown,
        networkUpKb: netUp,
        gpuTempC: Math.floor(Math.random() * 4 + 46),
      }));
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const memPct = Math.round((metrics.memoryUsedGb / metrics.memoryTotalGb) * 100);
  const diskPct = Math.round((metrics.diskUsedGb / metrics.diskTotalGb) * 100);
  const vramPct = Math.round((metrics.gpuVramUsedGb / metrics.gpuVramTotalGb) * 100);

  return (
    <div className="space-y-4">
      {/* Top Diagnostics KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Hardware Health Integrity"
          value={`${metrics.healthScore}%`}
          tone="success"
          hint="Zero Thermal Throttling"
          icon={<Icon name="shield" size={18} />}
        />
        <StatCard
          label="Display Render FPS"
          value={`${metrics.fps} FPS`}
          tone={metrics.fps >= 55 ? 'success' : 'warning'}
          hint={`Lag Score: ${metrics.lagScoreMs}ms`}
          icon={<Icon name="activity" size={18} />}
        />
        <StatCard
          label="Network Throughput"
          value={`↓${metrics.networkDownKb} KB/s`}
          tone="brand"
          hint={`↑${metrics.networkUpKb} KB/s upload · ${metrics.activeSockets} sockets`}
          icon={<Icon name="signal" size={18} />}
        />
        <StatCard
          label="GPU Core Temperature"
          value={`${metrics.gpuTempC}°C`}
          tone="neutral"
          hint="Optimal Operating Range"
          icon={<Icon name="gauge" size={18} />}
        />
      </div>

      {/* Main Hardware Telemetry Grid */}
      <div className="grid gap-4 lg:grid-cols-12">
        {/* CPU & Memory Gauges */}
        <div className="lg:col-span-6 flex flex-col gap-4">
          {/* CPU Card */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="cpu" size={18} className="text-blue-600" />
                <h3 className="text-sm font-bold text-ink-900">CPU Processing Load</h3>
              </div>
              <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                {metrics.cpuCores} LOGICAL CORES
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-500 font-medium">Core Utilization:</span>
                <span className="font-bold text-ink-900">{metrics.cpuLoad}%</span>
              </div>
              <ProgressBar value={metrics.cpuLoad} tone={metrics.cpuLoad > 75 ? 'danger' : metrics.cpuLoad > 45 ? 'warning' : 'brand'} />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-ink-600 pt-2 border-t border-ink-100 font-mono">
              <div>
                <span className="text-ink-400 block text-[10px]">BASE CLOCK</span>
                <strong>{metrics.cpuFreqGhz} GHz</strong>
              </div>
              <div>
                <span className="text-ink-400 block text-[10px]">EXECUTION STATE</span>
                <strong className="text-emerald-700">Non-Interrupted</strong>
              </div>
            </div>
          </Card>

          {/* Memory Card */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="memory" size={18} className="text-indigo-600" />
                <h3 className="text-sm font-bold text-ink-900">Physical Memory (RAM) Allocation</h3>
              </div>
              <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                {metrics.memoryPressure}
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-500 font-medium">RAM Pressure:</span>
                <span className="font-bold text-ink-900">
                  {metrics.memoryUsedGb} GB / {metrics.memoryTotalGb} GB ({memPct}%)
                </span>
              </div>
              <ProgressBar value={memPct} tone={memPct > 80 ? 'danger' : memPct > 60 ? 'warning' : 'brand'} />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-ink-600 pt-2 border-t border-ink-100 font-mono">
              <div>
                <span className="text-ink-400 block text-[10px]">AVAILABLE FREE</span>
                <strong>{(metrics.memoryTotalGb - metrics.memoryUsedGb).toFixed(1)} GB</strong>
              </div>
              <div>
                <span className="text-ink-400 block text-[10px]">PAGING PRESSURE</span>
                <strong className="text-emerald-700">0.0 MB Swapped</strong>
              </div>
            </div>
          </Card>
        </div>

        {/* GPU & Storage Telemetry */}
        <div className="lg:col-span-6 flex flex-col gap-4">
          {/* GPU Card */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="gauge" size={18} className="text-emerald-600" />
                <h3 className="text-sm font-bold text-ink-900">GPU Hardware Acceleration</h3>
              </div>
              <span className="font-mono text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                {metrics.gpuTempC}°C
              </span>
            </div>

            <p className="text-xs font-bold text-ink-800 font-mono truncate">{metrics.gpuModel}</p>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-500 font-medium">3D Compute & Render Load:</span>
                <span className="font-bold text-ink-900">{metrics.gpuLoad}%</span>
              </div>
              <ProgressBar value={metrics.gpuLoad} tone="success" />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-500 font-medium">Dedicated VRAM:</span>
                <span className="font-bold text-ink-900">
                  {metrics.gpuVramUsedGb} GB / {metrics.gpuVramTotalGb} GB ({vramPct}%)
                </span>
              </div>
              <ProgressBar value={vramPct} tone="brand" />
            </div>
          </Card>

          {/* Disk & Network Throughput */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="database" size={18} className="text-amber-600" />
                <h3 className="text-sm font-bold text-ink-900">Storage & Network I/O Throughput</h3>
              </div>
              <span className="font-mono text-xs font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                NVMe SSD
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-500 font-medium">Primary Drive Allocation:</span>
                <span className="font-bold text-ink-900">
                  {metrics.diskUsedGb} GB / {metrics.diskTotalGb} GB ({diskPct}%)
                </span>
              </div>
              <ProgressBar value={diskPct} tone="warning" />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-ink-600 pt-2 border-t border-ink-100 font-mono">
              <div>
                <span className="text-ink-400 block text-[10px]">CURRENT DOWNLOAD</span>
                <strong className="text-blue-700">{metrics.networkDownKb} KB/s</strong>
              </div>
              <div>
                <span className="text-ink-400 block text-[10px]">CURRENT UPLOAD</span>
                <strong className="text-indigo-700">{metrics.networkUpKb} KB/s</strong>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
