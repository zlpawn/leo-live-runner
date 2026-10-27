import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { loadPassword, buildMissingPasswordHint } from './credentials.js';
import { Ledger } from './ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEMS_FILE = path.join(__dirname, '..', '..', 'resources', 'systems.json');

let cachedConfig = null;

export function loadSystemsConfig() {
  if (cachedConfig) return cachedConfig;
  cachedConfig = JSON.parse(fs.readFileSync(SYSTEMS_FILE, 'utf8'));
  return cachedConfig;
}

/**
 * 连接注册表：按逻辑系统名管理 MySQL / Redis / HTTP / Kafka
 */
export class SystemsRegistry {
  constructor() {
    this.config = loadSystemsConfig();
    this.pools = new Map();
  }

  getSystem(name) {
    const sys = this.config.systems?.[name];
    if (!sys) {
      throw new Error(`未注册的系统: ${name}。可用: ${Object.keys(this.config.systems || {}).join(', ')}`);
    }
    return sys;
  }

  getHttpService(name) {
    const svc = this.config.httpServices?.[name];
    if (!svc) {
      throw new Error(`未注册的 HTTP 服务: ${name}`);
    }
    return svc;
  }

  getKafka(alias = 'test') {
    const k = this.config.kafka?.[alias];
    if (!k) throw new Error(`未注册的 Kafka 集群: ${alias}`);
    return k;
  }

  /**
   * 获取 MySQL 连接池（懒加载 + 复用）
   */
  async getPool(systemName, datasource = 'default') {
    const key = `${systemName}:${datasource}`;
    if (this.pools.has(key)) return this.pools.get(key);

    const sys = this.getSystem(systemName);
    if (sys.type !== 'mysql') {
      throw new Error(`系统 ${systemName} 不是 MySQL 类型`);
    }
    const ds = sys.datasources?.[datasource];
    if (!ds) {
      throw new Error(`系统 ${systemName} 没有数据源 ${datasource}`);
    }
    const password = loadPassword(systemName, this.config);
    if (!password) {
      throw new Error(buildMissingPasswordHint(systemName));
    }

    const pool = mysql.createPool({
      host: ds.host,
      port: ds.port,
      user: ds.user,
      password,
      database: ds.database,
      connectionLimit: 4,
      connectTimeout: 10000,
      timezone: 'Z'
    });
    this.pools.set(key, pool);
    return pool;
  }

  /**
   * 只读查询
   */
  async query(systemName, sql, params = [], datasource = 'default') {
    const pool = await this.getPool(systemName, datasource);
    const [rows] = await pool.execute(sql, params);
    return rows;
  }

  /**
   * 写操作（受 mode 约束）
   */
  async execute(systemName, sql, params = [], ctx, datasource = 'default') {
    if (ctx?.mode !== 'execute') {
      throw new Error(`只读模式禁止写操作。请以 execute 模式运行：${sql}`);
    }
    const pool = await this.getPool(systemName, datasource);
    const [result] = await pool.execute(sql, params);
    return result;
  }

  async closeAll() {
    for (const pool of this.pools.values()) {
      try { await pool.end(); } catch {}
    }
    this.pools.clear();
  }
}

export function createContext({ mode = 'readonly', logger = console } = {}) {
  return {
    mode,
    systems: new SystemsRegistry(),
    logger,
    ledger: new Ledger()
  };
}
