import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { requestHttp } from './http.js';
import { resolveAppId, APOLLO_SERVERS } from './services.js';
import { locateLocalRepository, extractSearchConfigFromLocalRepo } from './local_repo_scanner.js';
import { classifyEnvironment } from './env_detector.js';

const ES_CACHE_FILE = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector', 'es_services_cache.json');

/**
 * 读取本地 ES 缓存
 */
export function loadEsCache() {
  try {
    if (fs.existsSync(ES_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(ES_CACHE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

/**
 * 写入本地 ES 缓存
 */
export function saveEsCache(cache) {
  try {
    const dir = path.dirname(ES_CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ES_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {}
}

/**
 * 通过 Apollo ConfigService 探查微服务的搜索配置 (Tier 1: 零配置秒级探查)
 * @param {string} appId 微服务名
 * @param {'prod'|'test'} env 环境
 */
export async function fetchSearchConfigFromApollo(appId, env = 'prod') {
  const apolloBase = APOLLO_SERVERS[env] || APOLLO_SERVERS.prod;
  const apolloUrl = `${apolloBase}/configfiles/json/${encodeURIComponent(appId)}/default/application`;

  const res = await requestHttp({
    protocol: new URL(apolloUrl).protocol,
    hostname: new URL(apolloUrl).hostname,
    port: new URL(apolloUrl).port || 80,
    path: new URL(apolloUrl).pathname + new URL(apolloUrl).search,
    method: 'GET',
    timeout: 5000
  });

  if (res.statusCode !== 200 || !res.json) {
    return null;
  }

  const configs = res.json;
  const result = {
    source: `Apollo (${apolloBase})`,
    domain: '',
    writeDomain: '',
    services: {}
  };

  // 1. 尝试解析 searchPlatProperties
  if (configs.searchPlatProperties) {
    try {
      const searchPlat = typeof configs.searchPlatProperties === 'string'
        ? JSON.parse(configs.searchPlatProperties)
        : configs.searchPlatProperties;

      if (searchPlat.global?.domain) {
        result.domain = searchPlat.global.domain;
      }
      if (searchPlat.global?.writeDomain) {
        result.writeDomain = searchPlat.global.writeDomain;
      }

      if (searchPlat.serviceConfig) {
        for (const [key, cfg] of Object.entries(searchPlat.serviceConfig)) {
          const serviceId = cfg.serviceId || key;
          const entry = {
            bizKey: key,
            serviceId: String(serviceId),
            token: cfg.token || '',
            writeToken: cfg.writeToken || '',
            domain: cfg.domain || result.domain,
            suffix: cfg.suffix || ''
          };
          result.services[key] = entry;
          result.services[String(serviceId)] = entry;
        }
      }
    } catch {}
  }

  // 2. 尝试从扁平 key 中提取 search.domain / search.token 等
  for (const [key, val] of Object.entries(configs)) {
    if (key === 'search.domain' && !result.domain) {
      result.domain = String(val).trim();
    } else if (key === 'search.write-domain' && !result.writeDomain) {
      result.writeDomain = String(val).trim();
    } else if (key.startsWith('search.token.')) {
      const serviceId = key.replace('search.token.', '').trim();
      if (!result.services[serviceId]) {
        result.services[serviceId] = { serviceId, token: String(val).trim() };
      } else {
        result.services[serviceId].token = String(val).trim();
      }
    } else if (key.startsWith('search.write-token.')) {
      const serviceId = key.replace('search.write-token.', '').trim();
      if (!result.services[serviceId]) {
        result.services[serviceId] = { serviceId, writeToken: String(val).trim() };
      } else {
        result.services[serviceId].writeToken = String(val).trim();
      }
    }
  }

  // 默认写域名推导保底
  if (!result.writeDomain && result.domain) {
    if (result.domain.includes('-gw.')) {
      result.writeDomain = result.domain.replace('-gw.', '-stream.');
    } else if (result.domain.includes('search-zuul.')) {
      result.writeDomain = result.domain.replace('search-zuul.', 'search-zuul-write.');
    }
  }

  if (result.domain || Object.keys(result.services).length > 0) {
    return result;
  }

  return null;
}

/**
 * 统一解析并返回某个微服务的 ES 搜索配置
 * 顺序：Apollo 远程嗅探 -> 本地多目录代码扫描 -> 本地缓存
 * @param {string} rawAppId 应用名或别名
 * @param {'prod'|'test'} env 环境
 */
export async function resolveEsConfig(rawAppId, env = 'prod') {
  const appId = resolveAppId(rawAppId) || rawAppId;
  const cacheKey = `${appId}:${env}`;
  const cache = loadEsCache();

  // 1. Tier 1: 直连 Apollo 配置中心
  try {
    const apolloConfig = await fetchSearchConfigFromApollo(appId, env);
    if (apolloConfig && (apolloConfig.domain || Object.keys(apolloConfig.services).length > 0)) {
      cache[cacheKey] = {
        appId,
        env,
        updatedAt: Date.now(),
        ...apolloConfig
      };
      saveEsCache(cache);
      return cache[cacheKey];
    }
  } catch {}

  // 2. Tier 2: 本地多工程仓库目录自动嗅探
  try {
    const repoDir = locateLocalRepository(appId);
    if (repoDir) {
      const localConfig = extractSearchConfigFromLocalRepo(repoDir, env);
      if (localConfig && (localConfig.domain || Object.keys(localConfig.services).length > 0)) {
        cache[cacheKey] = {
          appId,
          env,
          source: `Local Repo (${path.basename(repoDir)})`,
          updatedAt: Date.now(),
          ...localConfig
        };
        saveEsCache(cache);
        return cache[cacheKey];
      }
    }
  } catch {}

  // 3. Tier 3: 命中本地历史缓存
  if (cache[cacheKey]) {
    return cache[cacheKey];
  }

  return null;
}

/**
 * 定位特定的 ES 服务信息（按 serviceId 或 业务名 如 lock、water-meter 查找）
 * @param {string} appId 应用名
 * @param {string} serviceKeyOrId 业务关键词或数字 serviceId
 * @param {'prod'|'test'} env 环境
 */
export async function resolveEsTarget(appId, serviceKeyOrId, env = 'prod') {
  const config = await resolveEsConfig(appId, env);
  if (!config) {
    throw new Error(`未找到微服务 [${appId}] 在 [${env}] 环境下的 ES 搜索配置！请检查微服务名或本地工程。`);
  }

  let serviceEntry = null;

  if (serviceKeyOrId) {
    const searchKey = String(serviceKeyOrId).trim().toLowerCase();
    // 精确查找
    if (config.services[searchKey]) {
      serviceEntry = config.services[searchKey];
    } else {
      // 模糊匹配
      for (const [k, v] of Object.entries(config.services)) {
        if (k.toLowerCase().includes(searchKey) || (v.bizKey && v.bizKey.toLowerCase().includes(searchKey))) {
          serviceEntry = v;
          break;
        }
      }
    }
  } else {
    // 未指定时，如果只有一个服务就默认选用；否则列出供选择
    const keys = Object.keys(config.services).filter(k => isNaN(Number(k)));
    if (keys.length === 1) {
      serviceEntry = config.services[keys[0]];
    }
  }

  if (!serviceEntry) {
    const available = Object.keys(config.services)
      .map(k => `${k} (id: ${config.services[k].serviceId})`)
      .join(', ');
    throw new Error(`微服务 [${appId}] 下未匹配到指定 ES 服务 [${serviceKeyOrId}]！可用服务列表: ${available || '无'}`);
  }

  const domain = serviceEntry.domain || config.domain;
  const writeDomain = config.writeDomain || (domain.includes('-gw.') ? domain.replace('-gw.', '-stream.') : domain);
  const suffix = serviceEntry.suffix || '';
  const searchUrl = `${domain.replace(/\/+$/, '')}/api/${serviceEntry.serviceId}${suffix}/search`;
  const writeUrl = `${writeDomain.replace(/\/+$/, '')}/api/data/${serviceEntry.serviceId}`;

  // 严格根据最终 URL 重新计算真实环境归属
  const detectedEnv = classifyEnvironment(domain);

  return {
    appId: config.appId,
    env: detectedEnv,
    serviceId: serviceEntry.serviceId,
    bizKey: serviceEntry.bizKey || serviceKeyOrId,
    token: serviceEntry.token,
    writeToken: serviceEntry.writeToken || serviceEntry.token,
    domain,
    writeDomain,
    searchUrl,
    writeUrl,
    source: config.source
  };
}
