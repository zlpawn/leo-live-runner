import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(testDir, '..', 'scripts', 'cloud_mysql_query.js');

function buildFakeXlsxBase64() {
  const python = `
import zipfile, io, base64, sys
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as zf:
    zf.writestr('xl/worksheets/sheet1.xml', '''<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2" t="s"><v>3</v></c>
    </row>
  </sheetData>
</worksheet>''')
    zf.writestr('xl/sharedStrings.xml', '''<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>id</t></si>
  <si><t>name</t></si>
  <si><t>101</t></si>
  <si><t>device_alpha</t></si>
</sst>''')
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
`;
  const result = spawnSync('python3', ['-c', python], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        close: () => new Promise(res => server.close(res))
      });
    });
  });
}

function runCliAsync(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-cloud-mysql-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CLOUD_MYSQL_TOKEN: 'mock-test-token-12345',
        ...env
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr, home });
    });
  });
}

test('SQL error in cloud query is intercepted and does NOT trigger get_result QueryId validation error', async () => {
  let getResultCalled = false;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/query') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: {
            query_id: '',
            file_path: '',
            query_result: '',
            error: "Error 1146: Table 'utopia_scs_recorder.non_existing_table' doesn't exist"
          }
        }));
      } else if (req.url === '/get_result') {
        getResultCalled = true;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 100000,
          message: "Key: 'QueryResultRequest.QueryId' Error:Field validation for 'QueryId' failed on the 'required' tag",
          data: null
        }));
      }
    });
  });

  try {
    const result = await runCliAsync(['recorder', 'SELECT * FROM non_existing_table'], {
      LEO_CLOUD_MYSQL_QUERY_URL: `http://127.0.0.1:${mock.port}/query`,
      LEO_CLOUD_MYSQL_GET_RESULT_URL: `http://127.0.0.1:${mock.port}/get_result`
    });

    assert.equal(result.status, 1);
    assert.equal(getResultCalled, false, 'get_result must NOT be called when query had an error');
    assert.match(result.stderr, /❌ SQL 执行失败: Error 1146: Table 'utopia_scs_recorder\.non_existing_table' doesn't exist/);
    assert.match(result.stderr, /SHOW TABLES/);
    assert.doesNotMatch(result.stderr, /QueryResultRequest\.QueryId/);
  } finally {
    await mock.close();
  }
});

test('SQL error with --json formats clean JSON error payload', async () => {
  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/query') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: {
            query_id: '',
            file_path: '',
            query_result: '',
            error: "Error 1054: Unknown column 'non_col' in 'field list'"
          }
        }));
      }
    });
  });

  try {
    const result = await runCliAsync(['recorder', 'SELECT non_col FROM image_understanding_detail', '--json'], {
      LEO_CLOUD_MYSQL_QUERY_URL: `http://127.0.0.1:${mock.port}/query`,
      LEO_CLOUD_MYSQL_GET_RESULT_URL: `http://127.0.0.1:${mock.port}/get_result`
    });

    assert.equal(result.status, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.success, false);
    assert.match(json.error, /Unknown column 'non_col'/);
    assert.equal(json.service, 'recorder');
  } finally {
    await mock.close();
  }
});

test('Successful cloud query fetches result and outputs table', async () => {
  const fakeXlsx = buildFakeXlsxBase64();
  let queryPayload = null;
  let resultPayload = null;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/query') {
        queryPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: {
            query_id: 'mock-query-id-9988',
            file_path: 'mock_file.xlsx',
            query_result: 'Get rows: 1 Query cost: 2.5ms\n',
            error: ''
          }
        }));
      } else if (req.url === '/get_result') {
        resultPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: fakeXlsx
        }));
      }
    });
  });

  try {
    const result = await runCliAsync(['recorder', 'SELECT id, name FROM device LIMIT 1'], {
      LEO_CLOUD_MYSQL_QUERY_URL: `http://127.0.0.1:${mock.port}/query`,
      LEO_CLOUD_MYSQL_GET_RESULT_URL: `http://127.0.0.1:${mock.port}/get_result`
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(queryPayload.database, 'utopia_scs_recorder');
    assert.equal(resultPayload.query_id, 'mock-query-id-9988');
    assert.match(result.stdout, /device_alpha/);
    assert.match(result.stdout, /\| id \| name \|/);
  } finally {
    await mock.close();
  }
});

test('Successful cloud query with --json outputs clean json with success: true', async () => {
  const fakeXlsx = buildFakeXlsxBase64();

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/query') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: {
            query_id: 'mock-query-id-7766',
            file_path: 'mock_file.xlsx',
            query_result: 'Get rows: 1 Query cost: 1.2ms\n',
            error: ''
          }
        }));
      } else if (req.url === '/get_result') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: fakeXlsx
        }));
      }
    });
  });

  try {
    const result = await runCliAsync(['recorder', 'SELECT id, name FROM device LIMIT 1', '--json'], {
      LEO_CLOUD_MYSQL_QUERY_URL: `http://127.0.0.1:${mock.port}/query`,
      LEO_CLOUD_MYSQL_GET_RESULT_URL: `http://127.0.0.1:${mock.port}/get_result`
    });

    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.success, true);
    assert.deepEqual(json.headers, ['id', 'name']);
    assert.deepEqual(json.rows, [['101', 'device_alpha']]);
  } finally {
    await mock.close();
  }
});

test('Empty query_id without error message is defensively caught', async () => {
  let getResultCalled = false;

  const mock = await createMockServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/query') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 200000,
          message: 'OK',
          data: {
            query_id: '',
            file_path: '',
            error: ''
          }
        }));
      } else if (req.url === '/get_result') {
        getResultCalled = true;
      }
    });
  });

  try {
    const result = await runCliAsync(['recorder', 'SELECT 1'], {
      LEO_CLOUD_MYSQL_QUERY_URL: `http://127.0.0.1:${mock.port}/query`,
      LEO_CLOUD_MYSQL_GET_RESULT_URL: `http://127.0.0.1:${mock.port}/get_result`
    });

    assert.equal(result.status, 1);
    assert.equal(getResultCalled, false);
    assert.match(result.stderr, /未生成有效 query_id/);
  } finally {
    await mock.close();
  }
});
