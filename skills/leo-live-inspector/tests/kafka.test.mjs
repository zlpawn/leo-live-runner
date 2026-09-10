import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadKafkaCatalog,
  resolveTopic,
  cleanBrokers,
  buildConsumerLagRows,
  buildConsumerRateReport
} from '../scripts/common/kafka.js';

test('loadKafkaCatalog should load default kafka assets', () => {
  const catalog = loadKafkaCatalog(true);
  assert.ok(Object.keys(catalog).length > 0, 'Catalog should contain preset topics');
  assert.ok(catalog['beijia-reach-event'], 'Should contain beijia-reach-event');
});

test('resolveTopic should resolve topic by exact name', () => {
  const resolved = resolveTopic('beijia-reach-event', 'prod');
  assert.ok(resolved, 'Should resolve beijia-reach-event');
  assert.equal(resolved.targetTopic, 'beijia-reach-event');
  assert.ok(resolved.broker.length > 0, 'Should have broker list');
});

test('resolveTopic should resolve topic by alias or fuzzy keyword', () => {
  const resolved = resolveTopic('触达', 'prod');
  assert.ok(resolved, 'Should resolve by alias 触达');
  assert.equal(resolved.topicKey, 'beijia-reach-event');
});

test('cleanBrokers should parse comma-separated string', () => {
  const brokers = cleanBrokers('10.0.0.1:9092, 10.0.0.2:9092');
  assert.deepEqual(brokers, ['10.0.0.1:9092', '10.0.0.2:9092']);
});

test('buildConsumerLagRows should calculate committed consumer lag by partition', () => {
  const rows = buildConsumerLagRows({
    partitionOffsets: [
      { partition: 0, low: '10', high: '110' },
      { partition: 1, low: '0', high: '200' },
      { partition: 2, low: '0', high: '50' }
    ],
    committedOffsets: [
      { partition: 0, offset: '100' },
      { partition: 1, offset: '180' },
      { partition: 2, offset: '-1' }
    ]
  });

  assert.deepEqual(rows, [
    { partition: 0, low: 10, high: 110, committed: 100, lag: 10, pendingStart: false },
    { partition: 1, low: 0, high: 200, committed: 180, lag: 20, pendingStart: false },
    { partition: 2, low: 0, high: 50, committed: null, lag: 50, pendingStart: true }
  ]);
});

test('buildConsumerLagRows should clamp invalid committed offsets defensively', () => {
  const rows = buildConsumerLagRows({
    partitionOffsets: [{ partition: 0, low: '10', high: '110' }],
    committedOffsets: [{ partition: 0, offset: '999' }]
  });

  assert.deepEqual(rows, [
    { partition: 0, low: 10, high: 110, committed: 999, lag: 0, pendingStart: false }
  ]);
});

test('buildConsumerRateReport should calculate produce and consume rates from snapshots', () => {
  const report = buildConsumerRateReport({
    first: {
      at: 1000,
      rows: [
        { partition: 0, high: 1000, committed: 900, lag: 100 },
        { partition: 1, high: 2000, committed: 1800, lag: 200 }
      ]
    },
    second: {
      at: 21000,
      rows: [
        { partition: 0, high: 1500, committed: 1450, lag: 50 },
        { partition: 1, high: 3100, committed: 2900, lag: 200 }
      ]
    }
  });

  assert.equal(report.sampleSeconds, 20);
  assert.equal(report.produced, 1600);
  assert.equal(report.consumed, 1650);
  assert.equal(report.lagDelta, -50);
  assert.equal(report.produceRatePerSecond, 80);
  assert.equal(report.consumeRatePerSecond, 82.5);
  assert.equal(report.catchUpEtaSeconds, 100);
  assert.deepEqual(report.partitions, [
    { partition: 0, produced: 500, consumed: 550, lagDelta: -50 },
    { partition: 1, produced: 1100, consumed: 1100, lagDelta: 0 }
  ]);
});

test('buildConsumerRateReport should return null ETA when backlog is not shrinking', () => {
  const report = buildConsumerRateReport({
    first: { at: 0, rows: [{ partition: 0, high: 100, committed: 90, lag: 10 }] },
    second: { at: 10000, rows: [{ partition: 0, high: 200, committed: 180, lag: 20 }] }
  });

  assert.equal(report.lagDelta, 10);
  assert.equal(report.catchUpEtaSeconds, null);
});
