import fs from 'node:fs';
import path from 'node:path';
import { requestHttp } from './http.js';
import { classifyEnvironment } from './env_detector.js';
import { createCredentialSession, isLoginFailure } from './browser_credentials.js';
import {
  SHRIMP_LIVE_DIR,
  loadSearchCookie,
  saveSearchCookie
} from './credentials.js';

const DEFAULT_SEARCH_BASE_URL = 'https://search.ke.com';
const CATALOG_TTL_HOURS = 24;

export function getSearchBaseUrl() {
  return (process.env.LEO_SEARCH_BASE_URL || DEFAULT_SEARCH_BASE_URL).replace(/\/+$/, '');
}

export function getEsCatalogFile() {
  return path.join(SHRIMP_LIVE_DIR, 'es_catalog.json');
}

export function isSearchAuthFailure(res) {
  if (isLoginFailure(res)) return true;
  if (res?.statusCode === 200 && typeof res?.raw === 'string' && /<html|<!doctype/i.test(res.raw)) {
    if (/login\.ke\.com|passport|统一登录|扫码登录/i.test(res.raw)) return true;
  }
  return false;
}

export function isSearchApiSuccess(res) {
  if (!res || !Number.isFinite(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300 || res.error) {
    return false;
  }
  return Boolean(res.json && typeof res.json === 'object' && res.json.code === 0);
}

/**
 * 创建搜索云平台 (search.ke.com) 凭据会话
 */
export function createSearchSession({ explicitCookie = '' } = {}) {
  const initialCookie = explicitCookie || loadSearchCookie();
  return createCredentialSession({
    load: () => initialCookie,
    save: cookieStr => saveSearchCookie(cookieStr),
    explicit: Boolean(explicitCookie || process.env.SEARCH_COOKIE),
    isAuthFailure: isSearchAuthFailure,
    isSuccess: isSearchApiSuccess
  });
}

async function requestSearchApi(session, apiPath, { method = 'GET', body = null, timeout = 15000 } = {}) {
  const fullUrl = `${getSearchBaseUrl()}${apiPath}`;
  const parsed = new URL(fullUrl);
  return session.run(
    fullUrl,
    cookie => requestHttp({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        ...(cookie ? { 'Cookie': cookie } : {})
      },
      timeout
    }, body),
    { readOnly: true }
  );
}

function normalizeAppItem(item) {
  return {
    serviceId: String(item.serviceId),
    appSysCode: item.appSysCode ?? null,
    name: item.name || '',
    demandDesc: item.demandDesc || '',
    accessType: item.accessType || 'pull',
    engineType: item.engineType || 'es',
    status: item.status || '',
    dataDaySize: item.dataDaySize || '',
    dataTotalSize: item.dataTotalSize || '',
    roles: {
      pm: (item.role?.pm || []).map(u => `${u.userName}(${u.userCode})`),
      rd: (item.role?.rd || []).map(u => `${u.userName}(${u.userCode})`),
      qa: (item.role?.qa || []).map(u => `${u.userName}(${u.userCode})`)
    }
  };
}

/**
 * 从 search.ke.com 拉取当前工号已授权的全部 ES 索引目录
 */
export async function fetchEsCatalog(session, { auth = true, serviceId = '' } = {}) {
  const list = [];
  let page = 1;
  const size = 50;
  let total = Infinity;

  while (list.length < total) {
    const res = await requestSearchApi(session, '/ajax/createApp/getAppList', {
      method: 'POST',
      body: { page, size, auth, serviceId }
    });
    if (!res?.json || res.json.code !== 0 || !res.json.data) {
      throw new Error(`拉取搜索云平台索引目录失败: ${res?.json?.message || res?.error || `HTTP ${res?.statusCode}`}`);
    }
    const data = res.json.data;
    total = Number(data.total ?? 0);
    const batch = Array.isArray(data.appInfo) ? data.appInfo : [];
    if (batch.length === 0) break;
    for (const item of batch) {
      list.push(normalizeAppItem(item));
    }
    if (batch.length < size) break;
    page++;
  }

  if (auth && !serviceId && process.env.LEO_INSPECTOR_DISABLE_CACHE !== '1') {
    try {
      const catalogFile = getEsCatalogFile();
      fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
      fs.writeFileSync(catalogFile, JSON.stringify({
        updated_at: new Date().toISOString(),
        list
      }, null, 2), 'utf8');
    } catch {}
  }

  return list;
}

/**
 * 读取本地缓存或从云平台刷新索引目录
 */
