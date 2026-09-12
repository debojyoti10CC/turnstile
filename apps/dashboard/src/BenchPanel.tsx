import type { BenchRun } from './api.js';
import { BarChart, type BarGroup } from './BarChart.js';

const SERIES_LABELS = ['batch', 'exact'] as const;

function buildGroups(
  data: BenchRun[],
  sizes: number[],
  metric: (r: BenchRun) => number,
  formatValue: (n: number) => string,
): BarGroup[] {
  return sizes.map((n) => ({
    label: `N=${n}`,
    values: SERIES_LABELS.map((mode) => {
      const run = data.find((r) => r.calls === n && r.mode === mode);
      const value = run ? metric(run) : 0;
      return { seriesLabel: mode, value, display: run ? formatValue(value) : '—' };
    }),
  }));
}

export function BenchPanel({ data }: { data: BenchRun[] | null }) {
  if (!data || data.length === 0) {
    return <p className="muted">No bench.json yet — run `pnpm bench` from the repo root.</p>;
  }
  const sizes = Array.from(new Set(data.map((r) => r.calls))).sort((a, b) => a - b);

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>N</th>
              <th>Mode</th>
              <th>Wall time</th>
              <th>p50 / p95 added latency</th>
              <th>On-chain txns</th>
              <th>Network fees (µALGO)</th>
              <th>One-time MBR (µALGO)</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i}>
                <td>{r.calls}</td>
                <td>{r.mode}</td>
                <td>{r.wallTimeMs} ms</td>
                <td>{r.p50LatencyMs} / {r.p95LatencyMs} ms</td>
                <td>{r.onChainTxnCount}</td>
                <td>{r.totalFeesMicroAlgo.toLocaleString()}</td>
                <td>{r.mbrLockedMicroAlgo.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="chart-grid">
        <div>
          <h3 className="chart-title">Network fees (µALGO) — flat for batch, linear for exact</h3>
          <BarChart
            groups={buildGroups(data, sizes, (r) => r.totalFeesMicroAlgo, (n) => n.toLocaleString())}
            seriesLabels={SERIES_LABELS}
            yAxisLabel="network fees in microAlgo"
          />
        </div>
        <div>
          <h3 className="chart-title">On-chain transaction count</h3>
          <BarChart
            groups={buildGroups(data, sizes, (r) => r.onChainTxnCount, (n) => n.toLocaleString())}
            seriesLabels={SERIES_LABELS}
            yAxisLabel="on-chain transaction count"
          />
        </div>
        <div>
          <h3 className="chart-title">p95 added latency (ms)</h3>
          <BarChart
            groups={buildGroups(data, sizes, (r) => r.p95LatencyMs, (n) => `${n} ms`)}
            seriesLabels={SERIES_LABELS}
            yAxisLabel="p95 added latency in milliseconds"
          />
        </div>
      </div>
    </div>
  );
}
