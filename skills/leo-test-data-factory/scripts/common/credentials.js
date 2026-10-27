import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SEEDER_HOME = path.join(os.homedir(), '.shrimp', 'skills', 'test-data-factory');
export const CREDENTIAL_FILE = path.join(SEEDER_HOME, 'credentials.json');

/**
 * 凭据解析优先级（高 → 低）：
 * 1. 环境变量 SEEDER_<SYSTEM>_PASSWORD（临时覆盖，适合切换环境）
 * 2. resources/systems.json 中的内置密码（开箱即用）
 * 3. 本地缓存 ~/.shrimp/skills/test-data-factory/credentials.json
 * 4. 都没有则返回 null，由调用方给出引导
 *
 * 注：内置密码仅限内网测试环境，公网无法直连；如需换环境用环境变量覆盖即可。
 */
export function loadPassword(systemName, systemsConfig = null) {
  const envKey = `SEEDER_${systemName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD`;
  if (process.env[envKey]) {
    return process.env[envKey].trim();
  }

  const builtin = systemsConfig?.systems?.[systemName];
  if (builtin?.type === 'mysql') {
    const ds = builtin.datasources?.default;
    if (ds?.password) return ds.password;
  } else if (builtin?.password) {
    return builtin.password;
  }

  const cache = readCredentialFile();
  const entry = cache?.[systemName];
  if (entry?.password) {
    return entry.password;
  }
  return null;
}

export function readCredentialFile() {
  try {
    if (!fs.existsSync(CREDENTIAL_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIAL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 保存凭据覆盖（验通后调用），权限 0600。
 * 用于临时覆盖内置密码，不影响仓库内的 systems.json。
 */
export function savePassword(systemName, password, meta = {}) {
  const cache = readCredentialFile() || {};
  cache[systemName] = { ...meta, password };
  fs.mkdirSync(SEEDER_HOME, { recursive: true, mode: 0o700 });
  const temp = `${CREDENTIAL_FILE}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(temp, CREDENTIAL_FILE);
  return CREDENTIAL_FILE;
}

export function listConfigured() {
  const cache = readCredentialFile() || {};
  return Object.keys(cache);
}

export function buildMissingPasswordHint(systemName) {
  const envKey = `SEEDER_${systemName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD`;
  return [
    `未找到 [${systemName}] 的测试库密码。`,
    `请任选一种方式提供：`,
    `  1) 设置环境变量：export ${envKey}='<password>'`,
    `  2) 让 AI 后台执行一次带密码的连接，成功后会自动缓存到：${CREDENTIAL_FILE}`,
  ].join('\n');
}