export async function loadEsCatalog(session, { forceRefresh = false } = {}) {
  const catalogFile = getEsCatalogFile();
  if (!forceRefresh && fs.existsSync(catalogFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
      if (Array.isArray(cached.list) && cached.list.length > 0) {
        const ageHours = (Date.now() - new Date(cached.updated_at).getTime()) / (1000 * 3600);
        if (ageHours < CATALOG_TTL_HOURS) {
          return { list: cached.list, fromCache: true };
        }
      }
    } catch {}
  }
  const list = await fetchEsCatalog(session);
  return { list, fromCache: false };
}

/**
 * 按 serviceId、系统号、索引名称或描述关键词匹配目录项
 */
export function findCatalogMatches(catalog, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const lower = q.toLowerCase();

  const exactServiceId = catalog.filter(item => item.serviceId === q);
  if (exactServiceId.length > 0) return exactServiceId;

  const exactSysCode = catalog.filter(item => item.appSysCode !== null && String(item.appSysCode) === q);
  if (exactSysCode.length > 0) return exactSysCode;

  const exactName = catalog.filter(item => item.name.toLowerCase() === lower);
  if (exactName.length > 0) return exactName;

  const scored = [];
  for (const item of catalog) {
    const nameLower = item.name.toLowerCase();
    const descLower = item.demandDesc.toLowerCase();
    let score = 0;
    if (nameLower.startsWith(lower)) score = 3;
    else if (nameLower.includes(lower)) score = 2;
    else if (descLower.includes(lower) || item.serviceId.includes(q)) score = 1;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.item);
}

async function fetchBasicInfo(session, serviceId) {
  const res = await requestSearchApi(
    session,
    `/ajax/detailSearchQA/getBasicInfo?serviceId=${encodeURIComponent(serviceId)}`
  );
  if (res?.json?.code === 0 && res.json.data) {
    return res.json.data;
  }
  return null;
}

function pickActiveVersion(versionPayload) {
  const list = Array.isArray(versionPayload)
    ? versionPayload
    : (Array.isArray(versionPayload?.version) ? versionPayload.version : []);
  if (list.length === 0) return null;
  return list.find(v => v.status === 'on') || list[0];
}

async function resolveProdConfig(session, serviceId, accessType) {
  const verRes = await requestSearchApi(
    session,
    `/ajax/detailSearchQA/getVersionList?serviceId=${encodeURIComponent(serviceId)}`
  );
  if (!verRes?.json || verRes.json.code !== 0) {
    throw new Error(`获取线上版本列表失败 (serviceId=${serviceId}): ${verRes?.json?.message || verRes?.error || `HTTP ${verRes?.statusCode}`}`);
  }
  const active = pickActiveVersion(verRes.json.data);
  if (!active || active.version === undefined) {
    throw new Error(`索引 [${serviceId}] 暂无可用的线上配置版本`);
  }

  const cfgRes = await requestSearchApi(
    session,
    `/ajax/detailSearchQA/getConfig?accessType=${encodeURIComponent(accessType)}&version=${encodeURIComponent(active.version)}&serviceId=${encodeURIComponent(serviceId)}`,
    { timeout: 45000 }
  );
  if (!cfgRes?.json || cfgRes.json.code !== 0 || !cfgRes.json.data) {
    throw new Error(`获取线上索引详情失败 (serviceId=${serviceId}, v=${active.version}): ${cfgRes?.json?.message || cfgRes?.error || `HTTP ${cfgRes?.statusCode}`}`);
  }
  return {
    channel: 'detailSearchQA',
    version: active.version,
    config: cfgRes.json.data
  };
}

async function resolveTestConfig(session, serviceId, accessType, preferredRole = '') {
  const role = String(preferredRole || '').trim().toLowerCase();
  const channels = role === 'rd'
    ? ['detailBusinessRD', 'detailBusinessQA']
    : role === 'qa'
      ? ['detailBusinessQA', 'detailBusinessRD']
      : ['detailBusinessQA', 'detailBusinessRD'];

  const errors = [];
  for (const channel of channels) {
    const verRes = await requestSearchApi(
      session,
      `/ajax/${channel}/getVersionList?serviceId=${encodeURIComponent(serviceId)}`
    );
    if (!verRes?.json || verRes.json.code !== 0) {
      errors.push(`${channel}/getVersionList: ${verRes?.json?.message || verRes?.error || `HTTP ${verRes?.statusCode}`}`);
      continue;
    }
    const active = pickActiveVersion(verRes.json.data);
    if (!active || active.version === undefined) {
      errors.push(`${channel}: 无可用版本`);
      continue;
    }
    const cfgRes = await requestSearchApi(
      session,
      `/ajax/${channel}/getConfig?accessType=${encodeURIComponent(accessType)}&version=${encodeURIComponent(active.version)}&serviceId=${encodeURIComponent(serviceId)}`,
      { timeout: 45000 }
    );
    if (!cfgRes?.json || cfgRes.json.code !== 0 || !cfgRes.json.data?.search) {
      errors.push(`${channel}/getConfig(v${active.version}): ${cfgRes?.json?.message || cfgRes?.error || `HTTP ${cfgRes?.statusCode}`}`);
      continue;
    }
    return {
      channel,
      version: active.version,
      config: cfgRes.json.data
    };
  }

  throw new Error(`获取测试环境索引配置失败 (serviceId=${serviceId}): ${errors.join(' ; ')}`);
}

