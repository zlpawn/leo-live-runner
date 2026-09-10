import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Kafka, logLevel } from 'kafkajs';
import { SHRIMP_LIVE_DIR, ensureShrimpLiveDir } from './credentials.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_KAFKA_FILE = path.join(__dirname, '..', '..', 'resources', 'default_kafka.json');
export const LOCAL_KAFKA_FILE = path.join(SHRIMP_LIVE_DIR, 'kafka_catalog.json');

let cachedKafkaCatalog = null;

/**
 * 加载全量 Kafka 主题与 Broker 目录 (合并 Skill 内置与本地 ~/.shrimp 动态目录)
 */
export function loadKafkaCatalog(forceReload = false) {
  if (cachedKafkaCatalog && !forceReload) {
    return cachedKafkaCatalog;
  }

  const catalog = {};

  // 1. 读取内置预置 default_kafka.json
  if (fs.existsSync(DEFAULT_KAFKA_FILE)) {
    try {
      const defaultData = JSON.parse(fs.readFileSync(DEFAULT_KAFKA_FILE, 'utf8'));
      Object.assign(catalog, defaultData);
    } catch (err) {
      // ignore
    }
  }

  // 2. 叠加覆盖本地自学习目录 ~/.shrimp/skills/live-inspector/kafka_catalog.json
  if (fs.existsSync(LOCAL_KAFKA_FILE)) {
    try {
      const localData = JSON.parse(fs.readFileSync(LOCAL_KAFKA_FILE, 'utf8'));
      // 深合并各个 Topic 项
      for (const [k, v] of Object.entries(localData)) {
        if (catalog[k] && typeof catalog[k] === 'object') {
          catalog[k] = { ...catalog[k], ...v };
        } else {
          catalog[k] = v;
        }
      }
    } catch (err) {
      // ignore
    }
  }

  cachedKafkaCatalog = catalog;
  return catalog;
}

/**
 * 将 Topic 沉淀保存到本地 ~/.shrimp/skills/live-inspector/kafka_catalog.json
 */
