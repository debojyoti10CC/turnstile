// Minimal grouped bar chart, SVG, no charting library dependency.
// Categorical color assigned in fixed order (never cycled): index 0 = batch,
// index 1 = exact -- validated colorblind-safe pair, see docs/DECISIONS.md.
export const SERIES_COLORS = ['#4a8fc7', '#d1782e'] as const;

export interface BarGroup {
  label: string;
  values: Array<{ seriesLabel: string; value: number; display: string }>;
}

export function BarChart({
  groups,
  seriesLabels,
  yAxisLabel,
  height = 220,
}: {
  groups: BarGroup[];
  seriesLabels: readonly string[];
  yAxisLabel: string;
  height?: number;
}) {
  const width = 640;
  const marginLeft = 8;
  const marginBottom = 28;
  const marginTop = 12;
  const plotHeight = height - marginTop - marginBottom;
  const maxValue = Math.max(...groups.flatMap((g) => g.values.map((v) => v.value)), 1);
  const groupWidth = (width - marginLeft) / groups.length;
  const barGap = 4;
  const barWidth = (groupWidth - barGap * (seriesLabels.length + 1)) / seriesLabels.length;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="barchart">
      <div className="barchart-legend">
        {seriesLabels.map((label, i) => (
          <span key={label} className="barchart-legend-item">
            <span className="barchart-swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${yAxisLabel} by ${groups.map((g) => g.label).join(', ')}`}>
        {/* recessive gridlines */}
        {gridLines.map((t) => {
          const y = marginTop + plotHeight * (1 - t);
          return <line key={t} x1={marginLeft} x2={width} y1={y} y2={y} className="barchart-gridline" />;
        })}
        {groups.map((group, gi) => {
          const groupX = marginLeft + gi * groupWidth;
          return (
            <g key={group.label}>
              {group.values.map((v, si) => {
                const barHeight = Math.max((v.value / maxValue) * plotHeight, v.value > 0 ? 2 : 0);
                const x = groupX + barGap + si * (barWidth + barGap);
                const y = marginTop + plotHeight - barHeight;
                return (
                  <g key={v.seriesLabel}>
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={barHeight}
                      rx={3}
                      fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                    >
                      <title>{`${group.label} — ${v.seriesLabel}: ${v.display}`}</title>
                    </rect>
                    <text x={x + barWidth / 2} y={y - 5} textAnchor="middle" className="barchart-value-label">
                      {v.display}
                    </text>
                  </g>
                );
              })}
              <text x={groupX + groupWidth / 2} y={height - 8} textAnchor="middle" className="barchart-axis-label">
                {group.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
