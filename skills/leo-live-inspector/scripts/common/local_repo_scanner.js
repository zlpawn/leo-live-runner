import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_FILE = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector', 'local_repos_cache.json');
const PRUNE_DIRS = new Set([
  'node_modules', '.git', 'target', '.worktrees', 'dist', 'build', '.idea', '.vscode', 'apk', 'bin', 'out'
]);

/**
 * 动态获取所有可扫描的工程根目录池（纯动态推导，零硬编码路径）
 */
export function getCandidateProjectRoots() {
  const roots = new Set();

  // 1. 当前工作目录 (process.cwd())
  const cwd = process.cwd();
  roots.add(cwd);

  // 2. 动态向上追溯当前工程的 Git 根目录及其平级兄弟目录
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (gitRoot && fs.existsSync(gitRoot)) {
      roots.add(gitRoot);
      const parentDir = path.dirname(gitRoot);
      if (fs.existsSync(parentDir)) {
        roots.add(parentDir);
      }
    }
  } catch {}

  // 3. 动态追溯当前 Skill 所在的仓库根目录及平级兄弟目录
  try {
    let cur = __dirname;
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(cur, '.git'))) {
        const parentDir = path.dirname(cur);
        if (fs.existsSync(parentDir)) roots.add(parentDir);
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {}

  // 4. 动态探测用户主目录下 (os.homedir()) 的常见工作区目录
  const homeDir = os.homedir();
  const commonWorkspaceNames = ['project', 'projects', 'workspace', 'code', 'dev', 'git', 'src'];
  for (const name of commonWorkspaceNames) {
    const fullPath = path.join(homeDir, name);
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        roots.add(fullPath);
      }
    } catch {}
  }

  // 5. 支持环境变量注入的自定义目录 (支持系统特定分隔符)
  const envRoots = process.env.LEO_PROJECT_ROOTS || process.env.PROJECT_ROOTS;
  if (envRoots) {
    envRoots.split(path.delimiter).forEach(p => {
      const trimmed = p.trim();
      if (trimmed && fs.existsSync(trimmed)) {
        roots.add(trimmed);
      }
    });
  }

  return Array.from(roots);
}

/**
 * 读取本地扫描索引缓存
 */
export function loadRepoCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

/**
 * 写入本地扫描索引缓存
 */
export function saveRepoCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {}
}

/**
 * 递归定向查找匹配 targetAppId 的工程目录（限制扫描深度，排除无关目录）
 * @param {string} dir 当前目录
 * @param {string} targetAppId 目标应用名（如 zulin-iot-platform, iot-platform）
 * @param {number} depth 当前深度
 * @param {number} maxDepth 最大深度
 * @param {Set<string>} visited 避免循环软链接
 * @returns {string|null} 匹配的工程根路径
 */
function findRepoDirectory(dir, targetAppId, depth = 0, maxDepth = 3, visited = new Set()) {
  if (depth > maxDepth || visited.has(dir)) return null;
  visited.add(dir);

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const baseName = path.basename(dir).toLowerCase();
  const targetNorm = targetAppId.toLowerCase();

  // 检查当前目录是否为目标工程（目录名匹配，或目录下有包含该 targetAppId 的 pom.xml / package.json / 配置文件）
  if (baseName === targetNorm || baseName.includes(targetNorm) || targetNorm.includes(baseName)) {
    // 验证是否是工程目录（含有 pom.xml, package.json 或 src）
    const hasPom = entries.some(e => e.isFile() && e.name === 'pom.xml');
    const hasPkg = entries.some(e => e.isFile() && e.name === 'package.json');
    const hasSrc = entries.some(e => e.isDirectory() && e.name === 'src');
    if (hasPom || hasPkg || hasSrc) {
      return dir;
    }
  }

  // 检查当前目录下是否有 pom.xml 且内容包含 targetAppId
  const pomEntry = entries.find(e => e.isFile() && e.name === 'pom.xml');
  if (pomEntry) {
    try {
      const pomContent = fs.readFileSync(path.join(dir, pomEntry.name), 'utf8');
      if (pomContent.includes(`<artifactId>${targetAppId}</artifactId>`) ||
          pomContent.includes(`<name>${targetAppId}</name>`)) {
        return dir;
      }
    } catch {}
  }

  // 深度递归子目录
  for (const entry of entries) {
    if (entry.isDirectory() && !PRUNE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
      const subDir = path.join(dir, entry.name);
      const found = findRepoDirectory(subDir, targetAppId, depth + 1, maxDepth, visited);
      if (found) return found;
    }
  }

  return null;
}

/**
 * 动态嗅探定位目标工程根目录
 * @param {string} appId 应用名
 * @returns {string|null} 工程根目录
 */
