import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAppId, loadServiceCatalog, getServiceCiDeployMeta } from './services.js';
import { loadShipwrightCookie, saveShipwrightCookie } from './credentials.js';
import { createCredentialSession } from './browser_credentials.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const SKILL_ROOT = path.resolve(__dirname, '..', '..');
export const SHRIMP_DIR = path.join(os.homedir(), '.shrimp', 'skills', 'live-inspector');
export const HOME = os.homedir();
export const WORKTREE_BASE = path.join(HOME, '.leo-live-inspector', 'worktrees');
export const CLONE_BASE = path.join(HOME, '.leo-live-inspector', 'clones');

export const REPO_ROOTS = [
  path.join(HOME, 'IdeaProjects'),
  path.join(HOME, 'dev'),
  path.join(HOME, 'WebstormProjects'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'project'),
  process.cwd()
];

export const PROJECT_REPO_FILES = [
  path.join(SKILL_ROOT, 'resources', 'project_repos.json'),
  path.join(SHRIMP_DIR, 'project_repos.json')
];

// ------------------------------------------------------------ branch utils ----

/**
 * 校验 Git 分支名称合法性，拒绝前导 -（防 Git 参数注入）及非法引用字符
 */
export function validateBranchName(branch) {
  const b = String(branch || '').trim();
  if (!b) throw new Error('分支名称不能为空');
  if (b.startsWith('-')) throw new Error(`非法的分支名称（不能以 - 开头）: ${b}`);
  if (b.includes('..') || b.includes('@{') || /[\s~^:?*[\]\\]/.test(b) || b.endsWith('/') || b.endsWith('.lock')) {
    throw new Error(`非法的分支名称: ${b}`);
  }
  return b;
}

/**
 * 识别月度 QA 分支（qa-YYYY-MM 或 qa-YYYY-M-D），返回可排序整数键
 */
export function monthlyKey(b) {
  const m = /^qa[-_]?(\d{4})[-_](\d{1,2})(?:[-_](\d{1,2}))?$/i.exec(String(b || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y * 10000 + mo * 100 + d;
}

export function sortQaAndDevBranches(branches = []) {
  const unique = [...new Set(branches.map(b => String(b || '').trim()).filter(Boolean))];
  const rank = b => {
    if (monthlyKey(b)) return 0;          // qa-YYYY-MM / qa-YYYY-M-D
    if (/^qa[-_]/i.test(b)) return 1;     // 其它 qa-* 分支
    if (/^qa$/i.test(b)) return 2;        // 固定 qa
    if (/^test$/i.test(b)) return 3;      // 固定 test
    if (/^master$/i.test(b)) return 4;
    if (/^main$/i.test(b)) return 5;
    return 6;
  };
  return unique.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const ka = monthlyKey(a), kb = monthlyKey(b);
      if (ka !== kb) return kb - ka;
    }
    return a.localeCompare(b);
  });
}

export function pickDefaultQaBranch(branches = [], remembered = '', fallbackDefault = '') {
  if (remembered) return remembered;
  const monthly = branches.filter(b => monthlyKey(b)).sort((a, b) => monthlyKey(b) - monthlyKey(a));
  if (monthly[0]) return monthly[0];
  if (fallbackDefault && branches.includes(fallbackDefault)) return fallbackDefault;
  return (
    branches.find(b => /^qa$/i.test(b)) ||
    branches.find(b => /^qa[-_]/i.test(b)) ||
    branches.find(b => /^test$/i.test(b)) ||
    fallbackDefault ||
    ''
  );
}

// -------------------------------------------------------------------- git ----

export function git(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      ...opts
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function remoteBasename(project) {
  return (project || '').split('/').pop();
}

const PREFIXES = ['zulin-', 'beijia-', 'huiju-', 'utopia-scs-', 'utopia-', 'iot-'];

function stripPrefixes(name) {
  const out = new Set();
  const lower = (name || '').toLowerCase();
  if (!lower) return out;
  out.add(lower);
  for (const p of PREFIXES) {
    if (lower.startsWith(p)) out.add(lower.slice(p.length));
  }
  return out;
}

export function projectAliases(project) {
  const serviceId = resolveAppId(project);
  const wanted = new Set();
  for (const n of [project, serviceId, remoteBasename(project)]) {
    for (const v of stripPrefixes(n)) wanted.add(v);
  }
  try {
    const catalog = loadServiceCatalog();
    for (const [key, val] of Object.entries(catalog)) {
      if (val && val.realAppId === serviceId) {
        for (const v of stripPrefixes(key)) wanted.add(v);
      }
    }
  } catch {}
  return wanted;
}

export async function repoMatchesProject(repoPath, project) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return false;
  const wanted = projectAliases(project);
  const name = path.basename(repoPath).toLowerCase();
  if (wanted.has(name)) return true;
  const res = await git(repoPath, ['remote', 'get-url', 'origin']);
  if (res.code !== 0) return false;
  const base = path.basename(res.stdout.trim().replace(/\.git$/, ''));
  return wanted.has(base.toLowerCase());
}

