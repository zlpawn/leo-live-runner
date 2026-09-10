import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DINSIGHT_ASSISTANT_TOKEN_KEY,
  parseDinsightCredentialInput,
  buildDinsightCookieHeader
} from '../scripts/common/dinsight.js';

test('parseDinsightCredentialInput accepts a copied assistant token', () => {
  const parsed = parseDinsightCredentialInput('prd-token-abc');
  assert.equal(parsed.token, 'prd-token-abc');
  assert.equal(parsed.csrfToken, '');
  assert.equal(parsed.cookie, 'prd-assistant-token-prod=prd-token-abc');
});

test('parseDinsightCredentialInput accepts a cookie header and extracts csrf', () => {
  const parsed = parseDinsightCredentialInput('prd-assistant-token-prod=tok123; csrf_token=csrf456; lianjia_uuid=u1');
  assert.equal(parsed.token, 'tok123');
  assert.equal(parsed.csrfToken, 'csrf456');
  assert.match(parsed.cookie, /prd-assistant-token-prod=tok123/);
  assert.match(parsed.cookie, /csrf_token=csrf456/);
  assert.equal(parsed.cookie.includes('lianjia_uuid='), false);
});

test('parseDinsightCredentialInput keeps access_token but drops unrelated cookies', () => {
  const parsed = parseDinsightCredentialInput('SECKEY_ABVK=big; prd-assistant-token-prod=tok123; access_token=jwt; login_ucid=1001; csrf_token=csrf456; BMAP_SECKEY=huge');
  assert.equal(parsed.token, 'tok123');
  assert.equal(parsed.cookie, 'prd-assistant-token-prod=tok123; access_token=jwt; login_ucid=1001; csrf_token=csrf456');
});

test('parseDinsightCredentialInput extracts the assistant token from Netscape cookies.txt', () => {
  const netscape = [
    '# Netscape HTTP Cookie File',
    '.ke.com\tTRUE\t/\tFALSE\t0\tprd-assistant-token-prod\ttok789',
    '.ke.com\tTRUE\t/\tFALSE\t0\tcsrf_token\tcsrf789',
    '.ke.com\tTRUE\t/\tFALSE\t0\tlianjia_uuid\tuuid-1'
  ].join('\n');
  const parsed = parseDinsightCredentialInput(netscape);
  assert.equal(parsed.token, 'tok789');
  assert.equal(parsed.csrfToken, 'csrf789');
});

test('buildDinsightCookieHeader always includes the assistant token and optional csrf', () => {
  assert.equal(
    buildDinsightCookieHeader({ token: 'tok', csrfToken: 'csrf' }),
    'prd-assistant-token-prod=tok; csrf_token=csrf'
  );
  assert.equal(
    DINSIGHT_ASSISTANT_TOKEN_KEY,
    'prd-assistant-token-prod'
  );
});
