import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listExts,
  getExt,
  listPerms,
  getPerm,
  listRoles,
  getRole,
  listRoleUsers
} from '../scripts/common/luke.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

test('Luke Common Client - listExts & getExt', async () => {
  const exts = await listExts('iot_auth');
  assert.ok(exts.total > 0, 'Exts total should be greater than 0');
  assert.ok(exts.nodes.some(e => e.id === 'serviceId'), 'Should contain serviceId constraint');

  const serviceIdExt = await getExt('iot_auth', 'serviceId');
  assert.equal(serviceIdExt.id, 'serviceId');
  assert.equal(serviceIdExt.kind, 'Choice');
  assert.ok(Array.isArray(serviceIdExt.choices) && serviceIdExt.choices.length > 0);
});

test('Luke Common Client - listPerms & getPerm', async () => {
  const perms = await listPerms('iot_auth', { pager: { pageSize: 5, current: 1 } });
  assert.ok(perms.total > 0, 'Perms total should be greater than 0');
  assert.ok(perms.nodes.length > 0);

  const samplePerm = perms.nodes[0];
  const permDetail = await getPerm('iot_auth', samplePerm.id);
  assert.equal(permDetail.id, samplePerm.id);
  assert.ok(Array.isArray(permDetail.attachedExts));
});

test('Luke Common Client - listRoles & getRole & listRoleUsers', async () => {
  const roles = await listRoles('iot_auth', { pager: { pageSize: 5, current: 1 } });
  assert.ok(roles.total > 0, 'Roles total should be greater than 0');

  const adminRole = await getRole('iot_auth', 'admin');
  assert.equal(adminRole.id, 'admin');
  assert.ok(Array.isArray(adminRole.perms));

  const adminUsers = await listRoleUsers('iot_auth', 'admin', { pager: { pageSize: 5, current: 1 } });
  assert.ok(adminUsers.total > 0);
  assert.ok(adminUsers.nodes.length > 0);
  assert.ok(adminUsers.nodes[0].ucid);
});

test('Luke CLI - luke_query.js outputs ext table', async () => {
  const { stdout } = await execFileAsync('node', [
    path.join(SCRIPTS_DIR, 'luke_query.js'),
    'ext',
    'serviceId'
  ]);
  assert.ok(stdout.includes('[serviceId] 服务id'));
  assert.ok(stdout.includes('枚举取值列表'));
});

test('Luke CLI - luke_modify.js Pre-flight Dry-Run mode without writing', async () => {
  const { stdout } = await execFileAsync('node', [
    path.join(SCRIPTS_DIR, 'luke_modify.js'),
    'update-perm',
    'anjia:storage:order:afterSaleOrder',
    '--api',
    '/anjia/test/dryRunOnly'
  ]);
  assert.ok(stdout.includes('📑 变更预审报告 (Pre-flight Diff)'));
  assert.ok(stdout.includes('⚠️  [两阶段风控提示 - 试运行未真正写入]'));
  assert.ok(stdout.includes('--confirm'));
});

test('Luke CLI - luke_modify.js High-Risk Deletion Dry-Run triggers security banner', async () => {
  const { stdout } = await execFileAsync('node', [
    path.join(SCRIPTS_DIR, 'luke_modify.js'),
    'update-perm',
    'anjia:storage:order:afterSaleOrder',
    '--remove-api',
    '/test/api'
  ]);
  assert.ok(stdout.includes('🚨🚨🚨【高危操作预审报告 (HIGH RISK DELETION)】'));
  assert.ok(stdout.includes('⚠️ 剔除的接口'));
  assert.ok(stdout.includes('级联影响角色数'));
  assert.ok(stdout.includes('--confirm'));
});