// --------------------------------------------------- project repo registry ----

export function loadProjectRepos() {
  const map = new Map();
  for (const file of PROJECT_REPO_FILES) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, val] of Object.entries(data || {})) {
        const gitUrl = typeof val === 'string' ? val : val && val.git;
        if (!gitUrl) continue;
        map.set(String(key).toLowerCase(), {
          git: String(gitUrl).trim(),
          note: (val && val.note) || ''
        });
      }
    } catch {}
  }
  return map;
}

export function saveLearnedProjectRepo(project, gitUrl, note = '自动从 CI 构建器或本地仓库同步') {
  if (!project || !gitUrl) return false;
  const serviceId = resolveAppId(project) || project;
  const userFile = PROJECT_REPO_FILES[1];
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  } catch {}
  const key = String(serviceId).toLowerCase();
  current[key] = {
    git: String(gitUrl).trim(),
    note: current[key]?.note || note
  };
  try {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    const tmp = `${userFile}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmp, userFile);
    return true;
  } catch {
    return false;
  }
}

export function registeredGitUrl(project, repoMap = loadProjectRepos()) {
  const aliases = projectAliases(project || '');
  for (const [key, val] of repoMap) {
    if (aliases.has(key) || key === String(project || '').toLowerCase()) return val.git;
  }
  const base = remoteBasename(project || '').toLowerCase();
  for (const [key, val] of repoMap) {
    if (key === base || key.endsWith(base)) return val.git;
  }
  const ciMeta = getServiceCiDeployMeta(project);
  if (ciMeta?.ci?.gitUrl) return ciMeta.ci.gitUrl;
  if (ciMeta?.ci?.gitAddress) return ciMeta.ci.gitAddress;
  return null;
}

/**
 * 从 Shipwright 构建器配置动态反查该微服务的 Git 仓库地址并缓存
 */
export async function discoverGitUrlFromShipwright(project) {
  const serviceId = resolveAppId(project) || project;
  if (!serviceId) return null;
  const cookie = loadShipwrightCookie();
  if (!cookie) return null;

  try {
    const res = await fetch('https://shipwright.ke.com/workflow-context/v1/workflows/query?pageNumber=1&pageSize=30', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        'labels.cloud_intra_ke_com/service_id': serviceId,
        'labels.app-svc_ke_com/platform': ['FUXI', 'CLOUD']
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list = (data?.list || []).filter(w =>
      w.labels?.['app-svc_ke_com/deleted'] !== '1' &&
      w.labels?.['app-svc_ke_com/cleared'] !== '1'
    );
    const wf = list.find(w =>
      w.labels?.['app-svc_ke_com/env'] === 'test' ||
      (w.name && /test|测试/i.test(w.name))
    ) || list[0];
    if (!wf || !Array.isArray(wf.steps)) return null;
    const gitStep = wf.steps.find(s => s.id === 'git' || s.template?.type === 'Git');
    const tpl = gitStep?.template || {};
    const gitUrl = tpl.url || tpl.repository || tpl.gitUrl || tpl.repoUrl || tpl.repo || '';
    if (gitUrl && /^(https?:\/\/|git@)/i.test(String(gitUrl).trim())) {
      const normalized = String(gitUrl).trim();
      saveLearnedProjectRepo(serviceId, normalized, `自动从 Shipwright 构建器 [${wf.name || wf.id}] 反查`);
      return normalized;
    }
  } catch {}
  return null;
}

/**
 * 全量通用项目列表：聚合已登记仓库 + default_services.json 全量主键服务
 */
export function listUniversalProjects() {
  const catalog = loadServiceCatalog();
  const repoMap = loadProjectRepos();
  const seen = new Set();
  const out = [];

  const addService = (rawKey, repoEntry = null) => {
    const serviceId = resolveAppId(rawKey) || rawKey;
    if (!serviceId || serviceId.includes(':') || seen.has(serviceId)) return;
    const meta = catalog[serviceId] || catalog[rawKey] || {};
    const ciMeta = getServiceCiDeployMeta(serviceId) || {};
    const ci = Boolean((meta.ci && meta.ci.workflowId) || (ciMeta.ci && ciMeta.ci.workflowId));
    const deploy = Boolean(
      (meta.deploy && meta.deploy.test && meta.deploy.test.workloadId) ||
      (ciMeta.deploy && ciMeta.deploy.test && ciMeta.deploy.test.workloadId)
    );
    const gitUrl = repoEntry?.git || registeredGitUrl(serviceId, repoMap) || '';
    const note = repoEntry?.note || meta.description || '';
    seen.add(serviceId);
    out.push({
      id: serviceId,
      label: rawKey,
      git: gitUrl,
      note,
      ci,
      deploy
    });
  };

  // 1. 已显式登记 Git 地址的项目优先
  for (const [key, val] of repoMap) {
    addService(key, val);
  }

  // 2. 全量服务注册表中的真实服务（排除指向其他服务的纯别名和 :prod 索引变体）
  for (const [key, val] of Object.entries(catalog)) {
    if (!val || typeof val !== 'object' || key.includes(':')) continue;
    if (val.realAppId && val.realAppId !== key) continue;
    addService(key, null);
  }

  return out.sort((a, b) => {
    // 已登记 Git 或已配 CI 的排在前面，其余按字母序
    const score = p => (p.git ? 2 : 0) + (p.ci ? 1 : 0);
    const diff = score(b) - score(a);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

export function cloneDirFor(project) {
  const key = String(project || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(CLONE_BASE, key);
}

export async function ensureClone(project, gitUrl) {
  const dir = cloneDirFor(project);
  const isRepo = fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'HEAD'));
  if (!isRepo) {
    fs.mkdirSync(CLONE_BASE, { recursive: true });
    const res = await new Promise(resolve => {
      const child = spawn('git', ['clone', '--no-checkout', '--quiet', gitUrl, dir], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      });
      let err = '';
      child.stderr.on('data', d => err += d.toString());
      child.on('error', e => resolve({ code: -1, stderr: err + e.message }));
      child.on('close', code => resolve({ code: code ?? -1, stderr: err }));
    });
    if (res.code !== 0) throw new Error(`克隆仓库失败 [${gitUrl}]:\n${res.stderr.trim()}`);
    return dir;
  }
  const remote = await git(dir, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0 || remote.stdout.trim() !== gitUrl) {
    await git(dir, ['remote', 'set-url', 'origin', gitUrl]);
  }
  return dir;
}

export async function findLocalRepo(project) {
  for (const root of REPO_ROOTS) {
    const direct = path.join(root, remoteBasename(project));
    if (await repoMatchesProject(direct, project)) return direct;
  }
  for (const root of REPO_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      if (await repoMatchesProject(full, project)) return full;
    }
  }
  return null;
}

/**
 * 通用仓库定位：手动指定 > 已登记 Git 托管克隆 > 本地目录扫描(并自学习 remote) > Shipwright 构建器反查
 */
export async function detectProjectRepo(project, manualRepos = {}) {
  if (!project) return { repoPath: null, gitUrl: null, repoMode: 'none', cloneError: null };
  const override = manualRepos[project];
  if (override && fs.existsSync(path.join(override, '.git'))) {
    return { repoPath: override, gitUrl: registeredGitUrl(project), repoMode: 'manual', cloneError: null };
  }

  let gitUrl = registeredGitUrl(project);
  if (gitUrl) {
    try {
      const repoPath = await ensureClone(project, gitUrl);
      return { repoPath, gitUrl, repoMode: 'clone', cloneError: null };
    } catch (err) {
      return { repoPath: null, gitUrl, repoMode: 'clone', cloneError: err.message };
    }
  }

  // 回退 1：扫描本机常用代码目录，若找到则顺手把 origin URL 记录下来
  const localPath = await findLocalRepo(project);
  if (localPath) {
    const remoteRes = await git(localPath, ['remote', 'get-url', 'origin']);
    if (remoteRes.code === 0 && remoteRes.stdout.trim()) {
      gitUrl = remoteRes.stdout.trim();
      saveLearnedProjectRepo(project, gitUrl, '自动从本机 Git 仓库同步');
    }
    return { repoPath: localPath, gitUrl, repoMode: 'local', cloneError: null };
  }

  // 回退 2：向 Shipwright 构建器反查 Git 地址并自动托管克隆
  gitUrl = await discoverGitUrlFromShipwright(project);
  if (gitUrl) {
    try {
      const repoPath = await ensureClone(project, gitUrl);
      return { repoPath, gitUrl, repoMode: 'clone', cloneError: null };
    } catch (err) {
      return { repoPath: null, gitUrl, repoMode: 'clone', cloneError: err.message };
    }
  }

  return { repoPath: null, gitUrl: null, repoMode: 'none', cloneError: null };
}

export async function listRemoteBranches(repoPath) {
  let branches = [];
  const lsRemote = await git(repoPath, ['ls-remote', '--heads', 'origin']);
  if (lsRemote.code === 0) {
    branches = lsRemote.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);
  }
  if (branches.length === 0) {
    const local = await git(repoPath, ['branch', '-r', '--format=%(refname:short)']);
    if (local.code === 0) {
      branches = local.stdout.split('\n').map(s => s.replace(/^origin\//, '').trim()).filter(Boolean);
    }
  }
  return sortQaAndDevBranches(branches);
}

export async function remoteBranchExists(repoPath, branch) {
  const clean = validateBranchName(branch);
  const res = await git(repoPath, ['ls-remote', '--heads', 'origin', `refs/heads/${clean}`]);
  return res.code === 0 && res.stdout.trim().length > 0;
}

// --------------------------------------------------- isolated worktree merge ----

async function runStreamingGit(repoPath, args, onLog = () => {}) {
  return new Promise((resolve) => {
    onLog(`$ git ${args.join(' ')}`);
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { const s = d.toString(); stdout += s; onLog(s.replace(/\n$/, '')); });
    child.stderr.on('data', d => { const s = d.toString(); stderr += s; onLog(s.replace(/\n$/, '')); });
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function createIsolatedWorktree(repoPath, remoteRef, onLog = () => {}) {
  fs.mkdirSync(WORKTREE_BASE, { recursive: true });
  await git(repoPath, ['worktree', 'prune']);

  const refCheck = await git(repoPath, ['rev-parse', '--verify', `refs/remotes/${remoteRef}`]);
  if (refCheck.code !== 0) {
    throw new Error(`本地缺少远程分支引用 ${remoteRef}\n请先执行: git fetch origin`);
  }

  const worktree = path.join(WORKTREE_BASE, `merge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const args = ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--force', worktree, remoteRef];

  let res = await runStreamingGit(repoPath, args, onLog);
  if (res.code !== 0) {
    onLog('\n⚠️ 创建工作区失败，清理残留后重试一次…');
    await git(repoPath, ['worktree', 'prune']);
    res = await runStreamingGit(repoPath, args, onLog);
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(`创建临时工作区失败:\n${detail || '(git 未输出错误信息)'}\n(临时路径: ${worktree})`);
  }
  return worktree;
}

