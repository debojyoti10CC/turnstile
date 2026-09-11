import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContractAttacks } from './contractAttacks.js';
import { runServerAttacks } from './serverAttacks.js';
import { runFuzz } from './fuzz.js';
import type { AttackResult } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.join(__dirname, '..', 'report.json');

async function main(): Promise<void> {
  console.log('[adversary] running contract-level attacks against LocalNet...');
  const contractResults = await runContractAttacks();

  console.log('[adversary] running server-level attacks (in-process)...');
  const serverResults = await runServerAttacks();

  console.log('[adversary] running fuzz (real LocalNet transactions)...');
  const fuzzResult = await runFuzz(Number(process.env.ADVERSARY_FUZZ_STEPS ?? 500));

  const results: AttackResult[] = [...contractResults, ...serverResults, fuzzResult];
  writeFileSync(reportPath, JSON.stringify(results, null, 2));

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`[adversary] ${r.pass ? 'PASS' : 'FAIL'} ${r.layer.padEnd(8)} ${r.attack}${r.pass ? '' : ' -- ' + r.detail}`);
  }
  console.log(`[adversary] ${results.length - failed.length}/${results.length} passed. Report: ${reportPath}`);

  if (failed.length > 0) {
    console.error(`[adversary] ${failed.length} attack(s) were ACCEPTED (should have been rejected). Failing.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[adversary] fatal error running the suite', err);
  process.exitCode = 1;
});
