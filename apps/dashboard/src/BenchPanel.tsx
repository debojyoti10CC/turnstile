import type { BenchRun } from './api.js';

export function BenchPanel({ data }: { data: BenchRun[] | null }) {
  if (!data || data.length === 0) {
    return <p className="muted">No bench.json yet — run `pnpm bench` from the repo root.</p>;
  }
  const maxFee = Math.max(...data.map((r) => r.totalFeesMicroAlgo), 1);
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
      <div className="bars">
        {sizes.map((n) => {
          const batch = data.find((r) => r.calls === n && r.mode === 'batch');
          const exact = data.find((r) => r.calls === n && r.mode === 'exact');
          return (
            <div className="bar-group" key={n}>
              <div className="bar-label">N={n}</div>
              {batch && (
                <div className="bar-row">
                  <span className="bar-tag batch">batch</span>
                  <div className="bar-track">
                    <div className="bar-fill batch" style={{ width: `${(batch.totalFeesMicroAlgo / maxFee) * 100}%` }} />
                  </div>
                  <span className="bar-value">{batch.totalFeesMicroAlgo.toLocaleString()} µALGO</span>
                </div>
              )}
              {exact && (
                <div className="bar-row">
                  <span className="bar-tag exact">exact</span>
                  <div className="bar-track">
                    <div className="bar-fill exact" style={{ width: `${(exact.totalFeesMicroAlgo / maxFee) * 100}%` }} />
                  </div>
                  <span className="bar-value">{exact.totalFeesMicroAlgo.toLocaleString()} µALGO</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
