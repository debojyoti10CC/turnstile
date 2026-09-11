import type { AdversaryResult } from './api.js';

export function AdversaryPanel({ data }: { data: AdversaryResult[] | null }) {
  if (!data || data.length === 0) {
    return <p className="muted">No report.json yet — run `pnpm adversary` from the repo root.</p>;
  }
  const passed = data.filter((r) => r.pass).length;
  return (
    <div>
      <p className={passed === data.length ? 'summary-ok' : 'summary-bad'}>
        {passed}/{data.length} attacks correctly rejected
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Attack</th>
              <th>Layer</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i}>
                <td>{r.attack}</td>
                <td>{r.layer}</td>
                <td>{r.expected}</td>
                <td>{r.actual}</td>
                <td className={r.pass ? 'pass' : 'fail'}>{r.pass ? 'PASS' : 'FAIL'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
