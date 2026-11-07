import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SCRIPT = fileURLToPath(new URL('../scripts/fast_query.js', import.meta.url));

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Polls the port like the real extension, surviving the bridge coming and going. */
function pollLikeExtension(port, handle) {
  const seen = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const { cmd } = await (await fetch(`http://127.0.0.1:${port}/ext/poll?waitMs=100`)).json();
        if (!cmd) continue;
        seen.push(cmd);
        await fetch(`http://127.0.0.1:${port}/ext/result`, {
          method: 'POST',
          body: JSON.stringify({ id: cmd.id, ok: true, result: handle(cmd) }),
        });
      } catch {
        await pause(50);
      }
    }
  })();
  return { seen, stop: async () => { running = false; await loop; } };
}

test('the index probe starts a stopped bridge, runs in its own window and learns the index', async () => {
  const port = await closedPort();
  const es = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rawResponse: { hits: { total: 0, hits: [] } } }));
  });
  await new Promise((resolve) => es.listen(0, '127.0.0.1', resolve));
  const cluster = `http://127.0.0.1:${es.address().port}`;
  const extension = pollLikeExtension(port, (cmd) =>
    cmd.type === 'page.eval' ? { evalResult: { cluster, index: 'probe-index' } } : {}
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-fast-probe-'));
  try {
    const child = spawn(process.execPath, [SCRIPT, '-a', 'probe-test-svc', '-n', '1'], {
      cwd: home,
      env: { ...process.env, HOME: home, LEO_LANTERN_PORT: String(port), LEO_LANTERN_IDLE_EXIT_MIN: '0.1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const status = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(status, 0, output);
    const start = extension.seen.find((cmd) => cmd.type === 'task.start');
    assert.ok(start, 'the probe should reach the extension');
    assert.equal(start.params.sameWindow, false);
    const background = fs.readFileSync(new URL('../resources/chrome_extension/background.js', import.meta.url), 'utf8');
    const supported = new Set([...background.matchAll(/type === "([a-z.]+)"/g)].map((match) => match[1]));
    for (const cmd of extension.seen) assert.ok(supported.has(cmd.type), `the extension does not support ${cmd.type}`);
    const types = extension.seen.map((cmd) => cmd.type);
    assert.ok(types.includes('tabs.close'), 'the probe should close its tab, since task.end leaves it open');
    assert.ok(types.indexOf('tabs.close') < types.indexOf('task.end'), 'tabs.close needs the task to still be active');
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.shrimp/skills/live-runner/service_map.json'), 'utf8'));
    assert.deepEqual(saved['probe-test-svc'], { index: 'probe-index*', cluster });
  } finally {
    await extension.stop();
    es.closeAllConnections();
    await new Promise((resolve) => es.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
