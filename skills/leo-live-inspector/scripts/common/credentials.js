import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const SHRIMP_LIVE_DIR = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector');


export function writeCredentialJson(file, payload) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

export function ensureShrimpLiveDir() {
  if (!fs.existsSync(SHRIMP_LIVE_DIR)) {
    fs.mkdirSync(SHRIMP_LIVE_DIR, { recursive: true });
  }
}

/**
 * 通用 Cookie 加载引擎 (支持环境变量 -> 本地缓存 -> Downloads 目录 cookies.txt 自动嗅探)
 */
export function loadCookie({
  envVar = null,
  jsonFileName = 'cookie.json',
  targetUrl = null,
  downloadCandidates = []
} = {}) {
  // 1. 环境变量优先
  if (envVar && process.env[envVar]) {
    return process.env[envVar].trim();
  }

  // 2. 本地持久化文件
  const jsonPath = path.join(SHRIMP_LIVE_DIR, jsonFileName);
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (data.cookie) return data.cookie.trim();
      if (data.token) return data.token.trim();
    } catch {}
  }

  // 3. 自动嗅探 Downloads 与工作目录
  const candidates = [
    ...downloadCandidates.map(name => path.join(process.cwd(), name)),
    path.join(process.cwd(), 'cookies.txt'),
    ...downloadCandidates.map(name => path.join(os.homedir(), 'Downloads', name)),
    path.join(os.homedir(), 'Downloads', 'cookies.txt')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const text = fs.readFileSync(c, 'utf8');
        if (!targetUrl) continue;
        const target = new URL(targetUrl);
        const lines = text.split('\n');
        const kvs = [];
        for (const line of lines) {
          if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
          const parts = line.replace(/^#HttpOnly_/, '').trimEnd().split('\t');
          if (parts.length !== 7) continue;
          const [rawDomain, includeSubdomains, cookiePath, secure, expiry, name, val] = parts;
          const domain = rawDomain.replace(/^\./, '').toLowerCase();
          const domainMatches = target.hostname === domain ||
            (includeSubdomains === 'TRUE' && target.hostname.endsWith(`.${domain}`));
          const pathMatches = cookiePath.startsWith('/') && (target.pathname === cookiePath ||
            target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`));
          const expires = Number(expiry);
          if (domain && domainMatches && pathMatches &&
              (secure !== 'TRUE' || target.protocol === 'https:') &&
              Number.isFinite(expires) && (expires === 0 || expires * 1000 > Date.now()) &&
              /^[!#$%&'*+.^_`|~\w-]+$/.test(name) && !/[\x00-\x20\x7f;]/.test(val)) {
            kvs.push(`${name}=${val}`);
          }
        }
        if (kvs.length > 0) {
          const cookieStr = kvs.join('; ');
          saveCookie({ jsonFileName, cookieStr });
          return cookieStr;
        }
      } catch {}
    }
  }

  return '';
}

/**
 * 通用 Cookie 保存引擎
 */
