import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowserCookies, normalizeCredentialRequest } from '../scripts/credential_relay.js';
import { LanternServer } from '../scripts/cli/lib/server.mjs';
import { exportCookies } from '../resources/chrome_extension/cookie-export.mjs';
import { startFakeExtension } from './fake-extension.mjs';

const cookie = { name: 'sid', value: 'test-secret', domain: 'example.com', path: '/', secure: true, httpOnly: true, hostOnly: true, session: true };

/** A real bridge plus the real extension cookie code, reading from a stand-in for the browser. */
async function startBrowser(browserCookie = [], visit = () => ({ cookies: [] })) {
  const reads = [];
  const chromeApi = {
    cookies: {
      getAll: async (details) => {
        reads.push(details);
        return typeof browserCookie === 'function' ? browserCookie(details) : browserCookie;
      },
    },
  };
  const fake = await startFakeExtension(async (cmd) => {
    if (cmd.type !== 'cookies.visit') return exportCookies(chromeApi, cmd.params);
    const page = await visit(cmd.params);
    return { matchedBy: 'url', loginRequired: false, finalUrl: cmd.params.url, ...page };
  });
  return { ...fake, reads };
}

/** Bridge port is read from the environment, so point this process at the test bridge. */
async function withBridgePort(port, run) {
  const previous = process.env.LEO_LANTERN_PORT;
  process.env.LEO_LANTERN_PORT = String(port);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LEO_LANTERN_PORT;
    else process.env.LEO_LANTERN_PORT = previous;
  }
}

test('reads through the bridge by url and returns only the requested cookies', async () => {
  const browser = await startBrowser([cookie, { ...cookie, name: 'other', value: 'not-selected' }]);
  try {
    const cookies = await withBridgePort(browser.port, () =>
      getBrowserCookies({ url: 'https://example.com/api?private=1#x', names: ['sid'], timeoutMs: 2000 })
    );
    assert.deepEqual(cookies, [cookie]);
    assert.deepEqual(browser.reads, [{ url: 'https://example.com/api' }]);
    assert.equal(browser.commands[0].type, 'cookies.export');
  } finally {
    await browser.stop();
  }
});

test('keeps parent-domain cookies but drops sibling, expired, partitioned and mismatched-path ones', async () => {
  const valid = { ...cookie, path: '/api' };
  const parent = { ...cookie, name: 'login', domain: '.example.com', hostOnly: false };
  const browser = await startBrowser([
    valid,
    parent,
    { ...cookie, domain: 'other.example.com' },
    { ...cookie, path: '/api/private' },
    { ...cookie, expirationDate: 1 },
    { ...cookie, partitionKey: { topLevelSite: 'https://example.com' } },
  ]);
  try {
    const cookies = await withBridgePort(browser.port, () =>
      getBrowserCookies({ url: 'https://example.com/api', timeoutMs: 2000 })
    );
    assert.deepEqual(cookies, [valid, parent]);
  } finally {
    await browser.stop();
  }
});

test('an extension that ignored the url asks for a reload and its cookies are not used', async () => {
  const fake = await startFakeExtension(() => ({ cookies: [cookie], count: 1 }));
  try {
    await withBridgePort(fake.port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com', timeoutMs: 2000 }), (err) => {
        assert.equal(err.code, 'EXTENSION_OUTDATED');
        assert.match(err.message, /chrome:\/\/extensions/);
        return true;
      })
    );
    assert.equal(fake.commands[0].params.domain, 'example.com');
  } finally {
    await fake.stop();
  }
});

test('no cookies, and none after opening the site, reads as not found', async () => {
  const browser = await startBrowser([]);
  try {
    await withBridgePort(browser.port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com', timeoutMs: 2000 }), { code: 'COOKIE_NOT_FOUND' })
    );
    assert.deepEqual(browser.commands.map((cmd) => cmd.type), ['cookies.export', 'cookies.visit']);
  } finally {
    await browser.stop();
  }
});

test('missing cookies are fetched by opening the site root, and read for the requested url', async () => {
  const browser = await startBrowser([], () => ({ cookies: [cookie] }));
  try {
    const cookies = await withBridgePort(browser.port, () =>
      getBrowserCookies({ url: 'https://example.com/api/me', timeoutMs: 2000 })
    );
    assert.deepEqual(cookies.map((c) => c.name), ['sid']);
    const visit = browser.commands[1];
    assert.equal(visit.params.url, 'https://example.com/');
    assert.equal(visit.params.cookieUrl, 'https://example.com/api/me');
  } finally {
    await browser.stop();
  }
});