export function isEsDslUrl(searchUrl) {
  if (!searchUrl || typeof searchUrl !== 'string') return false;
  try {
    const pathname = new URL(searchUrl).pathname.replace(/\/+$/, '');
    return pathname.endsWith('/search/es');
  } catch {
    return /\/search\/es\/?$/i.test(searchUrl.trim());
  }
}

/**
 * 通过 search.ke.com 解析目标 ES 索引的网关、Token、Mapping 与上下文元数据
 */
export async function resolveEsTarget(targetKey, env = 'prod', options = {}) {
  const normalizedKey = String(targetKey || '').trim();
  if (!normalizedKey) {
    throw new Error('缺少索引标识参数！请传入 serviceId（如 1036710001）或索引名称关键词（如 订单、门锁）。');
  }

  const requestedEnv = String(env || 'prod').trim().toLowerCase() === 'test' ? 'test' : 'prod';
  const session = options.session || createSearchSession({ explicitCookie: options.cookie });

  let meta = null;
  let candidates = [];

  const { list: initialCatalog, fromCache } = await loadEsCatalog(session, { forceRefresh: Boolean(options.refresh) });
  candidates = findCatalogMatches(initialCatalog, normalizedKey);

  if (candidates.length === 0 && fromCache && !options.refresh) {
    const { list: refreshedCatalog } = await loadEsCatalog(session, { forceRefresh: true });
    candidates = findCatalogMatches(refreshedCatalog, normalizedKey);
  }

  if (candidates.length > 0) {
    meta = candidates[0];
  } else if (/^\d+$/.test(normalizedKey)) {
    const basic = await fetchBasicInfo(session, normalizedKey);
    if (basic) {
      meta = {
        serviceId: String(basic.serviceId || normalizedKey),
        appSysCode: null,
        name: basic.name || '',
        demandDesc: '',
        accessType: basic.accessType || 'pull',
        engineType: basic.engineType || 'es',
        status: ''
      };
    }
  }

  if (!meta) {
    throw new Error(`在 search.ke.com 未匹配到与 [${normalizedKey}] 相关的 ES 索引！可先执行 --list-indexes 查看当前工号已授权索引列表。`);
  }

  let accessType = meta.accessType || 'pull';
  if (!meta.accessType) {
    const basic = await fetchBasicInfo(session, meta.serviceId);
    if (basic?.accessType) accessType = basic.accessType;
  }

  const resolved = requestedEnv === 'test'
    ? await resolveTestConfig(session, meta.serviceId, accessType, options.role)
    : await resolveProdConfig(session, meta.serviceId, accessType);

  const cfg = resolved.config;
  const searchUrl = String(cfg.search || '').trim();
  if (!searchUrl) {
    throw new Error(`索引 [${meta.serviceId}] (${resolved.channel} v${resolved.version}) 未配置查询地址 (search)`);
  }

  const detectedEnv = classifyEnvironment(searchUrl);
  const gatewayMode = isEsDslUrl(searchUrl) ? 'es-dsl' : 'search-gw';

  let writeUrl = String(cfg.push || '').trim();
  if (!writeUrl && detectedEnv === 'test') {
    if (searchUrl.includes('-gw.')) {
      writeUrl = searchUrl.replace('-gw.', '-stream.').replace(/\/search(\/es)?$/, '');
    } else if (searchUrl.includes('search-zuul.')) {
      writeUrl = searchUrl.replace('search-zuul.', 'search-zuul-write.').replace(/\/api\/([^/]+)\/search(\/es)?$/, '/api/data/$1');
    }
  }

  return {
    serviceId: meta.serviceId,
    appSysCode: meta.appSysCode,
    name: meta.name,
    demandDesc: meta.demandDesc,
    accessType,
    env: detectedEnv,
    requestedEnv,
    version: resolved.version,
    configSource: `${getSearchBaseUrl()} (${resolved.channel} v${resolved.version})`,
    searchUrl,
    token: String(cfg.searchToken || '').trim(),
    writeUrl,
    writeToken: String(cfg.pushToken || cfg.streamZuulToken || cfg.searchToken || '').trim(),
    gatewayMode,
    mapping: cfg.mapping || {},
    routingField: cfg.routingField || null,
    searchCount: cfg.searchCount ?? null,
    readLimit: cfg.readLimit ?? null,
    topQps: cfg.topQps ?? null,
    storeSize: cfg.storeSize ?? null,
    indexName: cfg.indexName || '',
    binlogSource: Array.isArray(cfg.binlogSource) ? cfg.binlogSource : [],
    gidApiTask: cfg.gidApiTask || null,
    godApiTask: cfg.godApiTask || null,
    candidates: candidates.length > 1 ? candidates : []
  };
}

