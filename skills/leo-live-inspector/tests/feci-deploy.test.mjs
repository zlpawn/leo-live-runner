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

test('feci_deploy CLI should block production deployments with safety advice', () => {
  try {
    execSync(`node ${FECI_SCRIPT} smart-customer-service-fe --env prod`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    assert.fail('Should have exited with non-zero status');
  } catch (err) {
    assert.ok(err.stdout.includes('安全红线拦截'), 'Should output safety intercept warning');
    assert.ok(err.stdout.includes('delivery-list'), 'Should output delivery portal link');
  }
});

test('feci_deploy CLI should run deploy-only dry-run correctly', () => {
  const output = execSync(`node ${FECI_SCRIPT} smart-customer-service-fe --deploy-only --dry-run`, {
    encoding: 'utf8'
  });
  assert.ok(output.includes('Pre-flight 预检确认 (纯部署模式)'), 'Should output pre-flight check');
  assert.ok(output.includes('--deploy-only'), 'Should indicate deploy-only mode');
});

