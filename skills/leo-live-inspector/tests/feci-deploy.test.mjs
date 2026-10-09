import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFeciJobMeta, saveFeciJobMeta } from '../scripts/common/services.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FECI_SCRIPT = path.join(__dirname, '..', 'scripts', 'feci_deploy.js');

test('feci_deploy CLI should render help with usage instructions', () => {
  const output = execSync(`node ${FECI_SCRIPT} --help`, { encoding: 'utf8' });
  assert.ok(output.includes('青蝉'), 'Should mention Qingchan / FeCI');
  assert.ok(output.includes('--search'), 'Should support --search');
  assert.ok(output.includes('--dry-run'), 'Should support --dry-run');
});

test('saveFeciJobMeta and getFeciJobMeta should persist and retrieve job metadata', () => {
  saveFeciJobMeta('test-demo-fe', {
    jobId: 9999,
    jobName: 'test-demo-fe',
    gitUrl: 'git@git.intra.ke.com:test/test-demo-fe.git'
  });

  const meta = getFeciJobMeta('test-demo-fe');
  assert.ok(meta, 'Meta should be found');
  assert.equal(meta.jobId, 9999);
  assert.equal(meta.jobName, 'test-demo-fe');

  // Should also match without -fe suffix
  const strippedMeta = getFeciJobMeta('test-demo');
  assert.ok(strippedMeta, 'Stripped meta should match');
  assert.equal(strippedMeta.jobId, 9999);
});