test('a site that needs a login says so and its cookies are not used', async () => {
  const browser = await startBrowser([], () => ({ cookies: [cookie], loginRequired: true, finalUrl: 'https://login.example.com/' }));
  try {
    await withBridgePort(browser.port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com/', timeoutMs: 2000 }), (err) => {
        assert.equal(err.code, 'LOGIN_REQUIRED');
        assert.match(err.message, /example\.com/);
        assert.match(err.message, /登录/);
        return true;
      })
    );
  } finally {
    await browser.stop();
  }
});

test('visit: true opens the site even though cookies exist', async () => {
  const renewed = { ...cookie, value: 'renewed' };
  const browser = await startBrowser([cookie], () => ({ cookies: [renewed] }));
  try {
    const cookies = await withBridgePort(browser.port, () =>
      getBrowserCookies({ url: 'https://example.com/', visit: true, timeoutMs: 2000 })
    );
    assert.deepEqual(cookies, [renewed]);
    assert.deepEqual(browser.commands.map((cmd) => cmd.type), ['cookies.visit']);
  } finally {
    await browser.stop();
  }
});

test('present cookies never open the site', async () => {
  const browser = await startBrowser([cookie], () => assert.fail('must not visit'));
  try {
    await withBridgePort(browser.port, () => getBrowserCookies({ url: 'https://example.com/', timeoutMs: 2000 }));
    assert.deepEqual(browser.commands.map((cmd) => cmd.type), ['cookies.export']);
  } finally {
    await browser.stop();
  }
});

test('an extension without visits asks for a reload', async () => {
  const fake = await startFakeExtension((cmd) => {
    if (cmd.type === 'cookies.visit') throw { code: 'invalid_request', message: 'Unsupported task type: cookies.visit' };
    return { cookies: [], count: 0, matchedBy: 'url' };
  });
  try {
    await withBridgePort(fake.port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com/', timeoutMs: 2000 }), { code: 'EXTENSION_OUTDATED' })
    );
  } finally {
    await fake.stop();
  }
});

test('a browser that never connects times out', async () => {
  const bridge = new LanternServer({ port: 0 });
  await bridge.start();
  try {
    await withBridgePort(bridge.port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com', timeoutMs: 300 }), { code: 'RELAY_TIMEOUT' })
    );
  } finally {
    await bridge.stop();
  }
});

test('a browser opened while waiting is still used', async () => {
  const bridge = new LanternServer({ port: 0 });
  await bridge.start();
  let polling = true;
  const late = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    while (polling) {
      const { cmd } = await (await fetch(`http://127.0.0.1:${bridge.port}/ext/poll?waitMs=50`)).json();
      if (!cmd) continue;
      const result = { cookies: [cookie], count: 1, matchedBy: 'url' };
      await fetch(`http://127.0.0.1:${bridge.port}/ext/result`, { method: 'POST', body: JSON.stringify({ id: cmd.id, ok: true, result }) });
    }
  })();
  try {
    const cookies = await withBridgePort(bridge.port, () => getBrowserCookies({ url: 'https://example.com', timeoutMs: 3000 }));
    assert.deepEqual(cookies, [cookie]);
  } finally {
    polling = false;
    await late;
    await bridge.stop();
  }
});

