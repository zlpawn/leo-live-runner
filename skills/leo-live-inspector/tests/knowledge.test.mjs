import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { knowledgeDirectory, readWorkflow, saveWorkflow, searchWorkflows } from '../scripts/knowledge.js';

const cli = fileURLToPath(new URL('../scripts/knowledge.js', import.meta.url));
const sample = {
  id: 'order-sync', title: '工单状态未同步', summary: '按工单号定位同步处理过程',
  services: ['iot'], keywords: ['工单', '同步', '状态'], parameters: ['env', 'orderId', 'from', 'to'],
  content: '# 查询流程\n\n用 ${orderId} 查日志，提取 traceId。\n未找到时检查时间范围；不能断言事件不存在。'
};

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-knowledge-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'knowledge');
}

function run(root, args, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', input: input && JSON.stringify(input),
    env: { ...process.env, LEO_INSPECTOR_KNOWLEDGE_DIR: root }
  });
}

test('default and configured directories are independent of the skill checkout', () => {
  const home = path.join(os.tmpdir(), 'example-home');
  assert.equal(knowledgeDirectory({}, home), path.join(home, '.shrimp/skills/live-inspector/knowledge'));
  assert.equal(knowledgeDirectory({ LEO_INSPECTOR_KNOWLEDGE_DIR: '~/custom' }, home), path.join(home, 'custom'));
  assert.throws(() => knowledgeDirectory({ LEO_INSPECTOR_KNOWLEDGE_DIR: 'relative' }, home), /绝对路径/);
});

test('reading an empty library does not create directories', t => {
  const root = temp(t);
  assert.deepEqual(searchWorkflows(root), { workflows: [], warnings: [] });
  assert.equal(fs.existsSync(root), false);
});

test('save and show preserve parameterized Markdown across CLI processes', t => {
  const root = temp(t);
  const saved = run(root, ['save', '--file', '-', '--expected-version', '0'], sample);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).version, 1);
  const shown = run(root, ['show', sample.id]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).content, sample.content);
  assert.match(fs.readFileSync(JSON.parse(saved.stdout).file, 'utf8'), /# 查询流程/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(JSON.parse(saved.stdout).file).mode & 0o777, 0o600);
});

test('Chinese keyword search, service filter and body search return compact summaries', t => {
  const root = temp(t);
  saveWorkflow(root, sample, 0);
  saveWorkflow(root, { ...sample, id: 'lock', title: '门锁', summary: '开门异常', keywords: ['门锁'], services: ['lock'], content: '定位设备' }, 0);
  const found = searchWorkflows(root, '工单 同步', 'iot').workflows;
  assert.deepEqual(found.map(item => item.id), ['order-sync']);
  assert.equal('content' in found[0], false);
  assert.equal(searchWorkflows(root, 'traceId').workflows.length, 1);
  assert.equal(searchWorkflows(root, '工单', 'lock').workflows.length, 0);
  assert.equal(searchWorkflows(root, '支付退款').workflows.length, 0);
});

test('updates preserve creation time and reject stale or accidental overwrite', t => {
  const root = temp(t);
  const first = saveWorkflow(root, sample, 0);
  const second = saveWorkflow(root, { ...sample, content: '新增已验证分支' }, 1);
  assert.equal(second.version, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.throws(() => saveWorkflow(root, sample, 0), /版本冲突/);
  assert.throws(() => saveWorkflow(root, sample, 1), /版本冲突/);
  assert.equal(readWorkflow(root, sample.id).content, '新增已验证分支');
  assert.deepEqual(fs.readdirSync(path.join(root, 'workflows')), ['order-sync.md']);
});

test('invalid input and traversal never write workflow files', t => {
  const root = temp(t);
  for (const input of [{ ...sample, id: '../escape' }, { ...sample, content: '' }, { ...sample, services: 'iot' }]) {
    assert.throws(() => saveWorkflow(root, input, 0));
  }
  assert.equal(fs.existsSync(root), false);
  assert.throws(() => readWorkflow(root, '../escape'));
});

test('a corrupt workflow warns without hiding healthy workflows or overwriting data', t => {
  const root = temp(t);
  saveWorkflow(root, sample, 0);
  const bad = path.join(root, 'workflows/bad.md');
  fs.writeFileSync(bad, 'broken');
  const result = searchWorkflows(root);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.throws(() => saveWorkflow(root, { ...sample, id: 'bad' }, 0), /格式无效/);
  assert.equal(fs.readFileSync(bad, 'utf8'), 'broken');
});

test('existing writer lock blocks writes without being removed', t => {
  const root = temp(t);
  const lock = path.join(root, 'workflows/order-sync.md.lock');
  fs.mkdirSync(lock, { recursive: true });
  assert.throws(() => saveWorkflow(root, sample, 0), /锁/);
  assert.equal(fs.existsSync(lock), true);
});

test('two CLI writers cannot both replace the same version', async t => {
  const root = temp(t);
  saveWorkflow(root, sample, 0);
  const write = content => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'save', '--file', '-', '--expected-version', '1'], {
      env: { ...process.env, LEO_INSPECTOR_KNOWLEDGE_DIR: root }, stdio: ['pipe', 'pipe', 'pipe']
    });
    child.on('error', reject);
    child.on('close', code => resolve(code));
    child.stdin.end(JSON.stringify({ ...sample, content }));
  });
  const statuses = await Promise.all([write('分支 A'), write('分支 B')]);
  assert.deepEqual(statuses.sort(), [0, 1]);
  assert.equal(readWorkflow(root, sample.id).version, 2);
});

test('CLI rejects malformed options and does not leak malformed JSON', t => {
  const root = temp(t);
  for (const args of [['save', '--file', '-'], ['save', '--file', '-', '--expected-version', '-1'], ['search'], ['show', '../x'], ['list', '--unknown']]) {
    assert.equal(run(root, args, sample).status, 1);
  }
  const result = spawnSync(process.execPath, [cli, 'save', '--file', '-', '--expected-version', '0'], {
    encoding: 'utf8', input: '{"secret":"do-not-echo", broken}', env: { ...process.env, LEO_INSPECTOR_KNOWLEDGE_DIR: root }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('do-not-echo'), false);
});
