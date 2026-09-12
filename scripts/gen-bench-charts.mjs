#!/usr/bin/env node
// Renders the real apps/demo-agent/bench.json into standalone SVG bar charts
// for docs/README embedding (GitHub renders static SVGs fine in Markdown).
// Same chart grammar as apps/dashboard/src/BarChart.tsx, retuned for a light
// surface (README default) instead of the dashboard's dark theme. Colors are
// the palette validated in docs/DECISIONS.md (2026-09-12): #2f6fb0 / #c15f1d,
// all six dataviz-skill checks pass in light mode.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bench = JSON.parse(readFileSync(path.join(repoRoot, 'apps/demo-agent/bench.json'), 'utf-8'));

const COLORS = { batch: '#2f6fb0', exact: '#c15f1d' };
const SERIES = ['batch', 'exact'];
const SURFACE = '#fcfcfb';
const INK = '#1a1d24';
const MUTED = '#5b6472';
const GRID = '#e4e6ea';

function chart({ title, subtitle, sizes, metric, format, width = 720, height = 320 }) {
  const marginLeft = 16;
  const marginRight = 16;
  const marginTop = 68;
  const marginBottom = 40;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom; // baseline for all bars
  const baselineY = marginTop + plotH;
  // Only the tallest bar's *amplitude* is scaled down (to 86% of plotH),
  // reserving headroom above it for its value label so it never crowds the
  // subtitle text; the baseline itself never moves.
  const usableH = plotH * 0.86;
  const values = sizes.flatMap((n) => SERIES.map((mode) => bench.find((r) => r.calls === n && r.mode === mode)?.[metric] ?? 0));
  const maxValue = Math.max(...values, 1);
  const groupWidth = plotW / sizes.length;
  const barGap = 10;
  const barWidth = (groupWidth - barGap * (SERIES.length + 1)) / SERIES.length;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = marginTop + plotH * (1 - t);
      return `<line x1="${marginLeft}" x2="${width - marginRight}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    })
    .join('\n    ');

  const bars = sizes
    .map((n, gi) => {
      const groupX = marginLeft + gi * groupWidth;
      const groupLabel = `<text x="${(groupX + groupWidth / 2).toFixed(1)}" y="${height - 12}" text-anchor="middle" font-size="14" fill="${INK}" font-weight="600">N=${n}</text>`;
      const seriesBars = SERIES.map((mode, si) => {
        const run = bench.find((r) => r.calls === n && r.mode === mode);
        const value = run ? run[metric] : 0;
        const barHeight = Math.max((value / maxValue) * usableH, value > 0 ? 3 : 0);
        const x = groupX + barGap + si * (barWidth + barGap);
        const y = baselineY - barHeight;
        const display = run ? format(value) : '—';
        return `
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="4" fill="${COLORS[mode]}"/>
    <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="13" fill="${INK}" font-weight="600">${display}</text>`;
      }).join('');
      return groupLabel + seriesBars;
    })
    .join('\n');

  const legend = SERIES.map((mode, i) => {
    const x = width - marginRight - (SERIES.length - i) * 96;
    return `
    <rect x="${x}" y="20" width="12" height="12" rx="2" fill="${COLORS[mode]}"/>
    <text x="${x + 18}" y="30" font-size="13" fill="${MUTED}">${mode}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${SURFACE}" rx="8"/>
  <text x="${marginLeft}" y="30" font-size="17" font-weight="700" fill="${INK}">${title}</text>
  <text x="${marginLeft}" y="48" font-size="12.5" fill="${MUTED}">${subtitle}</text>
  ${legend}
  <g>
    ${gridLines}
    ${bars}
  </g>
</svg>
`;
}

const sizes = [50, 200, 1000];

const charts = [
  {
    file: 'bench-fees.svg',
    title: 'Network fees by call volume — batch vs. exact',
    subtitle: 'total µALGO spent on-chain to complete N paid requests through one channel (LocalNet, real transactions)',
    metric: 'totalFeesMicroAlgo',
    format: (n) => n.toLocaleString('en-US') + ' µA',
  },
  {
    file: 'bench-txns.svg',
    title: 'On-chain transaction count by call volume',
    subtitle: 'batch-settlement stays flat at 3 txns regardless of N; exact scales 1:1 with call count',
    metric: 'onChainTxnCount',
    format: (n) => n.toLocaleString('en-US'),
  },
  {
    file: 'bench-latency.svg',
    title: 'p95 added latency by call volume',
    subtitle: 'milliseconds added per request beyond the raw handler — local signature check vs. a real per-call transaction',
    metric: 'p95LatencyMs',
    format: (n) => n + ' ms',
  },
];

for (const c of charts) {
  const svg = chart({ title: c.title, subtitle: c.subtitle, sizes, metric: c.metric, format: c.format });
  writeFileSync(path.join(repoRoot, 'docs/assets', c.file), svg);
  console.log(`wrote docs/assets/${c.file}`);
}