function coerceFilterValue(rawVal, fieldType) {
  const val = rawVal.trim();
  if (fieldType === 'boolean') {
    if (val === 'true') return true;
    if (val === 'false') return false;
  }
  if (['integer', 'long', 'short', 'byte'].includes(fieldType) && /^-?\d+$/.test(val)) {
    return Number(val);
  }
  if (['float', 'double'].includes(fieldType) && /^-?\d+(\.\d+)?$/.test(val)) {
    return Number(val);
  }
  return val;
}

export function parseFilterPairs(filterStr) {
  if (!filterStr || typeof filterStr !== 'string') return [];
  return filterStr
    .split(',')
    .map(pair => {
      const idx = pair.indexOf(':');
      if (idx === -1) return null;
      const field = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      return field ? { field, value } : null;
    })
    .filter(Boolean);
}

/**
 * 根据网关模式（search-gw vs es-dsl）构造检索请求体
 */
export function buildSearchRequest(target, opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const size = Math.min(100, Math.max(1, Number(opts.size) || 10));
  const filterPairs = parseFilterPairs(opts.filter);

  if (opts.dsl) {
    let parsedDsl;
    try {
      parsedDsl = typeof opts.dsl === 'string' ? JSON.parse(opts.dsl) : { ...opts.dsl };
    } catch (err) {
      throw new Error(`--dsl JSON 格式非法: ${err.message}`);
    }
    if (target.gatewayMode === 'es-dsl') {
      if (parsedDsl.from === undefined) parsedDsl.from = (page - 1) * size;
      if (parsedDsl.size === undefined) parsedDsl.size = size;
    } else {
      if (parsedDsl.page === undefined) parsedDsl.page = page - 1;
      if (parsedDsl.size === undefined) parsedDsl.size = size;
    }
    return parsedDsl;
  }

  if (target.gatewayMode === 'es-dsl') {
    const must = [];
    if (opts.query) {
      must.push({ query_string: { query: String(opts.query) } });
    }
    for (const { field, value } of filterPairs) {
      const fieldType = target.mapping?.[field]?.type;
      must.push({
        term: {
          [field]: coerceFilterValue(value, fieldType)
        }
      });
    }

    const body = {
      from: (page - 1) * size,
      size,
      query: must.length === 0
        ? { match_all: {} }
        : (must.length === 1 ? must[0] : { bool: { must } })
    };

    if (Array.isArray(opts.sourceFields) && opts.sourceFields.length > 0) {
      body._source = opts.sourceFields;
    } else if (opts.excludeVectors && target.mapping) {
      const vectorFields = Object.entries(target.mapping)
        .filter(([, meta]) => meta?.type === 'dense_vector')
        .map(([name]) => name);
      if (vectorFields.length > 0) {
        body._source = { excludes: vectorFields };
      }
    }
    return body;
  }

  const body = {
    page: page - 1,
    size
  };
  if (opts.query) {
    body.query = String(opts.query);
  }
  if (filterPairs.length > 0) {
    body.filters = {
      and: filterPairs.map(({ field, value }) => ({
        field,
        values: [value],
        operator: 'IN'
      }))
    };
  }
  return body;
}

/**
 * 统一解析 search-gw 与 es-dsl 两类网关响应
 */
export function parseSearchResponse(target, json) {
  if (!json || typeof json !== 'object') {
    throw new Error('ES 网关返回非 JSON 数据');
  }

  if (target.gatewayMode === 'es-dsl') {
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(`ES 网关异常 (code: ${json.code}): ${json.message || json.msg || '未知错误'}`);
    }
    if (json.error) {
      const errMsg = typeof json.error === 'string' ? json.error : (json.error.reason || JSON.stringify(json.error));
      throw new Error(`ES 查询错误: ${errMsg}`);
    }
    const rawTotal = json.hits?.total;
    const total = typeof rawTotal === 'number' ? rawTotal : (rawTotal?.value ?? 0);
    const hits = Array.isArray(json.hits?.hits) ? json.hits.hits : [];
    const docs = hits.map(hit => ({
      ...(hit._id !== undefined ? { _id: hit._id } : {}),
      ...(hit._source || {})
    }));
    return { total, docs };
  }

  if (json.code !== 0) {
    throw new Error(`ES 平台业务异常 (code: ${json.code}): ${json.msg || json.message || '未知错误'}`);
  }
  return {
    total: json.data?.total ?? 0,
    docs: Array.isArray(json.data?.docs) ? json.data.docs : []
  };
}
