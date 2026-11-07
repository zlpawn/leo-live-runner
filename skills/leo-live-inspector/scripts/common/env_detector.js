import { URL } from 'node:url';

/**
 * 核心测试环境正则特征集（涵盖常见测试/SIT/QA/Dev/Preview等特征）
 * 严格按照规范：只有明确符合这些测试特征的域名才被允许认定为测试环境
 */
export const TEST_PATTERNS = [
  /\.test\.ke\.com$/i,
  /\.test\.lianjia\.com$/i,
  /\.test\.mysql\.ljnode\.com$/i,
  /[-.](test|qa|sit|dev|preview|prev)[-.0-9]/i,
  /[-.](test|qa|sit|dev|preview|prev)$/i,
  /^(test|qa|sit|dev|preview|prev)[0-9]*[.-]/i,
];

/**
 * 从 URL 或 Hostname 判定环境
 * 核心原则：疑罪从严，凡是不符合测试特征的一律默认为 'prod'（只读保护）
 * @param {string} urlStr URL 地址或主机名
 * @returns {'test' | 'prod'}
 */
export function classifyEnvironment(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return 'prod';
  }

  let hostname = '';
  try {
    const raw = urlStr.trim();
    const url = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`);
    hostname = url.hostname.toLowerCase();
  } catch {
    hostname = urlStr.trim().toLowerCase().split('/')[0].split(':')[0];
  }

  if (!hostname) {
    return 'prod';
  }

  // 严格检查是否命中测试特征
  const isTest = TEST_PATTERNS.some(pattern => pattern.test(hostname));
  if (isTest) {
    return 'test';
  }

  // 🛡️ 疑罪从严：未命中任何测试特征的，一律判定为 prod
  return 'prod';
}

/**
 * 校验写操作（新增/修改/删除）是否被允许
 * @param {string} declaredEnv 用户指定的环境参数 (e.g. 'prod' | 'test')
 * @param {string} targetUrl 目标请求 URL
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function assertWritePermitted(declaredEnv, targetUrl) {
  const normDeclared = (declaredEnv || '').trim().toLowerCase();
  const urlEnv = classifyEnvironment(targetUrl);

  if (normDeclared === 'prod' || normDeclared === 'production' || normDeclared === 'online') {
    return {
      allowed: false,
      reason: '用户显式指定了生产环境 (-e prod)，严格禁止执行写操作！'
    };
  }

  if (urlEnv === 'prod') {
    return {
      allowed: false,
      reason: `目标地址 [${targetUrl}] 未识别到任何测试环境特征，疑罪从严视为生产环境，物理阻断一切写操作！`
    };
  }

  return { allowed: true };
}
