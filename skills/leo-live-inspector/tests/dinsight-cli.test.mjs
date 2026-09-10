import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(testDir, '..', 'scripts', 'dinsight_query.js');

function runCli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-dinsight-'));
  return {
    home,
    ...spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ...env }
    })
  };
}

test('--set-token persists the copied assistant token', () => {
  const result = runCli(['--set-token', 'prd-copied-token']);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(result.home, '.shrimp', 'skills', 'live-inspector', 'dinsight_cookie.json'), 'utf8'));
  assert.equal(saved.token, 'prd-copied-token');
  assert.match(saved.cookie, /prd-assistant-token-prod=prd-copied-token/);
});

test('--set-token keeps only Dinsight cookies from a full header', () => {
  const header = 'SECKEY_ABVK=big; prd-assistant-token-prod=tok123; access_token=jwt; login_ucid=1001; security_ticket=st; csrf_token=csrf456; BMAP_SECKEY=huge';
  const result = runCli(['--set-token', header]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prd-assistant-token-prod, access_token, login_ucid, security_ticket, csrf_token/);
  assert.match(result.stdout, /已丢弃无关 Cookie/);
  const saved = JSON.parse(fs.readFileSync(path.join(result.home, '.shrimp', 'skills', 'live-inspector', 'dinsight_cookie.json'), 'utf8'));
  assert.equal(saved.cookie.includes('SECKEY_ABVK='), false);
  assert.equal(saved.cookie.includes('access_token=jwt'), true);
});

test('missing credentials prints the copy-token guide', () => {
  const result = runCli(['--whoami']);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /prd-assistant-token-prod/);
  assert.match(result.stderr + result.stdout, /ke.com/);
});
