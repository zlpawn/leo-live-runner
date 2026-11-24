import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyKey,
  sortQaAndDevBranches,
  pickDefaultQaBranch,
  validateBranchName,
  listUniversalProjects
} from '../scripts/common/qa_merge.js';
import {
  CREDENTIALS,
  SESSION_CSRF_TOKEN,
  isValidJobId,
  verifyLocalRequestSecurity,
  validateDeployParams,
  buildHtmlPage,
  extractJson
} from '../scripts/web_console/server.js';

test('qa_merge: monthlyKey recognizes qa-YYYY-MM and qa-YYYY-M-D', () => {
  assert.equal(monthlyKey('qa-2026-11'), 20261101);
  assert.equal(monthlyKey('qa-2026-8-28'), 20260828);
  assert.equal(monthlyKey('qa_2026_09'), 20260901);
  assert.equal(monthlyKey('qa-2026-13'), null);
  assert.equal(monthlyKey('qa'), null);
  assert.equal(monthlyKey('feature/test'), null);
});

test('qa_merge: sortQaAndDevBranches puts newest monthly QA branch first', () => {
  const sorted = sortQaAndDevBranches([
    'master',
    'feature/login',
    'qa',
    'qa-2026-8-28',
    'qa-2026-11',
    'qa-hotfix'
  ]);
  assert.equal(sorted[0], 'qa-2026-11');
  assert.equal(sorted[1], 'qa-2026-8-28');
  assert.equal(sorted[2], 'qa-hotfix');
  assert.equal(sorted[3], 'qa');
  assert.equal(pickDefaultQaBranch(sorted), 'qa-2026-11');
});

test('qa_merge: validateBranchName blocks git argument injection and invalid refs', () => {
  assert.equal(validateBranchName('feature/ke-15'), 'feature/ke-15');
  assert.equal(validateBranchName('qa-2026-11'), 'qa-2026-11');
  assert.throws(() => validateBranchName('--upload-pack=evil'), /不能以 - 开头/);
  assert.throws(() => validateBranchName('a..b'), /非法的分支名称/);
  assert.throws(() => validateBranchName('branch with space'), /非法的分支名称/);
  assert.throws(() => validateBranchName(''), /不能为空/);
});

test('qa_merge: listUniversalProjects aggregates all catalog services beyond hardcoded 2 repos', () => {
  const projects = listUniversalProjects();
  assert.ok(projects.length > 5, 'Should include all primary services from default_services.json');
  const iot = projects.find(p => p.id === 'zulin-iot-platform');
  const warehouse = projects.find(p => p.id === 'beijia-iot-warehouse');
  const scs = projects.find(p => p.id === 'smart-customer-service');
  assert.ok(iot && iot.git.includes('iot-platform.git'));
  assert.ok(warehouse && warehouse.ci && warehouse.deploy);
  assert.ok(scs && scs.ci);
});

test('web_console: CREDENTIALS includes 18 items including ONES', () => {
  assert.equal(CREDENTIALS.length, 18);
  const ones = CREDENTIALS.find(c => c.id === 'ones');
  assert.ok(ones);
  assert.equal(ones.file, 'ones_cookie.json');
});

test('web_console: isValidJobId blocks path traversal', () => {
  assert.equal(isValidJobId('1732440000000-ab12cd'), true);
  assert.equal(isValidJobId('../shipwright_cookie'), false);
  assert.equal(isValidJobId('a/b'), false);
  assert.equal(isValidJobId(''), false);
  assert.equal(isValidJobId(null), false);
});

test('web_console: verifyLocalRequestSecurity blocks cross-origin CSRF and missing token', () => {
  assert.equal(
    verifyLocalRequestSecurity({ method: 'GET', headers: { host: '127.0.0.1:6886' } }).ok,
    true
  );
  assert.equal(
    verifyLocalRequestSecurity({ method: 'GET', headers: { host: 'evil.example.com' } }).ok,
    false
  );
  assert.equal(
    verifyLocalRequestSecurity({
      method: 'POST',
      headers: { host: '127.0.0.1:6886', origin: 'https://evil.example.com', 'x-leo-token': SESSION_CSRF_TOKEN }
    }).ok,
    false
  );
  assert.equal(
    verifyLocalRequestSecurity({
      method: 'POST',
      headers: { host: '127.0.0.1:6886', origin: 'http://127.0.0.1:6886' }
    }).ok,
    false
  );
  assert.equal(
    verifyLocalRequestSecurity({
      method: 'POST',
      headers: { host: '127.0.0.1:6886', origin: 'http://127.0.0.1:6886', 'x-leo-token': SESSION_CSRF_TOKEN }
    }).ok,
    true
  );
});

test('web_console: validateDeployParams does not require qaBranch for deploy_dev mode', () => {
  assert.doesNotThrow(() =>
    validateDeployParams({ project: 'zulin-iot-platform', devBranch: 'feature/x', qaBranch: '', mode: 'deploy_dev' })
  );
  assert.throws(
    () => validateDeployParams({ project: 'zulin-iot-platform', devBranch: 'feature/x', qaBranch: '', mode: 'merge_deploy' }),
    /合并模式需要同时选择开发分支与 QA 分支/
  );
});

test('web_console: buildHtmlPage inline script passes syntax check and embeds CSRF token', () => {
  const html = buildHtmlPage();
  assert.ok(html.includes(SESSION_CSRF_TOKEN));
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  assert.ok(script.length > 1000);
  assert.doesNotThrow(() => new Function(script));
});

test('web_console: extractJson extracts embedded JSON object from mixed stdout', () => {
  const mixed = '🔍 正在查询...\n{"ok":true,"count":2}\n完成';
  assert.deepEqual(extractJson(mixed), { ok: true, count: 2 });
});
