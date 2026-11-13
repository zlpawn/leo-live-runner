import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyEnvironment, assertWritePermitted } from '../scripts/common/env_detector.js';
import {
  findCatalogMatches,
  isEsDslUrl,
  buildSearchRequest,
  parseSearchResponse
} from '../scripts/common/es_resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_QUERY = path.join(__dirname, '..', 'scripts', 'es_query.js');
const SCRIPT_MODIFY = path.join(__dirname, '..', 'scripts', 'es_modify.js');

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise(res => server.close(res))
      });
    });
  });
}

function runScript(scriptPath, args, env = {}) {
  const home = env.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'leo-es-test-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: {
        ...process.env,
        HOME: home,
        SEARCH_COOKIE: 'search_self_token=mock-cookie-xyz',
        LEO_INSPECTOR_BROWSER_CREDENTIALS: 'off',
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr, home }));
  });
}

test('classifyEnvironment - 严格基于 TEST_PATTERNS 判定环境', () => {
  assert.equal(classifyEnvironment('http://search-zuul.search-platform-test.ttb.test.ke.com/api/search'), 'test');
  assert.equal(classifyEnvironment('http://search-zuul-gw-common-es8.search-platform-sit.ttb.test.ke.com/api/1013506001s1/search/es'), 'test');
  assert.equal(classifyEnvironment('http://inner-b01-gw.search.ke.com/api/1036710001/search'), 'prod');
  assert.equal(classifyEnvironment('http://10.26.33.14:10333'), 'prod');
  assert.equal(classifyEnvironment(''), 'prod');
  assert.equal(classifyEnvironment(null), 'prod');
});

test('assertWritePermitted - 生产环境写操作严格物理拦截', () => {
  const res1 = assertWritePermitted('prod', 'http://search-zuul.search-platform-test.ttb.test.ke.com');
  assert.equal(res1.allowed, false);
  assert.match(res1.reason, /生产环境/);

  const res2 = assertWritePermitted('test', 'http://fang-c03-stream.search.ke.com/api/data/123');
  assert.equal(res2.allowed, false);
  assert.match(res2.reason, /未识别到任何测试环境特征/);

  const res3 = assertWritePermitted('test', 'http://search-zuul-stream-es8.search-platform-sit.ttb.test.ke.com/api/data/1013506001s1');
  assert.equal(res3.allowed, true);
});

test('findCatalogMatches - 支持 serviceId、系统号、索引名与描述关键词匹配', () => {
  const catalog = [
    { serviceId: '1036710001', appSysCode: 367, name: '订单数据索引接入', demandDesc: '订单中心数据索引查询' },
    { serviceId: '1013810021', appSysCode: 719, name: 'IOT-智能门锁-门锁列表', demandDesc: 'IOT平台智能门锁列表查询' },
    { serviceId: '1013506001', appSysCode: 1121, name: '智能客服知识库建立', demandDesc: '智能客服知识库建立' }
  ];

  assert.equal(findCatalogMatches(catalog, '1036710001')[0].serviceId, '1036710001');
  assert.equal(findCatalogMatches(catalog, '719')[0].serviceId, '1013810021');
  assert.equal(findCatalogMatches(catalog, '订单')[0].serviceId, '1036710001');
  assert.equal(findCatalogMatches(catalog, '门锁')[0].serviceId, '1013810021');
  assert.equal(findCatalogMatches(catalog, '智能客服')[0].serviceId, '1013506001');
  assert.equal(findCatalogMatches(catalog, '不存在').length, 0);
});

test('buildSearchRequest & parseSearchResponse - 同时兼容 search-gw 与 es-dsl (/search/es)', () => {
  const gwTarget = {
    gatewayMode: 'search-gw',
    mapping: { city_code: { type: 'keyword' } }
  };
  assert.equal(isEsDslUrl('http://inner-b01-gw.search.ke.com/api/1036710001/search'), false);
  const gwReq = buildSearchRequest(gwTarget, { query: '合肥', filter: 'city_code:340100', page: 2, size: 5 });
  assert.deepEqual(gwReq, {
    page: 1,
    size: 5,
    query: '合肥',
    filters: { and: [{ field: 'city_code', values: ['340100'], operator: 'IN' }] }
  });
  const gwRes = parseSearchResponse(gwTarget, { code: 0, data: { total: 12, docs: [{ order_code: 'O1' }] } });
  assert.equal(gwRes.total, 12);
  assert.equal(gwRes.docs[0].order_code, 'O1');

  const dslTarget = {
    gatewayMode: 'es-dsl',
    mapping: {
      cityCode: { type: 'keyword' },
      battery: { type: 'integer' },
      title: { type: 'dense_vector', dims: 1024 }
    }
  };
  assert.equal(isEsDslUrl('http://search-zuul-gw-common-es8.search-platform-sit.ttb.test.ke.com/api/1013506001s1/search/es'), true);
  const dslReq = buildSearchRequest(dslTarget, {
    query: '密码',
    filter: 'cityCode:110000,battery:88',
    page: 1,
    size: 3,
    excludeVectors: true
  });
  assert.deepEqual(dslReq, {
    from: 0,
    size: 3,
    query: {
      bool: {
        must: [
          { query_string: { query: '密码' } },
          { term: { cityCode: '110000' } },
          { term: { battery: 88 } }
        ]
      }
    },
    _source: { excludes: ['title'] }
  });
  const dslRes = parseSearchResponse(dslTarget, {
    hits: { total: { value: 1 }, hits: [{ _id: '1', _source: { cityCode: '110000' } }] }
  });
  assert.equal(dslRes.total, 1);
  assert.deepEqual(dslRes.docs, [{ _id: '1', cityCode: '110000' }]);
});