export function saveTopicToLocal(topicKey, topicData) {
  ensureShrimpLiveDir();
  let localCatalog = {};
  if (fs.existsSync(LOCAL_KAFKA_FILE)) {
    try {
      localCatalog = JSON.parse(fs.readFileSync(LOCAL_KAFKA_FILE, 'utf8'));
    } catch {
      localCatalog = {};
    }
  }

  localCatalog[topicKey] = {
    ...(localCatalog[topicKey] || {}),
    ...topicData,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(LOCAL_KAFKA_FILE, JSON.stringify(localCatalog, null, 2), 'utf8');
  loadKafkaCatalog(true); // 刷新缓存
  return localCatalog[topicKey];
}

/**
 * 智能解析目标 Topic 及对应环境的 Broker 地址
 * @param {string} query 主题名、别名或中文模糊词
 * @param {string} env 环境 ('test' | 'prod')
 * @returns {object|null} { topicKey, targetTopic, broker, desc, sample, raw }
 */
export function resolveTopic(query, env = 'prod') {
  if (!query || typeof query !== 'string') return null;
  const q = query.trim();
  const lowerQ = q.toLowerCase();
  const isTest = ['test', 'qa', 'dev'].includes(env.toLowerCase());
  const catalog = loadKafkaCatalog();

  // 1. 精确匹配 Key
  if (catalog[q]) {
    return formatResolvedItem(q, catalog[q], isTest);
  }
  if (catalog[lowerQ]) {
    return formatResolvedItem(lowerQ, catalog[lowerQ], isTest);
  }

  // 2. 匹配具体环境下的实际 topic 名称
  for (const [key, item] of Object.entries(catalog)) {
    const testTopic = typeof item.test === 'object' ? item.test.topic : (item.testTopic || key);
    const prodTopic = typeof item.prod === 'object' ? item.prod.topic : (item.prodTopic || key);
    if (testTopic === q || prodTopic === q || key === q) {
      return formatResolvedItem(key, item, isTest);
    }
  }

  // 3. 匹配别名列表 aliases
  for (const [key, item] of Object.entries(catalog)) {
    if (Array.isArray(item.aliases)) {
      if (item.aliases.some(a => a.toLowerCase() === lowerQ || a === q)) {
        return formatResolvedItem(key, item, isTest);
      }
    }
  }

  // 4. 中文描述或关键词模糊匹配
  for (const [key, item] of Object.entries(catalog)) {
    if (item.desc && (item.desc.includes(q) || q.includes(item.desc))) {
      return formatResolvedItem(key, item, isTest);
    }
    if (key.toLowerCase().includes(lowerQ)) {
      return formatResolvedItem(key, item, isTest);
    }
  }

  return null;
}

function formatResolvedItem(key, item, isTest) {
  let targetTopic = key;
  let broker = '';

  if (isTest) {
    if (typeof item.test === 'object' && item.test) {
      broker = item.test.broker || '';
      targetTopic = item.test.topic || key;
    } else if (typeof item.test === 'string') {
      broker = item.test;
      targetTopic = item.testTopic || key;
    }
  } else {
    // 线上 prod
    if (typeof item.prod === 'object' && item.prod) {
      broker = item.prod.broker || '';
      targetTopic = item.prod.topic || key;
    } else if (typeof item.prod === 'string') {
      broker = item.prod;
      targetTopic = item.prodTopic || key;
    }
  }

  // 兜底 broker
  if (!broker && item.broker) {
    broker = typeof item.broker === 'object' ? (isTest ? item.broker.test : item.broker.prod) : item.broker;
  }

  return {
    topicKey: key,
    targetTopic,
    broker: cleanBrokers(broker),
    desc: item.desc || '',
    app: item.app || '',
    sample: item.sample || null,
    raw: item
  };
}

/**
 * 格式化 broker 字符串为数组
 */
export function cleanBrokers(brokerStr) {
  if (!brokerStr) return [];
  if (Array.isArray(brokerStr)) return brokerStr.map(s => s.trim()).filter(Boolean);
  return brokerStr.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * 组合 Topic 高水位与消费组 committed offset，计算真实分区级 Lag。
 * Kafka 未启动消费的分区 committed offset 为 -1，此时用保留窗口起点估算待消费量。
 */
export function buildConsumerLagRows({ partitionOffsets = [], committedOffsets = [] }) {
  const committedByPartition = new Map();
  for (const item of committedOffsets) {
    committedByPartition.set(Number(item.partition), Number(item.offset));
  }

  return [...partitionOffsets]
    .sort((a, b) => Number(a.partition) - Number(b.partition))
    .map(item => {
      const partition = Number(item.partition);
      const low = Number(item.low);
      const high = Number(item.high);
      const rawCommitted = committedByPartition.get(partition);
      const hasCommitted = Number.isFinite(rawCommitted) && rawCommitted >= 0;
      const committed = hasCommitted ? rawCommitted : null;
      const lag = hasCommitted
        ? Math.max(0, high - committed)
        : Math.max(0, high - low);

      return { partition, low, high, committed, lag, pendingStart: !hasCommitted };
    });
}

/**
 * 基于两次快照差分计算生产速率、消费速率、积压变化与预计追平时间。
 */
export function buildConsumerRateReport({ first, second }) {
  const sampleSeconds = Math.max(0.001, (second.at - first.at) / 1000);
  const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const produced = sum(second.rows, 'high') - sum(first.rows, 'high');
  const consumed = sum(second.rows, 'committed') - sum(first.rows, 'committed');
  const lagDelta = sum(second.rows, 'lag') - sum(first.rows, 'lag');
  const firstRows = new Map(first.rows.map(row => [row.partition, row]));
  const catchUpRatePerSecond = lagDelta < 0 ? -lagDelta / sampleSeconds : 0;
  const currentLag = sum(second.rows, 'lag');

  return {
    sampleSeconds,
    produced,
    consumed,
    lagDelta,
    produceRatePerSecond: produced / sampleSeconds,
    consumeRatePerSecond: consumed / sampleSeconds,
    catchUpRatePerSecond,
    catchUpEtaSeconds: catchUpRatePerSecond > 0 && currentLag > 0
      ? currentLag / catchUpRatePerSecond
      : (currentLag === 0 ? 0 : null),
    partitions: second.rows.map(secondRow => {
      const firstRow = firstRows.get(secondRow.partition) || { high: 0, committed: 0, lag: 0 };
      return {
        partition: secondRow.partition,
        produced: secondRow.high - firstRow.high,
        consumed: secondRow.committed - firstRow.committed,
        lagDelta: secondRow.lag - firstRow.lag
      };
    })
  };
}

/**
 * 创建通用安全 Kafka 客户端实例
 */
export function createKafkaClient({ brokers, clientId = 'leo-live-inspector' }) {
  const brokerList = cleanBrokers(brokers);
  if (brokerList.length === 0) {
    throw new Error('Kafka Broker 地址为空，请检查配置或手动传入 -b <broker:port>');
  }

  return new Kafka({
    clientId,
    brokers: brokerList,
    connectionTimeout: 5000,
    requestTimeout: 10000,
    logLevel: logLevel.NOTHING,
  });
}