export function saveCookie({
  jsonFileName = 'cookie.json',
  cookieStr = '',
  extraFields = {}
} = {}) {
  ensureShrimpLiveDir();
  const jsonPath = path.join(SHRIMP_LIVE_DIR, jsonFileName);
  try {
    writeCredentialJson(jsonPath, {
      cookie: cookieStr.trim(),
      updated_at: new Date().toISOString(),
      ...extraFields
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------- 专用高层业务凭证接口 ----------------

/** Apollo 测试环境 Portal Cookie */
export function loadApolloTestCookie() {
  return loadCookie({
    envVar: 'APOLLO_TEST_COOKIE',
    jsonFileName: 'test_apollo_cookie.json',
    targetUrl: 'http://test-apollo.portal.life.ke.com/',
    downloadCandidates: [
      'cookies-test-apollo.portal.life.ke.com.txt',
      'cookies-test-apollo.txt'
    ]
  });
}

export function saveApolloTestCookie(cookieStr) {
  return saveCookie({
    jsonFileName: 'test_apollo_cookie.json',
    cookieStr
  });
}

/** Paoding Loki 容器日志 Cookie */
export function loadPaodingCookie() {
  return loadCookie({
    envVar: 'PAODING_COOKIE',
    jsonFileName: 'paoding_cookie.json',
    targetUrl: 'https://paoding.ke.com/api/ds/query',
    downloadCandidates: [
      'cookies-paoding.ke.com.txt',
      'cookies-paoding.txt'
    ]
  });
}

export function savePaodingCookie(cookieStr) {
  return saveCookie({
    jsonFileName: 'paoding_cookie.json',
    cookieStr
  });
}

/** 
 * 贝壳云平台与 CI 平台全量 Cookie 凭证 (支持 构建、部署、查库 全场景)
 */
export function loadCloudCookie() {
  if (process.env.CLOUD_COOKIE) return process.env.CLOUD_COOKIE.trim();

  const tokenFile = path.join(SHRIMP_LIVE_DIR, 'cloud_token.json');
  if (fs.existsSync(tokenFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (data.cookie) return data.cookie.trim();
      if (data.cloud_console_token_egg) {
        return `cloud_console_token_egg=${data.cloud_console_token_egg.trim()};`;
      }
      if (data.token) {
        return `cloud_console_token_egg=${data.token.trim()};`;
      }
    } catch {}
  }

  const cookieStr = loadCookie({
    jsonFileName: 'cloud_token.json',
    targetUrl: 'https://cloud.intra.ke.com/',
    downloadCandidates: [
      'cookies-cloud.intra.ke.com.txt',
      'cookies-cloud.ke.com.txt',
      'cookies.txt'
    ]
  });

  return cookieStr || '';
}

export function saveCloudCookie(cookieStr) {
  ensureShrimpLiveDir();
  const tokenFile = path.join(SHRIMP_LIVE_DIR, 'cloud_token.json');
  const cleanCookie = cookieStr.trim();
  
  let eggToken = '';
  const match = cleanCookie.match(/cloud_console_token_egg=([^;]+)/);
  if (match) eggToken = match[1].trim();

  try {
    const payload = {
      cookie: cleanCookie,
      updated_at: new Date().toISOString()
    };
    if (eggToken) {
      payload.cloud_console_token_egg = eggToken;
      payload.token = eggToken;
    }
    writeCredentialJson(tokenFile, payload);
    return true;
  } catch {
    return false;
  }
}

/** 服务云 MySQL 凭证 Token (向下兼容纯查库场景) */
export function loadCloudConsoleToken() {
  if (process.env.CLOUD_CONSOLE_TOKEN) return process.env.CLOUD_CONSOLE_TOKEN.trim();

  const tokenFile = path.join(SHRIMP_LIVE_DIR, 'cloud_token.json');
  if (fs.existsSync(tokenFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (data.cloud_console_token_egg) return data.cloud_console_token_egg.trim();
      if (data.token) return data.token.trim();
      if (data.cookie) {
        const match = data.cookie.match(/cloud_console_token_egg=([^;]+)/);
        if (match) return match[1].trim();
      }
    } catch {}
  }

  const cookieStr = loadCookie({
    jsonFileName: 'cloud_token.json',
    targetUrl: 'https://cloud.intra.ke.com/',
    downloadCandidates: ['cookies-cloud.intra.ke.com.txt', 'cookies.txt']
  });
  if (cookieStr) {
    const match = cookieStr.match(/cloud_console_token_egg=([^;]+)/);
    if (match) return match[1].trim();
  }
  return '';
}

export function saveCloudConsoleToken(token) {
  ensureShrimpLiveDir();
  const tokenFile = path.join(SHRIMP_LIVE_DIR, 'cloud_token.json');
  let cleanToken = token.trim();
  if (cleanToken.includes('cloud_console_token_egg=')) {
    const match = cleanToken.match(/cloud_console_token_egg=([^;]+)/);
    if (match) cleanToken = match[1].trim();
  } else {
    cleanToken = cleanToken.replace(/;.*$/, '').trim();
  }

  let existing = {};
  if (fs.existsSync(tokenFile)) {
    try { existing = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch {}
  }

  try {
    writeCredentialJson(tokenFile, {
      ...existing,
      cloud_console_token_egg: cleanToken,
      token: cleanToken,
      updated_at: new Date().toISOString()
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 贝壳前端 CI/CD 平台 (FeCI / 青蝉 cicada: feci-next.ke.com) Cookie 凭证
 */
export function loadFeciCookie() {
  return loadCookie({
    envVar: 'FECI_COOKIE',
    jsonFileName: 'feci_cookie.json',
    targetUrl: 'https://feci-next.ke.com/',
    downloadCandidates: [
      'cookies-feci-next.ke.com.txt',
      'cookies-feci.ke.com.txt',
      'cookies.txt'
    ]
  });
}

export function saveFeciCookie(cookieStr) {
  return saveCookie({
    jsonFileName: 'feci_cookie.json',
    cookieStr
  });
}


export function loadShipwrightCookie() {
  return loadCookie({envVar:'SHIPWRIGHT_COOKIE', jsonFileName:'shipwright_cookie.json',
    targetUrl:'https://shipwright.ke.com/', downloadCandidates:['cookies-shipwright.ke.com.txt']});
}
export function saveShipwrightCookie(cookieStr) {
  return saveCookie({jsonFileName:'shipwright_cookie.json',cookieStr});
}