/**
 * 在隔离 worktree 中将远程 devBranch 合并进 qaBranch 并推送远程（冲突严格失败并回滚）
 */
export async function mergeBranchIntoQa({
  repoPath,
  devBranch,
  qaBranch,
  preview = false,
  onLog = msg => console.log(msg)
}) {
  const cleanDev = validateBranchName(devBranch);
  const cleanQa = validateBranchName(qaBranch);
  if (cleanDev === cleanQa) throw new Error('开发分支与目标 QA 分支不能相同');
  if (!(await remoteBranchExists(repoPath, cleanDev))) throw new Error(`远程不存在开发分支: ${cleanDev}`);
  if (!(await remoteBranchExists(repoPath, cleanQa))) throw new Error(`远程不存在目标 QA 分支: ${cleanQa}`);

  onLog('\n========== 步骤 1: 拉取最新远程分支 ==========');
  const fetchRes = await runStreamingGit(repoPath, [
    'fetch', '--prune', 'origin',
    `+refs/heads/${cleanDev}:refs/remotes/origin/${cleanDev}`,
    `+refs/heads/${cleanQa}:refs/remotes/origin/${cleanQa}`
  ], onLog);
  if (fetchRes.code !== 0) throw new Error('git fetch 失败:\n' + (fetchRes.stderr || '').trim());

  const ancestor = await git(repoPath, [
    'merge-base', '--is-ancestor',
    `refs/remotes/origin/${cleanDev}`,
    `refs/remotes/origin/${cleanQa}`
  ]);
  if (ancestor.code === 0) {
    onLog(`\n✅ 开发分支 [${cleanDev}] 已包含在 [${cleanQa}] 中，跳过重复合并。`);
    return { alreadyMerged: true, preview, qaBranch: cleanQa, devBranch: cleanDev };
  }

  const worktree = await createIsolatedWorktree(repoPath, `origin/${cleanQa}`, onLog);
  try {
    onLog('\n========== 步骤 2: 创建隔离工作区并检出 QA 分支 ==========');
    onLog(`工作区: ${worktree}`);

    onLog('\n========== 步骤 3: 合并开发分支到 QA 分支 ==========');
    const mergeArgs = [
      '-c', 'core.hooksPath=/dev/null',
      'merge', '--no-ff', '--no-edit',
      '-m', `chore(deploy): merge ${cleanDev} into ${cleanQa}`,
      `origin/${cleanDev}`
    ];
    const merge = await runStreamingGit(worktree, mergeArgs, onLog);

    if (merge.code !== 0) {
      const conflictFiles = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
      await runStreamingGit(worktree, ['-c', 'core.hooksPath=/dev/null', 'merge', '--abort'], onLog);
      if (!conflictFiles) {
        throw new Error('合并失败（非冲突问题），已回滚合并。\n' + (merge.stderr || '').trim());
      }
      throw new Error(
        `合并冲突（策略：严格失败），已回滚，未推送、未部署。冲突文件:\n${conflictFiles}\n请先解决冲突后重试。`
      );
    }

    const head = (await git(worktree, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    onLog(`\n✅ 合并完成，新提交: ${head}`);
    const stat = (await git(worktree, ['diff', '--stat', `origin/${cleanQa}..HEAD`])).stdout.trim();
    if (stat) onLog('\n本次合并涉及的改动:\n' + stat);

    if (preview) {
      onLog('\n🔍 预演模式：合并无冲突，未推送、未部署。');
      return { alreadyMerged: false, preview: true, commit: head, diffStat: stat, qaBranch: cleanQa, devBranch: cleanDev };
    }

    onLog('\n========== 步骤 4: 推送 QA 分支到远程 ==========');
    const push = await runStreamingGit(worktree, ['push', 'origin', `HEAD:refs/heads/${cleanQa}`], onLog);
    if (push.code !== 0) {
      const errText = `${push.stderr || ''}\n${push.stdout || ''}`;
      if (/protected branch|pre-receive hook declined/i.test(errText)) {
        const remoteUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
        const webBase = remoteUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
        const tmpBranch = `auto/merge-${cleanQa}-${String(Date.now()).slice(-6)}`;
        onLog(`\n⚠️ ${cleanQa} 是受保护分支，不能直接推送（需要 MR 合入）`);
        const tmpPush = await runStreamingGit(worktree, ['push', 'origin', `HEAD:refs/heads/${tmpBranch}`], onLog);
        if (tmpPush.code === 0) {
          onLog(`✅ 合并结果已推送到临时分支: ${tmpBranch}`);
          onLog(`   创建 MR: ${webBase}/-/compare/${cleanQa}...${tmpBranch}`);
          throw new Error(
            `${cleanQa} 是受保护分支，无法直接推送。\n` +
            `合并结果已推送到临时分支: ${tmpBranch}\n` +
            `请在 GitLab 发起 MR 合入 ${cleanQa}:\n${webBase}/-/compare/${cleanQa}...${tmpBranch}\n` +
            `（或直接部署开发分支 ${cleanDev} 先发布测试环境）`
          );
        }
        throw new Error(`${cleanQa} 是受保护分支，无法直接推送；临时分支 ${tmpBranch} 推送也失败。\n${errText.trim()}`);
      }
      throw new Error('推送 QA 分支失败（请检查 Git 凭据）:\n' + (push.stderr || '').trim());
    }
    onLog(`✅ 已推送 ${cleanQa} 分支`);
    return { alreadyMerged: false, preview: false, commit: head, diffStat: stat, qaBranch: cleanQa, devBranch: cleanDev };
  } finally {
    await git(repoPath, ['worktree', 'remove', '--force', worktree]);
    await git(repoPath, ['worktree', 'prune']);
  }
}
