/**
 * Run every test suite in this repo.
 *
 *   node tests/run-all.mjs
 *
 * Each suite prints its own pass/fail lines; this wrapper only reports which
 * suite failed so CI or a reader gets one non-zero exit at the end.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['lib', 'framework-doctor-lib.mjs'],
  ['failover', 'framework-doctor-failover.mjs'],
  ['realworld', 'framework-doctor-realworld.mjs'],
  ['combo', 'framework-doctor-combo.mjs'],
  ['model-chain', 'framework-doctor-model-chain.mjs'],
  ['assistant-model', 'framework-doctor-assistant-model.mjs'],
  ['channel-state', 'framework-doctor-channel-state.mjs'],
  ['session-log', 'framework-doctor-session-log.mjs'],
  ['agent', 'framework-doctor-agent.mjs'],
  ['host', 'framework-doctor-host.mjs'],
  ['client', 'framework-doctor-client.mjs'],
  ['width', 'framework-doctor-width.mjs'],
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

let failed = 0;
for (const [label, file] of SUITES) {
  console.log(`\n${'='.repeat(60)}\n${label} — ${file}\n${'='.repeat(60)}`);
  const code = await run(file);
  if (code !== 0) {
    failed += 1;
    console.log(`\n!! ${label} 失败（exit ${code}）`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? '全部套件通过' : `${failed} 个套件失败`);
process.exit(failed === 0 ? 0 : 1);