import { useMemo } from 'react';

interface SeriesPoint {
  label: string;
  value: number;
}

export function LineChart({
  data,
  height = 180,
  stroke = '#1d4ed8',
  fill = 'rgba(29,78,216,0.10)',
  suffix = '',
  emptyLabel = 'No data for this period',
}: {
  data: SeriesPoint[];
  height?: number;
  stroke?: string;
  fill?: string;
  suffix?: string;
  emptyLabel?: string;
}) {
  const width = 640;
  const padding = { top: 14, right: 8, bottom: 24, left: 30 };
  const points = useMemo(() => {
    if (data.length === 0) return [] as { x: number; y: number; value: number; label: string }[];
    const max = Math.max(...data.map((d) => d.value), 1);
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;
    const step = data.length > 1 ? innerW / (data.length - 1) : 0;
    return data.map((point, index) => ({
      x: padding.left + index * step,
      y: padding.top + innerH - (point.value / max) * innerH,
      value: point.value,
      label: point.label,
    }));
  }, [data, height]);

  if (data.length === 0) {
    return <div className="flex h-[160px] items-center justify-center text-sm text-ink-400">{emptyLabel}</div>;
  }

  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(1)},${height - padding.bottom} L${padding.left},${height - padding.bottom} Z`;
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Trend chart">
      {[0, 0.5, 1].map((ratio) => (
        <g key={ratio}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + (height - padding.top - padding.bottom) * ratio}
            y2={padding.top + (height - padding.top - padding.bottom) * ratio}
            stroke="#e2e8f0"
            strokeWidth="1"
          />
          <text x={2} y={padding.top + (height - padding.top - padding.bottom) * ratio + 3} fontSize="9" fill="#94a3b8">
            {Math.round(max * (1 - ratio))}
          </text>
        </g>
      ))}
      <path d={area} fill={fill} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point) => (
        <g key={point.label}>
          <circle cx={point.x} cy={point.y} r="3" fill="white" stroke={stroke} strokeWidth="2" />
          <title>{`${point.label}: ${point.value}${suffix}`}</title>
        </g>
      ))}
      {points.map((point, index) =>
        index % Math.ceil(points.length / 7) === 0 || index === points.length - 1 ? (
          <text key={`${point.label}-label`} x={point.x} y={height - 6} fontSize="9" fill="#94a3b8" textAnchor="middle">
            {point.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function BarChart({
  data,
  height = 180,
  color = '#1d4ed8',
  suffix = '',
}: {
  data: SeriesPoint[];
  height?: number;
  color?: string;
  suffix?: string;
}) {
  const width = 640;
  const padding = { top: 12, right: 8, bottom: 24, left: 34 };
  if (data.length === 0) {
    return <div className="flex h-[160px] items-center justify-center text-sm text-ink-400">No data for this period</div>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const slot = innerW / data.length;
  const barWidth = Math.min(38, slot * 0.6);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Bar chart">
      {[0, 0.5, 1].map((ratio) => (
        <g key={ratio}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + innerH * ratio}
            y2={padding.top + innerH * ratio}
            stroke="#e2e8f0"
          />
          <text x={2} y={padding.top + innerH * ratio + 3} fontSize="9" fill="#94a3b8">
            {Math.round(max * (1 - ratio))}
          </text>
        </g>
      ))}
      {data.map((point, index) => {
        const barHeight = (point.value / max) * innerH;
        const x = padding.left + index * slot + (slot - barWidth) / 2;
        return (
          <g key={point.label}>
            <rect x={x} y={padding.top + innerH - barHeight} width={barWidth} height={Math.max(2, barHeight)} rx="4" fill={color}>
              <title>{`${point.label}: ${point.value}${suffix}`}</title>
            </rect>
            <text x={x + barWidth / 2} y={height - 6} fontSize="9" fill="#64748b" textAnchor="middle">
              {point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Donut({
  segments,
  size = 132,
  centerLabel,
  centerValue,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = size / 2 - 10;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Distribution">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e2e8f0" strokeWidth="12" />
        {total > 0 &&
          segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const circle = (
              <circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth="12"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                strokeLinecap="butt"
              >
                <title>{`${segment.label}: ${segment.value}`}</title>
              </circle>
            );
            offset += length;
            return circle;
          })}
        {(centerValue || centerLabel) && (
          <>
            <text x="50%" y="48%" textAnchor="middle" fontSize="18" fontWeight="600" fill="#0f172a">
              {centerValue}
            </text>
            <text x="50%" y="60%" textAnchor="middle" fontSize="9" fill="#64748b">
              {centerLabel}
            </text>
          </>
        )}
      </svg>
      <ul className="space-y-1.5 text-sm">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: segment.color }} />
            <span className="text-ink-600">{segment.label}</span>
            <span className="font-semibold text-ink-800">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
