import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyEnvironment, assertWritePermitted, TEST_PATTERNS } from '../scripts/common/env_detector.js';
import { getCandidateProjectRoots } from '../scripts/common/local_repo_scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_QUERY = path.join(__dirname, '..', 'scripts', 'es_query.js');
const SCRIPT_MODIFY = path.join(__dirname, '..', 'scripts', 'es_modify.js');

test('classifyEnvironment - 严格基于 TEST_PATTERNS 判定环境', () => {
  // 1. 符合测试特征的域名
  assert.equal(classifyEnvironment('http://search-zuul.search-platform-test.ttb.test.ke.com/api/search'), 'test');
  assert.equal(classifyEnvironment('http://search-zuul.search-platform-sit.ttb.test.ke.com/api/search'), 'test');
  assert.equal(classifyEnvironment('http://test.config.apollo.ke.com'), 'test');
  assert.equal(classifyEnvironment('http://dev.config.apollo.ke.com'), 'test');
  assert.equal(classifyEnvironment('http://kafka01-test.lianjia.com:9092'), 'test');
  assert.equal(classifyEnvironment('http://qa-server.ke.com'), 'test');
  assert.equal(classifyEnvironment('m10155.mars.test.mysql.ljnode.com'), 'test');

  // 2. 生产环境或未知环境 (疑罪从严默认归类为 prod)
  assert.equal(classifyEnvironment('http://fang-c03-gw.search.ke.com/api/search'), 'prod');
  assert.equal(classifyEnvironment('http://fang-c03-stream.search.ke.com'), 'prod');
  assert.equal(classifyEnvironment('http://prod.config.apollo.ke.com'), 'prod');
  assert.equal(classifyEnvironment('http://10.26.33.14:10333'), 'prod'); // 纯内网IP无测试标记视为prod保护
  assert.equal(classifyEnvironment(''), 'prod');
  assert.equal(classifyEnvironment(null), 'prod');
});

test('assertWritePermitted - 生产环境写操作严格物理拦截', () => {
  // 显式指定 prod 拦截
  const res1 = assertWritePermitted('prod', 'http://search-zuul.search-platform-test.ttb.test.ke.com');
  assert.equal(res1.allowed, false);
  assert.match(res1.reason, /生产环境/);

  // 目标 URL 为线上地址拦截 (即使传了 test)
  const res2 = assertWritePermitted('test', 'http://fang-c03-stream.search.ke.com/api/data/123');
  assert.equal(res2.allowed, false);
  assert.match(res2.reason, /未识别到任何测试环境特征/);

  // 真实测试环境放行
  const res3 = assertWritePermitted('test', 'http://search-zuul-write.search-platform-test.ttb.test.ke.com/api/data/123');
  assert.equal(res3.allowed, true);
});

test('getCandidateProjectRoots - 纯动态推导且不包含硬编码', () => {
  const roots = getCandidateProjectRoots();
  assert.ok(Array.isArray(roots));
  assert.ok(roots.length > 0);
  assert.ok(roots.includes(process.cwd()));

  // 确保没有写死特定的用户名逻辑
  const srcContent = String(getCandidateProjectRoots.toString());
  assert.equal(srcContent.includes('/Users/pa'), false);
  assert.equal(srcContent.includes('C:\\Users'), false);
});

test('CLI: es_query.js --help', () => {
  const out = execFileSync('node', [SCRIPT_QUERY, '--help'], { encoding: 'utf8' });
  assert.match(out, /ES 搜索与索引结构探查工具/);
  assert.match(out, /--schema/);
  assert.match(out, /--list-services/);
});

test('CLI: es_modify.js --help', () => {
  const out = execFileSync('node', [SCRIPT_MODIFY, '--help'], { encoding: 'utf8' });
  assert.match(out, /ES 测试环境安全修改工具/);
  assert.match(out, /--confirm/);
  assert.match(out, /update-part/);
});

test('CLI: es_modify.js 生产环境写操作被阻断', () => {
  try {
    execFileSync('node', [
      SCRIPT_MODIFY,
      '-a', 'iot-platform',
      '-s', 'lock',
      '--action', 'update-part',
      '--id', 'test999',
      '--data', '{"battery": 100}',
      '-e', 'prod'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('Should have exited with non-zero exit code');
  } catch (err) {
    assert.equal(err.status, 1);
    const stderr = err.stderr || err.stdout;
    assert.match(stderr, /风控红线拦截/);
  }
});