test('CLI: es_query.js --help & es_modify.js --help', () => {
  const outQuery = execFileSync('node', [SCRIPT_QUERY, '--help'], { encoding: 'utf8' });
  assert.match(outQuery, /search\.ke\.com/);
  assert.match(outQuery, /--list-indexes/);
  assert.match(outQuery, /--schema/);

  const outModify = execFileSync('node', [SCRIPT_MODIFY, '--help'], { encoding: 'utf8' });
  assert.match(outModify, /ES 测试环境安全修改工具/);
  assert.match(outModify, /--confirm/);
});

test('CLI: es_query.js 通过 mock search.ke.com 完成目录、Schema 与双环境查询', async () => {
  let capturedDslBody = null;
  let capturedGwBody = null;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/ajax/createApp/getAppList') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'ok',
          data: {
            total: 3,
            appInfo: [
              {
                appSysCode: 367,
                serviceId: '1036710001',
                name: '订单数据索引接入',
                demandDesc: '订单中心数据索引查询',
                accessType: 'pull',
                engineType: 'es',
                status: 'ONLINE',
                role: { pm: [], rd: [], qa: [{ userName: '张林', userCode: '30560224' }] }
              },
              {
                appSysCode: 1121,
                serviceId: '1013506001',
                name: '智能客服知识库建立',
                demandDesc: '智能客服向量知识库',
                accessType: 'push',
                engineType: 'es',
                status: 'ONLINE',
                role: { pm: [], rd: [{ userName: '张林', userCode: '30560224' }], qa: [] }
              },
              {
                appSysCode: 719,
                serviceId: '1013810021',
                name: 'IOT-智能门锁-门锁列表',
                demandDesc: '门锁列表',
                accessType: 'pull',
                engineType: 'es',
                status: 'ONLINE',
                role: { pm: [], rd: [{ userName: '张林', userCode: '30560224' }], qa: [] }
              }
            ]
          }
        }));
      } else if (url.pathname === '/ajax/detailSearchQA/getVersionList') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: [{ version: 7, status: 'on' }] }));
      } else if (url.pathname === '/ajax/detailSearchQA/getConfig') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            search: `http://127.0.0.1:${mock.port}/gw/api/1036710001/search`,
            searchToken: 'prod-tok',
            routingField: 'city_code',
            searchCount: 100,
            readLimit: 300,
            topQps: 87,
            indexName: '1036710001_idx',
            mapping: {
              order_code: { type: 'keyword', index: true },
              city_code: { type: 'keyword', index: true },
              latest_commodity: {
                type: 'nested',
                properties: { item_name: { type: 'text' } }
              }
            },
            binlogSource: [{
              fromResourceName: 'epx-kafka-prod',
              fromTopics: ['topic_trade'],
              dbs: ['beijia_transaction'],
              dbInfos: [{ dbs: ['beijia_transaction'], host: 'm6129', port: 6129 }],
              targetInfos: [{ table: 'trade_order_info', gidField: 'order_code', fields: ['order_code', 'city_code'] }]
            }]
          }
        }));
      } else if (url.pathname === '/ajax/detailBusinessQA/getVersionList') {
        const sid = url.searchParams.get('serviceId');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (sid === '1013506001') {
          res.end(JSON.stringify({ code: 0, data: { version: [{ version: 2, status: 'on' }] } }));
        } else {
          res.end(JSON.stringify({ code: 1, message: 'no qa permission', data: null }));
        }
      } else if (url.pathname === '/ajax/detailBusinessQA/getConfig') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            search: `http://127.0.0.1:${mock.port}/es8/api/1013506001s1/search/es`,
            searchToken: 'test-es8-tok',
            push: 'http://search-zuul-stream-es8.search-platform-sit.ttb.test.ke.com/api/data/1013506001s1',
            pushToken: 'push-tok',
            mapping: {
              cityCode: { type: 'keyword', index: true },
              title: { type: 'dense_vector', dims: 1024, meta: { name: '中文文本模型' } },
              content: { type: 'text', analyzer: 'chinese_analyzer' }
            }
          }
        }));
      } else if (url.pathname === '/ajax/detailBusinessRD/getVersionList') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { version: [{ version: 17, status: 'on' }] } }));
      } else if (url.pathname === '/ajax/detailBusinessRD/getConfig') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            search: `http://127.0.0.1:${mock.port}/gw/api/1013810021/search`,
            searchToken: 'rd-tok',
            mapping: {
              lockId: { type: 'keyword', index: true },
              battery: { type: 'integer', index: true }
            }
          }
        }));
      } else if (url.pathname === '/gw/api/1036710001/search') {
        capturedGwBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            total: 1,
            docs: [{ order_code: 'ORD-999', city_code: '340100', latest_commodity: [{ item_name: '搬家服务' }] }]
          }
        }));
      } else if (url.pathname === '/gw/api/1013810021/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: { total: 1, docs: [{ lockId: '10001', battery: 85 }] }
        }));
      } else if (url.pathname === '/es8/api/1013506001s1/search/es') {
        capturedDslBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hits: {
            total: { value: 1 },
            hits: [{
              _id: '1',
              _source: {
                cityCode: '110000',
                title: new Array(32).fill(0.1234),
                content: '门锁临时密码有效期1小时'
              }
            }]
          }
        }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-es-home-'));
  const baseEnv = {
    HOME: home,
    LEO_SEARCH_BASE_URL: `http://127.0.0.1:${mock.port}`
  };

  try {
    // 1. --list-indexes
    const listRes = await runScript(SCRIPT_QUERY, ['--list-indexes'], baseEnv);
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.match(listRes.stdout, /1036710001/);
    assert.match(listRes.stdout, /订单数据索引接入/);
    assert.ok(fs.existsSync(path.join(home, '.shrimp', 'skills', 'live-inspector', 'es_catalog.json')));

    // 2. --schema (含 Mapping + 路由键 + binlogSource + 实时样本)
    const schemaRes = await runScript(SCRIPT_QUERY, ['订单', '--schema'], baseEnv);
    assert.equal(schemaRes.status, 0, schemaRes.stderr);
    assert.match(schemaRes.stdout, /路由字段: city_code/);
    assert.match(schemaRes.stdout, /beijia_transaction\.trade_order_info/);
    assert.match(schemaRes.stdout, /ORD-999/);
    assert.match(schemaRes.stdout, /item_name:text/);

    // 3. search-gw query
    const gwRes = await runScript(SCRIPT_QUERY, ['1036710001', '--filter', 'city_code:340100', '-n', '5'], baseEnv);
    assert.equal(gwRes.status, 0, gwRes.stderr);
    assert.deepEqual(capturedGwBody.filters, {
      and: [{ field: 'city_code', values: ['340100'], operator: 'IN' }]
    });
    assert.match(gwRes.stdout, /ORD-999/);

    // 4. es-dsl (/search/es) test query + vector summary
    const dslRes = await runScript(SCRIPT_QUERY, ['智能客服', '-e', 'test', '-q', '密码', '--filter', 'cityCode:110000'], baseEnv);
    assert.equal(dslRes.status, 0, dslRes.stderr);
    assert.equal(capturedDslBody.query.bool.must[0].query_string.query, '密码');
    assert.equal(capturedDslBody.query.bool.must[1].term.cityCode, '110000');
    assert.match(dslRes.stdout, /\[dense_vector\(32\)/);
    assert.match(dslRes.stdout, /门锁临时密码有效期1小时/);

    // 5. test env QA -> RD fallback
    const rdRes = await runScript(SCRIPT_QUERY, ['门锁', '-e', 'test', '-n', '2'], baseEnv);
    assert.equal(rdRes.status, 0, rdRes.stderr);
    assert.match(rdRes.stdout, /detailBusinessRD/);
    assert.match(rdRes.stdout, /10001/);

    // 6. es_modify.js prod block
    const prodBlock = await runScript(SCRIPT_MODIFY, ['1036710001', '--action', 'update-part', '--id', '1', '--data', '{"a":1}', '-e', 'prod'], baseEnv);
    assert.equal(prodBlock.status, 1);
    assert.match(prodBlock.stderr, /风控红线拦截/);

    // 7. es_modify.js test dry-run
    const dryRun = await runScript(SCRIPT_MODIFY, ['智能客服', '--action', 'update-part', '--id', '1', '--data', '{"content":"新内容"}', '-e', 'test'], baseEnv);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Pre-flight Dry-Run/);
    assert.match(dryRun.stdout, /门锁临时密码有效期1小时/);
    assert.match(dryRun.stdout, /新内容/);
  } finally {
    await mock.close();
  }
});