test('rejects invalid targets before touching the bridge', async () => {
  for (const url of ['', 'file:///tmp/x', 'https://user:pass@example.com']) {
    await assert.rejects(getBrowserCookies({ url }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => normalizeCredentialRequest({ url: 'https://example.com', names: [] }), { code: 'INVALID_REQUEST' });
});

test('another service holding the port is reported, not taken over', async () => {
  const other = http.createServer((req, res) => res.end('{}'));
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    await withBridgePort(other.address().port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com', timeoutMs: 20000 }), { code: 'RELAY_BUSY' })
    );
    assert.equal(other.listening, true);
  } finally {
    other.closeAllConnections();
    await new Promise((resolve) => other.close(resolve));
  }
});

test('opt-out does not start a bridge', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const previous = process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS;
  process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS = 'off';
  try {
    await withBridgePort(port, () =>
      assert.rejects(getBrowserCookies({ url: 'https://example.com' }), { code: 'BROWSER_CREDENTIALS_DISABLED' })
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    if (previous === undefined) delete process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS;
    else process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS = previous;
  }
});

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function runBusiness(script, args, handler, browserCookie, seed = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-relay-cli-'));
  const dir = path.join(home, '.shrimp/skills/live-inspector');
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, data] of Object.entries(seed)) {
    fs.writeFileSync(path.join(file.endsWith('.txt') ? home : dir, file), typeof data === 'string' ? data : JSON.stringify(data));
  }
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await startBrowser(browserCookie);
  const env = { ...process.env, HOME: home, LEO_TEST_HTTP_PORT: String(server.address().port), LEO_LANTERN_PORT: String(browser.port) };
  for (const key of ['CLOUD_MYSQL_TOKEN', 'CLOUD_CONSOLE_TOKEN', 'CLOUD_COOKIE', 'SHIPWRIGHT_COOKIE', 'FECI_COOKIE', 'APOLLO_TEST_COOKIE', 'DINSIGHT_TOKEN', 'DINSIGHT_COOKIE', 'PAODING_COOKIE', 'LEO_INSPECTOR_BROWSER_CREDENTIALS']) delete env[key];
  const child = spawn(process.execPath, ['--import', path.join(skill, 'tests/fixtures/credential-http.mjs'), path.join(skill, 'scripts', script), ...args], { env, cwd: home });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const kill = setTimeout(() => child.kill(), 5000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { status, stdout, stderr, reads: browser.reads.length, details: browser.reads, cache: (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) };
  } finally {
    clearTimeout(kill);
    await browser.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
function jsonReply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

test('Paoding CLI succeeds anonymously without starting browser retrieval', async () => {
  const r = await runBusiness('test_log_query.js', ['iot', '--format', 'json'], (req, res) => {
    assert.equal(req.headers.cookie || '', '');
    jsonReply(res, 200, { results: { A: { frames: [] } } });
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 0);
});
test('Cloud MySQL CLI obtains and saves missing token without leaking its value', async () => {
  const value = 'cloud-test-value';
  const r = await runBusiness('cloud_mysql_query.js', ['recorder', 'SELECT 1', '--json'], (req, res) => {
    assert.equal(req.headers.cookie, `cloud_console_token_egg=${value};`);
    jsonReply(res, 200, { code: 200000, data: [] });
  }, [{ ...cookie, name: 'cloud_console_token_egg', value, domain: 'cloud.intra.ke.com' }]);
  assert.equal(r.reads, 1, r.stderr);
  assert.equal(r.cache('cloud_token.json').cloud_console_token_egg, value);
  assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value));
});
test('Dinsight whoami fetches cookies for the actual authentication API path', async () => {
  const r = await runBusiness('dinsight_query.js', ['--whoami'], (req, res) => {
    assert.equal(req.url, '/api/v1/auth/me');
    jsonReply(res, 200, { ucid: 'test-user' });
  }, (details) => {
    assert.equal(details.url, 'https://api-dinsight.ke.com/api/v1/auth/me');
    return [{ ...cookie, name: 'prd-assistant-token-prod', domain: 'api-dinsight.ke.com' }];
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 1);
  assert.match(r.stdout, /test-user/);
});
test('Apollo dry run refreshes expired login via test-login redirect once', async () => {
  let calls = 0;
  const r = await runBusiness('apollo_modify.js', ['iot', 'application', 'key', 'new'], (req, res) => {
    calls++;
    if (req.headers.cookie === 'jt_apollo_login_token=expired') {
      res.writeHead(302, { Location: 'https://test-login.ke.com/login' });
      res.end();
    } else jsonReply(res, 200, [{ key: 'key', value: 'old' }]);
  }, [{ ...cookie, name: 'jt_apollo_login_token', value: 'fresh', domain: 'test-apollo.portal.life.ke.com', secure: false }], { 'test_apollo_cookie.json': { cookie: 'jt_apollo_login_token=expired' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 1);
  assert.equal(calls, 2);
  assert.match(r.stdout, /old/);
});
test('FeCI search receives its own Cookie and never the cloud Cookie', async () => {
  const r = await runBusiness('feci_deploy.js', ['--search', 'demo'], (req, res) => {
    assert.equal(req.headers['x-test-target'], 'feci-next.ke.com');
    assert.equal(req.headers.cookie, 'sid=feci-fresh');
    jsonReply(res, 200, { code: 0, data: [] });
  }, [{ ...cookie, value: 'feci-fresh', domain: 'feci-next.ke.com' }], { 'cloud_token.json': { cookie: 'sid=cloud-only' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 1);
  assert.equal(r.cache('feci_cookie.json').cookie, 'sid=feci-fresh');
});
test('Shipwright discovery obtains a separate cookie rather than reusing cloud cache', async () => {
  const hosts = [];
  const r = await runBusiness('ci_deploy.js', ['unknown-relay-service', '--dry-run'], (req, res) => {
    const host = req.headers['x-test-target'];
    hosts.push(host);
    if (host === 'shipwright.ke.com') {
      assert.equal(req.headers.cookie, 'sid=ship-only');
      jsonReply(res, 200, { list: [] });
    } else {
      assert.equal(req.headers.cookie, 'sid=cloud-only');
      jsonReply(res, 200, { data: [] });
    }
  }, [{ ...cookie, value: 'ship-only', domain: 'shipwright.ke.com' }], { 'cloud_token.json': { cookie: 'sid=cloud-only' } });
  assert.equal(r.reads, 1, r.stderr);
  assert.ok(hosts.includes('shipwright.ke.com'));
  assert.ok(hosts.includes('cloud.intra.ke.com'));
  assert.equal(r.cache('shipwright_cookie.json').cookie, 'sid=ship-only');
});
test('FeCI business code 4000 refreshes expired cached cookie', async () => {
  let attempts = 0;
  const r = await runBusiness('feci_deploy.js', ['--search', 'demo'], (req, res) => {
    attempts++;
    jsonReply(res, 200, req.headers.cookie === 'sid=expired' ? { code: 4000, message: 'not logged in' } : { code: 0, data: [] });
  }, [{ ...cookie, value: 'fresh', domain: 'feci-next.ke.com' }], { 'feci_cookie.json': { cookie: 'sid=expired' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 1);
  assert.equal(attempts, 2);
});
test('Paoding auth failure reuses manual cache before asking browser', async () => {
  let calls = 0;
  const r = await runBusiness('test_log_query.js', ['iot', '--format', 'json'], (req, res) => {
    calls++;
    if (!req.headers.cookie) jsonReply(res, 401, { message: 'login' });
    else {
      assert.equal(req.headers.cookie, 'sid=manual');
      jsonReply(res, 200, { results: { A: { frames: [] } } });
    }
  }, [], { 'paoding_cookie.json': { cookie: 'sid=manual' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 0);
  assert.equal(calls, 2);
});
test('Cloud catalog discovery obtains missing token before resolving database names', async () => {
  const r = await runBusiness('cloud_mysql_query.js', ['--list-dbs'], (req, res) => {
    assert.match(req.headers.cookie, /cloud_console_token_egg=/);
    jsonReply(res, 200, { code: 200000, data: req.url.includes('query_port') ? ['9999'] : ['relay_demo_database'] });
  }, [{ ...cookie, name: 'cloud_console_token_egg', domain: 'cloud.intra.ke.com' }]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 1);
  assert.match(r.stdout, /relay_demo_database/);
});
test('Cloud MySQL prefers verified cache over old exported Cookie files', async () => {
  const r = await runBusiness('cloud_mysql_query.js', ['--list-dbs'], (req, res) => {
    assert.equal(req.headers.cookie, 'cloud_console_token_egg=verified;');
    jsonReply(res, 200, { code: 200000, data: req.url.includes('query_port') ? ['9999'] : ['verified_database'] });
  }, [], {
    'cloud_token.json': { cloud_console_token_egg: 'verified' },
    'cookies.txt': 'cloud.intra.ke.com\tFALSE\t/\tTRUE\t0\tcloud_console_token_egg\tstale',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.reads, 0);
  assert.equal(r.cache('cloud_token.json').cloud_console_token_egg, 'verified');
});
test('CI deploy preflight gets credentials, then sends a rejected write only once', async () => {
  let writes = 0;
  let reads = 0;
  const r = await runBusiness('ci_deploy.js', ['smart-customer-service', '--deploy-only', '--image', 'test/image:relay'], (req, res) => {
    assert.equal(req.headers.cookie, 'sid=cloud-fresh');
    if (req.method === 'GET') {
      reads++;
      jsonReply(res, 200, { code: 200000, data: { spec: { containers: [{ image: 'test/image:old' }] } } });
    } else {
      writes++;
      jsonReply(res, 401, { code: 401 });
    }
  }, [{ ...cookie, value: 'cloud-fresh', domain: 'cloud.intra.ke.com' }]);
  assert.equal(r.status, 1);
  assert.equal(r.reads, 1);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(r.cache('cloud_token.json').cookie, 'sid=cloud-fresh');
});
