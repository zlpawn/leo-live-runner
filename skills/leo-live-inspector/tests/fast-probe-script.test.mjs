import test from 'node:test';
import assert from 'node:assert/strict';
import { findLogOption, probePageScript } from '../scripts/common/fast_probe.js';

const OPTIONS = [
  { label: 'beijia-basic-core生产环境', value: 8481, children: [{ label: '全部日志', value: 'index-8481-7703' }] },
  { label: 'zulin-iot-platform测试环境', value: 9001, children: [{ label: 'iot-platform日志', value: 'index-9001-1' }] },
  { label: 'zulin-iot-platform', value: 8172, children: [{ label: 'iot-platform日志', value: 'index-8172-7302' }] },
  { label: 'zulin-iot-platform-api', value: 8173, children: [{ label: '日志', value: 'index-8173-1' }] },
  { label: 'multi', value: 1, children: [{ label: '网关日志', value: 'index-1-1' }, { label: '全部日志', value: 'index-1-2' }] },
];
const kibanaUrl = (index) => `//fast105-kibana.example.com/app/kibana#/discover?_a=(index:'${index}*')`;

/** A stand-in for the FAST page, which only fills `url` when version is not already 7. */
function fakePage({ options = OPTIONS, respond = (index) => kibanaUrl(index) } = {}) {
  const page = {
    version: 7,
    option: [8481, 'index-8481-7703'],
    url: kibanaUrl('index-8481-7703'),
    getKibanaUrl() {
      if (this.version !== 7) {
        const url = respond(this.option[1]);
        if (url) this.url = url;
      }
      this.version = 7;
    },
  };
  const picker = { options, $parent: { $parent: page } };
  return { page, document: { querySelector: () => ({ __vue__: picker }) } };
}

function run(app, document) {
  const script = probePageScript(app, { settleMs: 60, pollMs: 5 });
  return new Function('document', `return ${script}`)(document);
}

test('finds the production service by its exact name, not a test environment or a similar name', () => {
  assert.deepEqual(findLogOption(OPTIONS, 'zulin-iot-platform'), [8172, 'index-8172-7302']);
  assert.deepEqual(findLogOption(OPTIONS, 'beijia-basic-core'), [8481, 'index-8481-7703']);
  assert.equal(findLogOption(OPTIONS, 'zulin-iot'), null);
  assert.equal(findLogOption([OPTIONS[1]], 'zulin-iot-platform'), null);
});

test('prefers the all-logs entry when a service has several', () => {
  assert.deepEqual(findLogOption(OPTIONS, 'multi'), [1, 'index-1-2']);
});

test('reads the cluster from the log URL the page fetches for that service', async () => {
  const { page, document } = fakePage();
  assert.deepEqual(await run('zulin-iot-platform', document), {
    cluster: 'https://fast105-kibana.example.com',
    index: 'index-8172-7302',
  });
  assert.deepEqual(page.option, [8172, 'index-8172-7302']);
});

test('an unknown service learns nothing and leaves the page alone', async () => {
  const { page, document } = fakePage();
  assert.deepEqual(await run('no-such-service', document), { cluster: null, index: null });
  assert.deepEqual(page.option, [8481, 'index-8481-7703']);
});

test('learns nothing when the page never returns a URL for the service', async () => {
  const { document } = fakePage({ respond: () => null });
  assert.deepEqual(await run('zulin-iot-platform', document), { cluster: null, index: null });
});

test('learns nothing when the page is not what the probe expects', async () => {
  const document = { querySelector: () => null };
  assert.deepEqual(await run('zulin-iot-platform', document), { cluster: null, index: null });
});