export function locateLocalRepository(appId) {
  if (!appId) return null;
  const cache = loadRepoCache();

  // 1. 优先使用有效缓存
  if (cache[appId] && fs.existsSync(cache[appId])) {
    return cache[appId];
  }

  // 2. 动态扫描多候选根目录池
  const candidateRoots = getCandidateProjectRoots();
  const visited = new Set();

  for (const root of candidateRoots) {
    const found = findRepoDirectory(root, appId, 0, 3, visited);
    if (found) {
      cache[appId] = found;
      saveRepoCache(cache);
      return found;
    }
  }

  return null;
}

/**
 * 从本地工程中提取 YAML/Properties 配置文件中的 ES/Search 相关配置
 * @param {string} repoDir 工程根目录
 * @param {'prod'|'test'} env 环境
 * @returns {object|null}
 */
export function extractSearchConfigFromLocalRepo(repoDir, env = 'prod') {
  if (!repoDir || !fs.existsSync(repoDir)) return null;

  // 寻找所有可能的配置文件
  const candidateConfigFiles = [
    `application-${env}.yml`,
    `application-${env}.properties`,
    `application.yml`,
    `application.properties`,
    `bootstrap.yml`,
    `bootstrap.properties`
  ];

  const foundFiles = [];
  function scanForConfig(dir, depth = 0) {
    if (depth > 5) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !PRUNE_DIRS.has(e.name) && !e.name.startsWith('.')) {
          scanForConfig(path.join(dir, e.name), depth + 1);
        } else if (e.isFile() && candidateConfigFiles.includes(e.name)) {
          foundFiles.push(path.join(dir, e.name));
        }
      }
    } catch {}
  }
  scanForConfig(repoDir);

  if (foundFiles.length === 0) return null;

  // 优先选用带对应环境名的文件 (如 application-prod.yml)
  foundFiles.sort((a, b) => {
    const aHasEnv = path.basename(a).includes(env);
    const bHasEnv = path.basename(b).includes(env);
    if (aHasEnv && !bHasEnv) return -1;
    if (!aHasEnv && bHasEnv) return 1;
    return 0;
  });

  for (const filePath of foundFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = parseYamlOrPropertiesSearchConfig(content);
      if (parsed && (parsed.domain || Object.keys(parsed.services || {}).length > 0)) {
        return {
          sourceFile: filePath,
          ...parsed
        };
      }
    } catch {}
  }

  return null;
}

/**
 * 极简但鲁棒的 YAML 块解析：提取 search 相关配置
 * 避免强依赖大型第三方 YAML 库，保持零依赖
 */
function parseYamlOrPropertiesSearchConfig(content) {
  const result = {
    domain: '',
    writeDomain: '',
    services: {}
  };

  const lines = content.split('\n');
  let inSearchBlock = false;
  let inTokenBlock = false;
  let inWriteTokenBlock = false;
  let searchIndent = -1;
  let subIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 忽略注释与空行
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = rawLine.search(/\S/);

    if (trimmed.startsWith('search:')) {
      inSearchBlock = true;
      searchIndent = indent;
      inTokenBlock = false;
      inWriteTokenBlock = false;
      continue;
    }

    if (inSearchBlock) {
      if (indent <= searchIndent && trimmed.includes(':')) {
        // 退出了 search 块
        inSearchBlock = false;
        inTokenBlock = false;
        inWriteTokenBlock = false;
        continue;
      }

      if (trimmed.startsWith('domain:')) {
        result.domain = trimmed.replace('domain:', '').trim().replace(/^['"]|['"]$/g, '');
        inTokenBlock = false;
        inWriteTokenBlock = false;
      } else if (trimmed.startsWith('write-domain:')) {
        result.writeDomain = trimmed.replace('write-domain:', '').trim().replace(/^['"]|['"]$/g, '');
        inTokenBlock = false;
        inWriteTokenBlock = false;
      } else if (trimmed.startsWith('token:')) {
        inTokenBlock = true;
        inWriteTokenBlock = false;
        subIndent = indent;
      } else if (trimmed.startsWith('write-token:')) {
        inWriteTokenBlock = true;
        inTokenBlock = false;
        subIndent = indent;
      } else if (inTokenBlock && indent > subIndent) {
        const parts = trimmed.split(':');
        if (parts.length >= 2) {
          const serviceId = parts[0].trim().replace(/^['"]|['"]$/g, '');
          const token = parts[1].trim().replace(/^['"]|['"]$/g, '');
          if (!result.services[serviceId]) result.services[serviceId] = { serviceId };
          result.services[serviceId].token = token;
        }
      } else if (inWriteTokenBlock && indent > subIndent) {
        const parts = trimmed.split(':');
        if (parts.length >= 2) {
          const serviceId = parts[0].trim().replace(/^['"]|['"]$/g, '');
          const writeToken = parts[1].trim().replace(/^['"]|['"]$/g, '');
          if (!result.services[serviceId]) result.services[serviceId] = { serviceId };
          result.services[serviceId].writeToken = writeToken;
        }
      }
    }
  }

  return result;
}
