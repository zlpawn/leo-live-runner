import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAppId, loadServiceCatalog, getServiceCiDeployMeta } from '../common/services.js';
import {
  SKILL_ROOT,
  SHRIMP_DIR,
  git,
  monthlyKey,
  pickDefaultQaBranch,
  listUniversalProjects,
  detectProjectRepo,
  listRemoteBranches,
  mergeBranchIntoQa
} from '../common/qa_merge.js';
import {
  saveApolloTestCookie,
  saveApolloProdCookie,
  saveLukeCookie,
  saveBaigeCookie,
  savePaodingCookie,
  saveCloudCookie,
  saveFeciCookie,
  saveShipwrightCookie,
  saveSearchCookie,
  saveFastCookie,
  saveUcCookie,
  saveArmsCookie,
  saveArmsApiKey,
  saveOnesCookie
} from '../common/credentials.js';
import { saveDinsightCredentials } from '../common/dinsight.js';
import { getBrowserCookies, cookiesToHeader } from '../credential_relay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const HTML_FILE = path.join(__dirname, 'index.html');
const CI_DEPLOY = path.join(SCRIPTS_DIR, 'ci_deploy.js');
const STATE_FILE = path.join(SHRIMP_DIR, 'deploy_ui_state.json');
const JOB_DIR = path.join(SHRIMP_DIR, 'deploy_jobs');

export const SESSION_CSRF_TOKEN = randomBytes(24).toString('hex');

/**
 * 计算控制台代码指纹（SHA-1 前 12 位），用于幂等启动时判定运行中实例是否需要自动重启
 */
export function computeBuildId(scriptsDir = SCRIPTS_DIR) {
  const hash = createHash('sha1');
  const files = [
    path.join(scriptsDir, 'deploy_web.js'),
    path.join(scriptsDir, 'web_console', 'server.js'),
    path.join(scriptsDir, 'web_console', 'index.html')
  ];
  const commonDir = path.join(scriptsDir, 'common');
  try {
    const names = fs.readdirSync(commonDir).filter(f => f.endsWith('.js')).sort();
    for (const name of names) files.push(path.join(commonDir, name));
  } catch {}
  for (const file of files) {
    try {
      hash.update(path.relative(scriptsDir, file));
      hash.update('\0');
      hash.update(fs.readFileSync(file));
      hash.update('\0');
    } catch {}
  }
  return hash.digest('hex').slice(0, 12);
}

export const BUILD_ID = computeBuildId();

// ---------------------------------------------------------------- state ----

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { branches: {}, repos: {} };
  }
}

function saveState(st) {
  fs.mkdirSync(SHRIMP_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const state = loadState();
if (!state.branches) state.branches = {};
if (!state.repos) state.repos = {};

// ------------------------------------------------------------ branches ----

const branchCache = new Map();

async function listBranchesCached(repoPath, force = false) {
  const cached = branchCache.get(repoPath);
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.branches;
  const branches = await listRemoteBranches(repoPath);
  branchCache.set(repoPath, { at: Date.now(), branches });
  return branches;
}

async function latestRemoteBranch(repoPath) {
  const res = await git(repoPath, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin']);
  if (res.code !== 0) return '';
  return res.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/^origin\//, ''))
    .filter(n => n !== 'HEAD' && !/^qa/i.test(n) && !/^master$/i.test(n) && !/^main$/i.test(n))[0] || '';
}

async function currentBranch(repoPath) {
  const res = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (res.code !== 0) return '';
  const name = res.stdout.trim();
  return name && name !== 'HEAD' ? name : '';
}

// ----------------------------------------------------------------- jobs ----

let activeJob = null;
const jobs = new Map();

export function isValidJobId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function jobFile(id) {
  if (!isValidJobId(id)) throw new Error('非法的任务 ID');
  return path.join(JOB_DIR, `${id}.json`);
}

function persistJob(job, force = false) {
  const now = Date.now();
  if (!force && job._lastPersist && now - job._lastPersist < 1500) return;
  job._lastPersist = now;
  try {
    fs.mkdirSync(JOB_DIR, { recursive: true });
    const data = { ...job };
    delete data._lastPersist;
    const target = jobFile(job.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  } catch {}
}

function loadPersistedJob(id) {
  if (!isValidJobId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export const MODE_LABEL = {
  merge_deploy: '合并并部署',
  merge_only: '仅合并',
  deploy_dev: '直接部署开发分支（不合并）',
  build_deploy: '仅构建部署',
  build_only: '仅构建',
  preview: '仅预演合并'
};

function listPersistedJobs(limit = 20) {
  let names = [];
  try { names = fs.readdirSync(JOB_DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOB_DIR, name), 'utf8'));
      out.push({
        id: j.id,
        project: j.project,
        devBranch: j.devBranch,
        qaBranch: j.qaBranch,
        mode: j.mode,
        modeLabel: MODE_LABEL[j.mode] || j.mode,
        status: j.status,
        error: j.error,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt
      });
    } catch {}
  }
  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return out.slice(0, limit);
}

function newJob(payload) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    ...payload,
    status: 'running',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null
  };
  jobs.set(id, job);
  activeJob = job;
  persistJob(job, true);
  if (jobs.size > 20) {
    const oldest = [...jobs.keys()][0];
    if (jobs.get(oldest)?.status !== 'running') jobs.delete(oldest);
  }
  return job;
}

function log(job, text) {
  job.log += text.endsWith('\n') ? text : text + '\n';
  if (job.log.length > 300_000) job.log = job.log.slice(-300_000);
  persistJob(job);
}

function runStreaming(job, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    log(job, `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { const s = d.toString(); stdout += s; log(job, s.replace(/\n$/, '')); });
    child.stderr.on('data', d => { const s = d.toString(); stderr += s; log(job, s.replace(/\n$/, '')); });
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function executeDeployJob(job, project, devBranch, qaBranch, mode) {
  const serviceId = resolveAppId(project);
  const needMerge = mode === 'merge_deploy' || mode === 'merge_only' || mode === 'preview';

  let repoPath = null;
  if (needMerge) {
    const repoInfo = await detectProjectRepo(project, state.repos);
    repoPath = repoInfo.repoPath;
    if (!repoPath) {
      throw new Error(`未找到项目 [${project}] 的 Git 仓库，请先在页面上设置仓库路径或确认 Shipwright 登录态`);
    }
    log(job, `📁 仓库路径: ${repoPath}`);
    log(job, `🌿 开发分支: ${devBranch}`);
    log(job, `🎯 QA 分支: ${qaBranch}`);
    log(job, `🧭 执行模式: ${MODE_LABEL[mode] || mode}`);

    await mergeBranchIntoQa({
      repoPath,
      devBranch,
      qaBranch,
      preview: mode === 'preview',
      onLog: msg => log(job, msg)
    });

    if (mode === 'preview') {
      return { serviceId, repoPath, preview: true };
    }
    if (mode === 'merge_only') {
      log(job, '\n✅ 仅合并模式完成，未触发构建部署。');
      return { serviceId, repoPath, imageAddress: null, recordId: null };
    }
  }

  log(job, '\n========== 触发 CI 构建并部署测试环境 ==========');
  const buildBranch = mode === 'deploy_dev' ? devBranch : qaBranch;
  if (!buildBranch) throw new Error('缺少构建目标分支');
  if (mode === 'deploy_dev') log(job, `ℹ️ 直接构建部署开发分支: ${buildBranch}`);
  const args = [CI_DEPLOY, serviceId, '-b', buildBranch];
  if (mode === 'build_only') args.push('--build-only');
  const res = await runStreaming(job, process.execPath, args, { cwd: SKILL_ROOT });
  if (res.code !== 0) {
    throw new Error('CI 构建或部署失败，请查看上方日志。\n若日志出现「无法获取构建器」，通常是 shipwright.ke.com 登录态过期，请到「凭据」Tab 刷新。');
  }

  const imageMatch = res.stdout.match(/产物镜像[:：]\s*(\S+)/) || res.stdout.match(/上线镜像[:：]\s*(\S+)/);
  return {
    serviceId,
    repoPath,
    imageAddress: imageMatch ? imageMatch[1] : null
  };
}

export function validateDeployParams({ project, devBranch, qaBranch, mode }) {
  if (!project) throw new Error('缺少项目参数');
  const needMerge = mode === 'merge_deploy' || mode === 'merge_only' || mode === 'preview';
  if (needMerge && (!devBranch || !qaBranch)) {
    throw new Error('合并模式需要同时选择开发分支与 QA 分支');
  }
  if (mode === 'deploy_dev' && !devBranch) {
    throw new Error('直接部署开发分支模式需要选择开发分支');
  }
  if ((mode === 'build_deploy' || mode === 'build_only') && !qaBranch && !devBranch) {
    throw new Error('请选择要构建的目标分支');
  }
}

async function startJob({ project, devBranch, qaBranch, mode }) {
  validateDeployParams({ project, devBranch, qaBranch, mode });
  if (activeJob && activeJob.status === 'running') throw new Error('已有部署任务正在执行，请等待完成');

  const effectiveQa = qaBranch || devBranch;
  const job = newJob({ project, devBranch, qaBranch: effectiveQa, mode, conflictStrategy: 'strict' });
  saveState(state);

  executeDeployJob(job, project, devBranch, effectiveQa, mode)
    .then(result => {
      job.status = 'success';
      job.result = result;
      job.finishedAt = new Date().toISOString();
      log(job, '\n🎉 全部完成！');
    })
    .catch(err => {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      log(job, `\n❌ 执行失败: ${err.message}`);
    })
    .finally(() => { activeJob = null; persistJob(job, true); });

  return job;
}

// ------------------------------------------------------------ credentials ----

async function probeCredential(file, url, init = {}, cookieOverride = null) {
  let cred;
  let cookie = String(cookieOverride || '').trim();
  if (!cookie) {
    try {
      cred = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { ok: false, message: '未保存凭据' };
    }
    cookie = cred.cookie || '';
  }
  const updatedAt = (cred && cred.updated_at) || null;
  if (!cookie) return { ok: false, message: '未保存凭据', updatedAt };
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `登录态已失效 (HTTP ${res.status})`, updatedAt };
    }
    if (/\/login|passport|\/sso/i.test(res.url || '')) {
      return { ok: false, message: '登录态已失效（被重定向到登录页）', updatedAt };
    }
    if (/"code"\s*:\s*(401|403)\b/.test(text)) {
      return { ok: false, message: '登录态已失效（接口返回未登录）', updatedAt };
    }
    if (/location\.(replace|href)\s*[=(]\s*["'][^"']*(login|passport|sso)/i.test(text) || /not_authenticated/i.test(text)) {
      return { ok: false, message: '登录态已失效（页面跳转登录）', updatedAt };
    }
    if (/ke-passport/i.test(text) || /<title>[^<]*(登录|login|KeOnes)/i.test(text)) {
      return { ok: false, message: '登录态已失效（被重定向到登录页或 SPA 外壳）', updatedAt };
    }
    if (!res.ok) return { ok: false, message: `请求异常 HTTP ${res.status}`, updatedAt };
    return { ok: true, message: '正常', updatedAt };
  } catch (err) {
    return { ok: false, message: '请求失败: ' + err.message, updatedAt };
  }
}

async function checkCiCredentials() {
  const [shipwright, cloud] = await Promise.all([
    probeCredential(
      path.join(SHRIMP_DIR, 'shipwright_cookie.json'),
      'https://shipwright.ke.com/workflow-context/v1/workflows/query?pageNumber=1&pageSize=1',
      { method: 'POST', body: JSON.stringify({ pageNumber: 1, pageSize: 1 }) }
    ),
    probeCredential(
      path.join(SHRIMP_DIR, 'cloud_token.json'),
      'https://cloud.intra.ke.com/apis/ci/v1/deployment/images/self-check?pageNumber=1&pageSize=1',
      { method: 'GET' }
    )
  ]);
  return { shipwright, cloud };
}

export const CREDENTIALS = [
  {
    id: 'shipwright', label: 'Shipwright 构建平台', group: '构建部署',
    file: 'shipwright_cookie.json', env: 'SHIPWRIGHT_COOKIE', url: 'https://shipwright.ke.com/',
    save: header => saveShipwrightCookie(header),
    probe: { url: 'https://shipwright.ke.com/workflow-context/v1/workflows/query?pageNumber=1&pageSize=1', init: { method: 'POST', body: JSON.stringify({ pageNumber: 1, pageSize: 1 }) } },
    note: '失效表现：部署时报「无法获取构建器」'
  },
  {
    id: 'cloud', label: '服务云 / CI 平台', group: '构建部署',
    file: 'cloud_token.json', env: 'CLOUD_COOKIE', url: 'https://cloud.intra.ke.com/',
    save: header => saveCloudCookie(header),
    probe: { url: 'https://cloud.intra.ke.com/apis/ci/v1/deployment/images/self-check?pageNumber=1&pageSize=1', init: { method: 'GET' } },
    note: '失效表现：镜像自检查询、下发部署失败'
  },
  {
    id: 'feci', label: 'FeCI 前端流水线', group: '构建部署',
    file: 'feci_cookie.json', env: 'FECI_COOKIE', url: 'https://feci-next.ke.com/',
    save: header => saveFeciCookie(header),
    probe: { url: 'https://feci-next.ke.com/', init: { method: 'GET' } },
    note: '失效表现：feci_deploy.js 触发前端构建失败'
  },
  {
    id: 'apollo_test', label: 'Apollo Portal（测试）', group: '配置中心',
    file: 'test_apollo_cookie.json', env: 'APOLLO_TEST_COOKIE', url: 'http://test-apollo.portal.life.ke.com/',
    save: header => saveApolloTestCookie(header),
    probe: { url: 'http://test-apollo.portal.life.ke.com/', init: { method: 'GET' } },
    note: '失效表现：测试环境配置查询 / 改值发布报登录失败'
  },
  {
    id: 'apollo_prod', label: 'Apollo Portal（生产）', group: '配置中心',
    file: 'apollo_cookie.json', env: 'APOLLO_PROD_COOKIE', url: 'http://apollo.portal.life.ke.com/',
    save: header => saveApolloProdCookie(header),
    probe: { url: 'http://apollo.portal.life.ke.com/', init: { method: 'GET' } },
    note: '仅用于生产配置只读速查'
  },
  {
    id: 'luke_test', label: 'Luke 权限中心（测试）', group: '权限与网关',
    file: 'test_luke_cookie.json', env: 'LUKE_TEST_COOKIE', url: 'https://test-luke.ke.com',
    save: header => saveLukeCookie({ env: 'test', cookieStr: header }),
    probe: { url: 'https://test-luke.ke.com', init: { method: 'GET' } },
    note: '失效表现：luke_query.js / luke_modify.js 报无权限或登录失败'
  },
  {
    id: 'luke_prod', label: 'Luke 权限中心（生产）', group: '权限与网关',
    file: 'luke_cookie.json', env: 'LUKE_PROD_COOKIE', url: 'https://luke.ke.com',
    save: header => saveLukeCookie({ env: 'prod', cookieStr: header }),
    probe: { url: 'https://luke.ke.com', init: { method: 'GET' } },
    note: '仅用于生产权限只读排查'
  },
  {
    id: 'baige_test', label: '白鸽网关（测试）', group: '权限与网关',
    file: 'test_baige_cookie.json', env: 'BAIGE_TEST_COOKIE', url: 'http://life-fe-baige-node.offline-beta.ttb.test.ke.com',
    save: header => saveBaigeCookie({ env: 'test', cookieStr: header }),
    probe: { url: 'http://life-fe-baige-node.offline-beta.ttb.test.ke.com', init: { method: 'GET' } },
    note: '失效表现：网关服务 / 路由查询失败'
  },
  {
    id: 'baige_preview', label: '白鸽网关（预发）', group: '权限与网关',
    file: 'prev_baige_cookie.json', env: 'BAIGE_PREVIEW_COOKIE', url: 'http://preview.baige.ke.com',
    save: header => saveBaigeCookie({ env: 'preview', cookieStr: header }),
    probe: { url: 'http://preview.baige.ke.com', init: { method: 'GET' } },
    note: '三环境对照时的预发侧登录态'
  },
  {
    id: 'baige_prod', label: '白鸽网关（生产）', group: '权限与网关',
    file: 'baige_cookie.json', env: 'BAIGE_PROD_COOKIE', url: 'https://baige.ke.com',
    save: header => saveBaigeCookie({ env: 'prod', cookieStr: header }),
    probe: { url: 'https://baige.ke.com', init: { method: 'GET' } },
    note: '仅用于生产网关只读排查'
  },
  {
    id: 'uc_test', label: 'UC 组织管理中心（测试）', group: '权限与网关',
    file: 'test_uc_cookie.json', env: 'UC_TEST_COOKIE', url: 'http://test3-uc.admin.ke.com/',
    save: header => saveUcCookie({ env: 'test', cookieStr: header }),
    probe: {
      url: 'http://test3-uc.admin.ke.com/graphql',
      init: { method: 'POST', body: JSON.stringify({ query: '{__typename}' }) }
    },
    note: 'UC 线上暂未接入，只有测试环境'
  },
  {
    id: 'search', label: '搜索云 ES 平台', group: '数据查询',
    file: 'search_cookie.json', env: 'SEARCH_COOKIE', url: 'https://search.ke.com/',
    save: header => saveSearchCookie(header),
    probe: {
      url: 'https://search.ke.com/ajax/createApp/getAppList',
      init: { method: 'POST', body: JSON.stringify({ page: 1, size: 1, auth: true, serviceId: '' }) }
    },
    note: '失效表现：es_query.js 查索引/文档失败'
  },
  {
    id: 'fast', label: 'FAST 日志平台', group: '数据查询',
    file: 'fast_cookie.json', env: 'FAST_COOKIE', url: 'https://fast.ke.com/',
    save: header => saveFastCookie(header),
    probe: { url: 'https://fast.ke.com/', init: { method: 'GET' } },
    note: '失效表现：生产日志检索 / TraceId 回溯失败'
  },
  {
    id: 'paoding', label: 'Paoding Loki 日志', group: '数据查询',
    file: 'paoding_cookie.json', env: 'PAODING_COOKIE', url: 'https://paoding.ke.com/',
    save: header => savePaodingCookie(header),
    probe: {
      url: 'https://paoding.ke.com/api/ds/query?ds_type=loki',
      init: { method: 'POST', body: JSON.stringify({ queries: [], from: 'now-1m', to: 'now' }) }
    },
    note: '失效表现：测试环境容器日志查不到'
  },
  {
    id: 'arms', label: '灯塔 ARMS（Cookie）', group: '数据查询',
    file: 'arms_cookie.json', env: 'ARMS_COOKIE', url: 'http://arms.fee.lianjia.com/',
    save: header => saveArmsCookie(header),
    probe: { url: 'http://arms.fee.lianjia.com/', init: { method: 'GET' } },
    note: '前端监控异常榜 / ViewId 还原用'
  },
  {
    id: 'dinsight', label: 'Dinsight 查数', group: '数据查询',
    file: 'dinsight_cookie.json', env: 'DINSIGHT_COOKIE', url: 'https://api-dinsight.ke.com',
    loginUrl: 'https://dinsight.ke.com/',
    names: ['prd-assistant-token-prod', 'csrf_token', 'access_token', 'login_ucid', 'security_ticket'],
    save: header => saveDinsightCredentials(header),
    probe: { url: 'https://api-dinsight.ke.com/api/v1/auth/me', init: { method: 'GET' } },
    note: '只保留 token / csrf 等关键字段'
  },
  {
    id: 'arms_api_key', label: '灯塔 ARMS（API Key）', group: '数据查询',
    file: 'arms_api_key.json', env: 'ARMS_API_KEY', url: '', kind: 'apikey',
    save: value => saveArmsApiKey(value),
    note: 'API Key 无法从浏览器读取，只能手动粘贴'
  },
  {
    id: 'ones', label: 'ONES 研发管理平台', group: '研发协作',
    file: 'ones_cookie.json', env: 'ONES_COOKIE', url: 'https://ones.ke.com/',
    names: ['ones_ke_token', 'session_id', 'csrfSecret', 'login_ucid', 'ucid', 'lianjia_ssid', 'lianjia_uuid'],
    save: header => saveOnesCookie(header),
    probe: { url: 'https://ones.ke.com/api/minepage/get_counts?quick_check=allaboutme', init: { method: 'GET' } },
    note: '失效表现：ones_query.js 报登录态失效 / 返回前端页面'
  }
];

function credentialById(id) {
  return CREDENTIALS.find(c => c.id === id) || null;
}

function describeCredential(def) {
  const file = path.join(SHRIMP_DIR, def.file);
  const loginUrl = def.loginUrl || def.url || '';
  const out = {
    id: def.id, label: def.label, group: def.group, file: def.file,
    url: def.url, loginUrl, note: def.note || '', kind: def.kind || 'cookie',
    env: def.env, exists: false, updatedAt: null, names: [], count: 0,
    envOverride: Boolean(def.env && process.env[def.env]), probeSupported: Boolean(def.probe)
  };
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  out.exists = true;
  try {
    const stat = fs.statSync(file);
    out.bytes = stat.size;
    out.updatedAt = stat.mtime.toISOString();
  } catch {}
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (data && typeof data === 'object') {
    if (data.updated_at) out.updatedAt = data.updated_at;
    const header = [];
    if (typeof data.cookie === 'string' && data.cookie.trim()) header.push(data.cookie);
    if (typeof data.token === 'string') header.push(`token=${data.token}`);
    if (typeof data.apiKey === 'string') header.push(`apiKey=${data.apiKey}`);
    const names = new Set();
    for (const chunk of header) {
      for (const part of chunk.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) names.add(part.slice(0, eq).trim());
      }
    }
    out.names = [...names].filter(Boolean);
    out.count = out.names.length;
  }
  return out;
}

function listCredentials() {
  const groups = [...new Set(CREDENTIALS.map(c => c.group))];
  return {
    items: CREDENTIALS.map(describeCredential),
    groups,
    dir: SHRIMP_DIR
  };
}

/**
 * 单次静默读取浏览器 Cookie + 探活落盘（不做 3 秒高频轮询，避免触发 SSO 风控；
 * 未登录时返回 needLogin: true 与 loginUrl，由前端打开新标签页并在用户焦点切回时触发单次同步）
 */
async function refreshCredentialOnce({ id }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  if (def.kind === 'apikey') throw Object.assign(new Error('API Key 无法从浏览器读取，请手动粘贴保存'), { status: 400 });
  if (!def.url) throw Object.assign(new Error('该凭据没有可访问的站点地址'), { status: 400 });

  const loginUrl = `${new URL(def.loginUrl || def.url).origin}/`;
  let cookies = null;
  let relayError = null;
  try {
    cookies = await getBrowserCookies({ url: def.url, names: def.names, timeoutMs: 15000 });
  } catch (err) {
    relayError = err;
  }

  if (cookies && cookies.length) {
    const header = cookiesToHeader(cookies);
    let verified = true;
    if (def.probe) {
      try {
        verified = Boolean((await probeCredentialById({ id: def.id, cookieOverride: header })).ok);
      } catch {
        verified = true;
      }
    }
    if (verified) {
      if (!def.save(header)) throw Object.assign(new Error('读取成功但写入本地凭据文件失败'), { status: 500 });
      return {
        ok: true,
        needLogin: false,
        verified: def.probe ? true : null,
        message: `已同步 ${cookies.length} 个 Cookie 并落盘${def.probe ? '，探活正常' : ''}`,
        def: describeCredential(def)
      };
    }
  }

  if (relayError && ['RELAY_TIMEOUT', 'RELAY_BUSY', 'EXTENSION_OUTDATED'].includes(relayError.code)) {
    return {
      ok: false,
      needLogin: false,
      code: relayError.code,
      message: relayError.message,
      def: describeCredential(def)
    };
  }

  return {
    ok: false,
    needLogin: true,
    loginUrl,
    code: 'LOGIN_REQUIRED',
    message: `未检测到有效登录态，已在新标签页打开 ${loginUrl}；登录完成后切回本页面将自动同步落盘。`,
    def: describeCredential(def)
  };
}

function saveCredentialManually({ id, value }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error('凭据内容为空'), { status: 400 });
  if (def.kind === 'apikey') {
    if (!def.save(text)) throw Object.assign(new Error('写入失败'), { status: 500 });
    return { ok: true, message: 'API Key 已保存', def: describeCredential(def) };
  }
  let header = text;
  if (def.id === 'dinsight') {
    if (!def.save(text)) throw Object.assign(new Error('内容里没有可识别的 token / cookie'), { status: 400 });
    return { ok: true, message: 'Dinsight 凭据已保存', def: describeCredential(def) };
  }
  if (text.includes('\t')) {
    const kvs = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      const parts = line.replace(/^#HttpOnly_/, '').trimEnd().split('\t');
      if (parts.length === 7) kvs.push(`${parts[5]}=${parts[6]}`);
    }
    if (!kvs.length) throw Object.assign(new Error('没能从 cookies.txt 里解析出 cookie'), { status: 400 });
    header = kvs.join('; ');
  } else if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      header = String(data.cookie || data.token || '').trim();
    } catch {}
    if (!header) throw Object.assign(new Error('JSON 里没有 cookie 或 token 字段'), { status: 400 });
  }
  if (!def.save(header)) throw Object.assign(new Error('写入本地凭据文件失败'), { status: 500 });
  return { ok: true, message: '凭据已保存', def: describeCredential(def) };
}

function clearCredential({ id }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  const file = path.join(SHRIMP_DIR, def.file);
  try { fs.unlinkSync(file); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: true, message: '已清除本地凭据文件', def: describeCredential(def) };
}

async function probeCredentialById({ id, cookieOverride = null }) {
  const def = credentialById(id);
  if (!def) throw Object.assign(new Error('未知凭据 id'), { status: 400 });
  if (!def.probe) return { ok: false, message: '该凭据不支持探活' };
  return probeCredential(path.join(SHRIMP_DIR, def.file), def.probe.url, def.probe.init, cookieOverride);
}

// ------------------------------------------------------ http & security ----

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

/**
 * 校验本地请求安全性（防外部网页跨站 CSRF 攻击与 DNS Rebinding）
 */
export function verifyLocalRequestSecurity(req, csrfToken = SESSION_CSRF_TOKEN) {
  const host = String(req.headers?.host || '').toLowerCase();
  if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    return { ok: false, status: 403, error: 'Forbidden Host' };
  }
  if (req.method === 'POST') {
    const origin = String(req.headers?.origin || '').toLowerCase();
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return { ok: false, status: 403, error: 'Forbidden Origin' };
    }
    const token = req.headers?.['x-leo-token'];
    if (csrfToken && token !== csrfToken) {
      return { ok: false, status: 403, error: 'Invalid or missing X-Leo-Token' };
    }
  }
  return { ok: true };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

const SCRIPTS = {
  testLog: path.join(SCRIPTS_DIR, 'test_log_query.js'),
  fastLog: path.join(SCRIPTS_DIR, 'fast_query.js'),
  apolloQuery: path.join(SCRIPTS_DIR, 'apollo_query.js'),
  apolloHistory: path.join(SCRIPTS_DIR, 'apollo_history.js'),
  apolloModify: path.join(SCRIPTS_DIR, 'apollo_modify.js'),
  esModify: path.join(SCRIPTS_DIR, 'es_modify.js'),
  kafkaSend: path.join(SCRIPTS_DIR, 'kafka_send.js'),
  mysqlQuery: path.join(SCRIPTS_DIR, 'test_mysql_query.js'),
  onesQuery: path.join(SCRIPTS_DIR, 'ones_query.js'),
  onesModify: path.join(SCRIPTS_DIR, 'ones_modify.js')
};

function runScript(script, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: SKILL_ROOT,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, code: -1, stdout, stderr: stderr + `\n[超时 ${Math.round(timeoutMs / 1000)}s，已终止]`, json: null });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + err.message, json: null });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr, json: extractJson(stdout) });
    });
  });
}

export function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== '{' && s[start] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

function listAppItems() {
  const catalog = loadServiceCatalog();
  const out = [];
  for (const key of Object.keys(catalog)) {
    if (key.includes(':')) continue;
    out.push(key);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

function scriptResult(res, r, okText) {
  if (!r.ok && !r.json) {
    return json(res, 200, {
      ok: false,
      error: (r.stderr || r.stdout || '').trim() || `脚本退出码 ${r.code}`,
      stdout: r.stdout,
      stderr: r.stderr
    });
  }
  const failed = r.json && (r.json.error || r.json.success === false);
  return json(res, 200, {
    ok: !failed && r.ok,
    json: r.json,
    stdout: r.stdout,
    stderr: r.stderr,
    message: okText || ''
  });
}

export function buildHtmlPage() {
  const rawHtml = fs.readFileSync(HTML_FILE, 'utf8');
  const projects = listUniversalProjects().map(p => {
    const repo = String(p.git || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
    const tag = p.ci ? (p.deploy ? '· 可构建部署' : '· 仅构建') : '· 自动嗅探 CI';
    return { id: p.id, display: `${p.id}${repo ? '　' + repo : ''}　${tag}`, git: p.git || '', note: p.note || '' };
  });
  const appItems = listAppItems();
  return rawHtml
    .replace('__LEO_CSRF_TOKEN__', JSON.stringify(SESSION_CSRF_TOKEN))
    .replace('__LEO_PROJECT_ITEMS__', JSON.stringify(projects).replace(/</g, '\\u003c'))
    .replace('__LEO_APP_ITEMS__', JSON.stringify(appItems).replace(/</g, '\\u003c'));
}

export function createDeployWebServer() {
  return http.createServer(async (req, res) => {
    try {
      const sec = verifyLocalRequestSecurity(req);
      if (!sec.ok) return json(res, sec.status, { error: sec.error });

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const route = url.pathname;

      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        const html = buildHtmlPage();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && route === '/api/initial') {
        const lastProject = state.lastProject || Object.keys(state.branches)[0] || '';
        return json(res, 200, { lastProject, buildId: BUILD_ID, pid: process.pid });
      }

      if (req.method === 'GET' && route === '/api/apps') {
        return json(res, 200, { apps: listAppItems() });
      }

      if (req.method === 'GET' && route === '/api/projects') {
        return json(res, 200, { projects: listUniversalProjects() });
      }

      if (req.method === 'GET' && route === '/api/state') {
        const project = url.searchParams.get('project') || '';
        const repoInfo = await detectProjectRepo(project, state.repos);
        const { repoPath, gitUrl, repoMode, cloneError } = repoInfo;
        const branches = repoPath ? await listBranchesCached(repoPath).catch(() => []) : [];
        const remembered = state.branches[project] || {};
        const cur = repoPath ? await currentBranch(repoPath) : '';
        const ciMeta = getServiceCiDeployMeta(project);
        const qaDefault = pickDefaultQaBranch(branches, remembered.qaBranch, ciMeta?.ci?.defaultBranch || '');
        const curUsable = cur && !/^(master|main)$/i.test(cur) ? cur : '';
        const devDefault = remembered.devBranch || curUsable || (repoPath ? await latestRemoteBranch(repoPath) : '') || '';
        return json(res, 200, {
          project,
          repoPath,
          gitUrl,
          repoMode,
          cloneError,
          currentBranch: cur,
          devBranch: devDefault,
          qaBranch: qaDefault,
          branches
        });
      }

      if (req.method === 'POST' && route === '/api/state') {
        const body = await readBody(req);
        const project = (body.project || '').trim();
        if (!project) return json(res, 400, { error: '缺少 project' });
        state.branches[project] = {
          devBranch: (body.devBranch || '').trim(),
          qaBranch: (body.qaBranch || '').trim()
        };
        state.lastProject = project;
        saveState(state);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/repo') {
        const body = await readBody(req);
        const project = (body.project || '').trim();
        const repoPath = (body.path || '').trim();
        if (!project) return json(res, 400, { error: '缺少 project' });
        if (!repoPath) {
          delete state.repos[project];
          saveState(state);
          const detected = await detectProjectRepo(project, state.repos);
          return json(res, 200, { ok: true, repoPath: detected.repoPath });
        }
        if (!fs.existsSync(path.join(repoPath, '.git'))) {
          return json(res, 400, { error: '该路径不是有效的 Git 仓库（缺少 .git）' });
        }
        state.repos[project] = repoPath;
        saveState(state);
        branchCache.delete(repoPath);
        return json(res, 200, { ok: true, repoPath });
      }

      if (req.method === 'GET' && route === '/api/branches') {
        const project = url.searchParams.get('project') || '';
        const force = url.searchParams.get('force') === '1';
        const { repoPath } = await detectProjectRepo(project, state.repos);
        if (!repoPath) return json(res, 200, { project, repoPath: null, branches: [] });
        const branches = await listBranchesCached(repoPath, force);
        return json(res, 200, { project, repoPath, branches });
      }

      if (req.method === 'POST' && route === '/api/deploy') {
        const body = await readBody(req);
        const project = (body.project || '').trim();
        const devBranch = (body.devBranch || '').trim();
        const qaBranch = (body.qaBranch || '').trim();
        const mode = body.mode || 'merge_deploy';

        if (project) {
          state.branches[project] = { devBranch, qaBranch };
          state.lastProject = project;
          saveState(state);
        }
        const job = await startJob({ project, devBranch, qaBranch, mode });
        return json(res, 200, { id: job.id, status: job.status });
      }

      if (req.method === 'GET' && route === '/api/jobs') {
        return json(res, 200, { jobs: listPersistedJobs() });
      }

      if (req.method === 'GET' && route === '/api/credential-list') {
        return json(res, 200, listCredentials());
      }

      if (req.method === 'POST' && route === '/api/credential/refresh') {
        const b = await readBody(req);
        const r = await refreshCredentialOnce({ id: b.id });
        return json(res, 200, r);
      }

      if (req.method === 'POST' && route === '/api/credential/save') {
        const b = await readBody(req);
        return json(res, 200, saveCredentialManually({ id: b.id, value: b.value }));
      }

      if (req.method === 'POST' && route === '/api/credential/clear') {
        const b = await readBody(req);
        return json(res, 200, clearCredential({ id: b.id }));
      }

      if (req.method === 'POST' && route === '/api/credential/probe') {
        const b = await readBody(req);
        return json(res, 200, await probeCredentialById({ id: b.id }));
      }

      if (req.method === 'GET' && route === '/api/credentials') {
        return json(res, 200, await checkCiCredentials());
      }

      if (req.method === 'GET' && route === '/api/job') {
        const id = url.searchParams.get('id');
        if (!isValidJobId(id)) return json(res, 400, { error: '非法的任务 ID' });
        const job = jobs.get(id) || loadPersistedJob(id);
        if (!job) return json(res, 404, { error: '任务不存在' });
        return json(res, 200, {
          id: job.id,
          project: job.project,
          devBranch: job.devBranch,
          qaBranch: job.qaBranch,
          mode: job.mode,
          conflictStrategy: job.conflictStrategy,
          status: job.status,
          log: job.log,
          error: job.error,
          result: job.result,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt
        });
      }

      if (req.method === 'POST' && route === '/api/verify') {
        const b = await readBody(req);
        const project = (b.project || '').trim();
        const minutes = (b.minutes || '10m').trim();
        if (!project) return json(res, 400, { error: '缺少 project' });
        if (!/^\d{1,3}[mh]$/.test(minutes)) return json(res, 400, { error: '时间窗格式应为 15m / 1h' });
        const r = await runScript(SCRIPTS.testLog, [project, '--level', 'ERROR', '-t', minutes, '-n', '30', '--format', 'json']);
        return scriptResult(res, r);
      }

      if (req.method === 'POST' && route === '/api/logs') {
        const b = await readBody(req);
        const source = b.source === 'prod' ? 'prod' : 'test';
        const app = (b.app || '').trim();
        if (!app) return json(res, 400, { error: '缺少服务名' });
        const time = (b.time || '1h').trim();
        if (!/^\d{1,3}[mhd]$/.test(time)) return json(res, 400, { error: '时间窗格式应为 15m / 1h / 7d' });
        const size = String(Math.min(Math.max(parseInt(b.size, 10) || 20, 1), 200));
        const level = (b.level || '').toUpperCase();
        const query = (b.query || '').trim();
        if (level && !['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level)) return json(res, 400, { error: '日志级别不合法' });

        if (source === 'test') {
          const args = [app, '-t', time, '-n', size, '--format', 'json'];
          if (level) args.push('--level', level);
          if (query) args.push('-q', query);
          return scriptResult(res, await runScript(SCRIPTS.testLog, args));
        }
        const args = ['-a', app, '-t', time, '-n', size, '--format', 'json', '-e', 'prod'];
        if (level) args.push('--level', level);
        if (query) args.push('-q', query);
        return scriptResult(res, await runScript(SCRIPTS.fastLog, args));
      }

      if (req.method === 'POST' && route === '/api/apollo/query') {
        const b = await readBody(req);
        const app = (b.app || '').trim();
        const env = (b.env || 'test').toLowerCase();
        if (!app) return json(res, 400, { error: '缺少服务名' });
        if (!['test', 'preview', 'pre', 'prod'].includes(env)) return json(res, 400, { error: '环境不合法' });
        const keyword = (b.keyword || '').trim();
        const args = [app];
        if (keyword) args.push(keyword);
        args.push('-e', env, '--json');
        return scriptResult(res, await runScript(SCRIPTS.apolloQuery, args));
      }

      if (req.method === 'POST' && route === '/api/apollo/history') {
        const b = await readBody(req);
        const app = (b.app || '').trim();
        const key = (b.key || '').trim();
        const env = (b.env || 'test').toLowerCase();
        if (!app || !key) return json(res, 400, { error: '缺少服务名或配置项 key' });
        if (!['test', 'preview', 'pre', 'prod'].includes(env)) return json(res, 400, { error: '环境不合法' });
        return scriptResult(res, await runScript(SCRIPTS.apolloHistory, [app, key, '-e', env, '--json']));
      }

      if (req.method === 'POST' && route === '/api/write/apollo') {
        const b = await readBody(req);
        const app = (b.app || '').trim();
        const key = (b.key || '').trim();
        const value = b.value === undefined || b.value === null ? '' : String(b.value);
        if (!app || !key) return json(res, 400, { error: '缺少服务名或配置项 key' });
        if (value === '') return json(res, 400, { error: '缺少新的值' });
        const type = ['switch', 'change', 'degrade'].includes(b.type) ? b.type : 'switch';
        const args = [app];
        const ns = (b.namespace || '').trim();
        if (ns) args.push(ns);
        args.push(key, value, '--env', 'TEST', '--type', type);
        const comment = (b.comment || '').trim();
        if (comment) args.push('--comment', comment);
        if (b.confirm === true) args.push('--confirm');
        const r = await runScript(SCRIPTS.apolloModify, args, 180_000);
        return scriptResult(res, r, b.confirm === true ? '已提交并发布' : '预检完成');
      }

      // ------------------------------------------------------- ONES 研发协作 ----
      // ONES 是协作系统（无测试环境），不受「生产只读」约束；但写入仍走两阶段：
      // confirm=false 只跑 Dry-Run 出 Diff，confirm=true 才带 --confirm 落库。
      if (req.method === 'POST' && route === '/api/ones/query') {
        const b = await readBody(req);
        const cmd = (b.cmd || '').trim();
        const args = [];
        if (cmd === 'schedule') {
          args.push('schedule');
          if (b.from) args.push('--from', String(b.from));
          if (b.to) args.push('--to', String(b.to));
        } else if (cmd === 'manhour') {
          args.push('manhour');
          if (b.from) args.push('--from', String(b.from));
          if (b.to) args.push('--to', String(b.to));
          if (b.all === true) args.push('--all');
        } else if (cmd === 'req') {
          const key = (b.key || '').trim();
          if (!key) return json(res, 400, { error: '缺少需求 ID 或标题关键词' });
          args.push('req', key);
          if (b.limit) args.push('--limit', String(b.limit));
        } else if (cmd === 'reqs') {
          args.push('reqs');
          const sprint = (b.sprint || '').trim();
          const pm = (b.pm || '').trim();
          const title = (b.title || '').trim();
          const level = (b.level || '').trim();
          if (!sprint && !pm && !title && !level) return json(res, 400, { error: '至少填一个过滤条件' });
          if (sprint) args.push('--sprint', sprint);
          if (pm) args.push('--pm', pm);
          if (title) args.push('--title', title);
          if (level) args.push('--level', level);
          if (b.limit) args.push('--limit', String(b.limit));
        } else if (cmd === 'bugs') {
          args.push('bugs');
          if (b.id) args.push('--id', String(b.id));
          if (b.resolver) args.push('--resolver', String(b.resolver));
          if (b.summary) args.push('--summary', String(b.summary));
          if (b.requireId) args.push('--require-id', String(b.requireId));
          args.push('--limit', String(b.limit || 10));
        } else if (cmd === 'iterations') {
          args.push('iterations');
          if (b.keyword) args.push(String(b.keyword));
        } else if (cmd === 'projects') {
          args.push('projects');
          if (b.keyword) args.push(String(b.keyword));
        } else {
          return json(res, 400, { error: '不支持的 ONES 查询命令' });
        }
        args.push('--json');
        return scriptResult(res, await runScript(SCRIPTS.onesQuery, args));
      }

      if (req.method === 'POST' && route === '/api/ones/write') {
        const b = await readBody(req);
        const cmd = (b.cmd || '').trim();
        const confirm = b.confirm === true;
        const args = [];
        const push = (flag, val) => {
          if (val !== undefined && val !== null && String(val).trim() !== '') {
            args.push(flag, String(val).trim());
          }
        };

        if (cmd === 'create-req') {
          if (!String(b.title || '').trim()) return json(res, 400, { error: '缺少需求标题' });
          if (!String(b.level || '').trim()) return json(res, 400, { error: '缺少层级' });
          if (!String(b.pm || '').trim()) return json(res, 400, { error: '缺少产品经理' });
          args.push('create-req');
          push('--title', b.title);
          push('--level', b.level);
          push('--project', b.project);
          push('--pm', b.pm);
          push('--sprint', b.sprint);
          push('--priority', b.priority);
          push('--type', b.type);
          push('--desc', b.desc);
          if (b.withSafetyFunc !== false) args.push('--with-safety-func');
        } else if (cmd === 'create-bug') {
          if (!String(b.summary || '').trim()) return json(res, 400, { error: '缺少缺陷标题' });
          if (!String(b.resolver || '').trim()) return json(res, 400, { error: '缺少处理人' });
          args.push('create-bug');
          push('--summary', b.summary);
          push('--resolver', b.resolver);
          push('--require-id', b.requireId);
          push('--priority', b.priority);
          push('--type', b.type);
          push('--find-way', b.findWay);
          push('--desc', b.desc);
          push('--man-hour', b.manHour);
          push('--level', b.level);
        } else if (cmd === 'schedule') {
          if (!String(b.id || '').trim()) return json(res, 400, { error: '缺少需求 ID' });
          args.push('schedule', String(b.id).trim());
          push('--develop-start', b.developStart);
          push('--develop-end', b.developEnd);
          push('--test-start', b.testStart);
          push('--test-end', b.testEnd);
          push('--submit-test', b.submitTest);
          push('--online', b.online);
        } else if (cmd === 'move') {
          if (!String(b.ids || '').trim()) return json(res, 400, { error: '缺少需求 ID' });
          if (!String(b.sprint || '').trim()) return json(res, 400, { error: '缺少目标迭代' });
          args.push('move', String(b.ids).trim());
          push('--sprint', b.sprint);
        } else if (cmd === 'advance') {
          if (!String(b.id || '').trim()) return json(res, 400, { error: '缺少 ID' });
          if (!String(b.event || '').trim()) return json(res, 400, { error: '缺少流转事件' });
          args.push('advance', String(b.id).trim());
          push('--event', b.event);
          if (b.kind === 'bug') args.push('--kind', 'bug');
        } else {
          return json(res, 400, { error: '不支持的 ONES 写命令' });
        }

        if (confirm) args.push('--confirm');
        const r = await runScript(SCRIPTS.onesModify, args, 180_000);
        return scriptResult(res, r, confirm ? '已提交' : '预检完成');
      }

      if (req.method === 'POST' && route === '/api/write/es') {
        const b = await readBody(req);
        const service = (b.service || '').trim();
        const action = (b.action || '').trim();
        const id = String(b.id || '').trim();
        if (!service || !id) return json(res, 400, { error: '缺少索引或文档 ID' });
        if (!['update-part', 'update', 'insert', 'delete'].includes(action)) return json(res, 400, { error: '动作不合法' });
        const args = [service, '--action', action, '--id', id, '-e', 'test'];
        const data = b.data === undefined || b.data === null ? '' : String(b.data).trim();
        if (action !== 'delete') {
          if (!data) return json(res, 400, { error: '缺少写入数据 JSON' });
          try { JSON.parse(data); } catch { return json(res, 400, { error: '写入数据不是合法 JSON' }); }
          args.push('--data', data);
        }
        if (b.confirm === true) args.push('--confirm');
        const r = await runScript(SCRIPTS.esModify, args, 180_000);
        return scriptResult(res, r, b.confirm === true ? '已写入' : '预检完成');
      }

      if (req.method === 'POST' && route === '/api/write/kafka') {
        const b = await readBody(req);
        const topic = (b.topic || '').trim();
        if (!topic) return json(res, 400, { error: '缺少 topic' });
        const data = b.data === undefined || b.data === null ? '' : String(b.data).trim();
        const sets = Array.isArray(b.sets) ? b.sets.map(s => String(s).trim()).filter(Boolean) : [];
        if (!data && !sets.length) return json(res, 400, { error: '缺少消息体，或填写 sample 覆盖字段' });
        if (data) {
          try { JSON.parse(data); } catch { return json(res, 400, { error: '消息体不是合法 JSON' }); }
        }
        if (b.confirm !== true) {
          return json(res, 200, {
            ok: true,
            json: {
              mode: 'preflight',
              env: 'test',
              topic,
              key: (b.key || '').trim() || null,
              useSample: sets.length > 0,
              sets,
              messageBody: data ? JSON.parse(data) : null,
              note: 'Kafka 无原生 Dry-Run：确认后才会真正投递到测试集群'
            },
            stdout: '',
            stderr: ''
          });
        }
        const args = ['-t', topic, '-e', 'test'];
        if (data) args.push('-d', data);
        if (sets.length) args.push('--use-sample');
        for (const s of sets) args.push('-s', s);
        const key = (b.key || '').trim();
        if (key) args.push('-k', key);
        const r = await runScript(SCRIPTS.kafkaSend, args, 120_000);
        return scriptResult(res, r, '已投递');
      }

      if (req.method === 'POST' && route === '/api/write/mysql') {
        const b = await readBody(req);
        const service = (b.service || '').trim();
        const sql = (b.sql || '').trim();
        if (!service || !sql) return json(res, 400, { error: '缺少服务或 SQL' });
        if (/;\s*\S/.test(sql.replace(/;\s*$/, ''))) return json(res, 400, { error: '一次只能执行一条 SQL 语句' });
        const isRead = /^(select|show|desc|describe|explain)\b/i.test(sql);
        const ds = (b.datasource || '').trim();
        const args = [service];
        if (ds) args.push(ds);
        args.push(sql, '--json');
        if (!isRead && b.confirm !== true) {
          return json(res, 200, {
            ok: true,
            json: {
              mode: 'preflight',
              env: 'test',
              operationType: /^(insert|replace)\b/i.test(sql) ? 'INSERT' : (/^(delete)\b/i.test(sql) ? 'DELETE' : 'UPDATE'),
              sql,
              note: '预检只做语法与参数确认，不会执行；确认后才会真正写入测试库'
            },
            stdout: '',
            stderr: ''
          });
        }
        const r = await runScript(SCRIPTS.mysqlQuery, args, 120_000);
        return scriptResult(res, r, isRead ? '查询完成' : '已执行');
      }

      json(res, 404, { error: 'Not Found' });
    } catch (err) {
      json(res, err.status || 500, { error: err.message });
    }
  });
}

function pidFile(port) {
  return path.join(SHRIMP_DIR, `console-${port}.pid`);
}

function writePidFile(port) {
  try {
    fs.mkdirSync(SHRIMP_DIR, { recursive: true });
    fs.writeFileSync(pidFile(port), JSON.stringify({ pid: process.pid, port, buildId: BUILD_ID, startedAt: new Date().toISOString() }));
  } catch {}
}

function removePidFile(port) {
  try {
    const raw = fs.readFileSync(pidFile(port), 'utf8');
    const data = JSON.parse(raw);
    if (!data?.pid || data.pid === process.pid) fs.unlinkSync(pidFile(port));
  } catch {}
}

export async function probeConsole(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${port}/api/initial`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return { running: false };
    const data = await res.json();
    if (!data || typeof data !== 'object' || !('lastProject' in data)) return { running: false };
    return {
      running: true,
      buildId: data.buildId || null,
      pid: data.pid || null,
      lastProject: data.lastProject || ''
    };
  } catch {
    return { running: false };
  }
}

async function stopExistingConsole(port, host = '127.0.0.1') {
  const probe = await probeConsole(port, host);
  let targetPid = probe.pid;
  if (!targetPid) {
    try {
      const saved = JSON.parse(fs.readFileSync(pidFile(port), 'utf8'));
      targetPid = saved?.pid || null;
    } catch {}
  }
  if (!probe.running && !targetPid) {
    try { fs.unlinkSync(pidFile(port)); } catch {}
    return { stopped: false, reason: 'not_running' };
  }
  if (targetPid && targetPid !== process.pid) {
    try { process.kill(targetPid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const check = await probeConsole(port, host);
      if (!check.running) break;
      await new Promise(r => setTimeout(r, 120));
    }
    const afterTerm = await probeConsole(port, host);
    if (afterTerm.running) {
      try { process.kill(targetPid, 'SIGKILL'); } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
  }
  try { fs.unlinkSync(pidFile(port)); } catch {}
  return { stopped: true, pid: targetPid };
}

function openBrowserUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(opener, process.platform === 'win32' ? ['', url] : [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

export async function startDeployWebConsole(argv = process.argv.slice(2)) {
  const portIdx = argv.findIndex(a => a === '--port' || a === '-p');
  const port = portIdx !== -1 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : 6886;
  const host = '127.0.0.1';
  const url = `http://${host}:${port}`;
  const wantOpen = argv.includes('--open') && !argv.includes('--no-open');
  const wantRestart = argv.includes('--restart');
  const wantStop = argv.includes('--stop');
  const wantJson = argv.includes('--json');

  if (wantStop) {
    const res = await stopExistingConsole(port, host);
    if (wantJson) {
      console.log(JSON.stringify({ ok: true, action: res.stopped ? 'stopped' : 'not_running', port, pid: res.pid || null }));
    } else if (res.stopped) {
      console.log(`🛑 已停止控制台（端口 ${port}${res.pid ? `，PID ${res.pid}` : ''}）`);
    } else {
      console.log(`ℹ️ 端口 ${port} 上没有正在运行的控制台`);
    }
    return null;
  }

  const probe = await probeConsole(port, host);
  if (probe.running) {
    if (!wantRestart && probe.buildId === BUILD_ID) {
      if (wantJson) {
        console.log(JSON.stringify({ ok: true, action: 'reused', url, port, pid: probe.pid, buildId: BUILD_ID }));
      } else {
        console.log(`\n♻️ 控制台已在运行（版本一致 ${BUILD_ID}，直接复用）`);
        console.log(`   URL: ${url}  (PID: ${probe.pid || '未知'})\n`);
      }
      if (wantOpen) openBrowserUrl(url);
      return null;
    }
    if (!wantJson) {
      console.log(wantRestart
        ? `🔄 正在重启端口 ${port} 上的控制台（旧 PID: ${probe.pid || '未知'}）…`
        : `🔄 检测到控制台代码已更新（运行中 ${probe.buildId || '旧版'} → 当前 ${BUILD_ID}），正在自动重启…`);
    }
    await stopExistingConsole(port, host);
  }

  const server = createDeployWebServer();

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口 ${port} 已被占用。可能非控制台进程占用了该端口，或使用 --port <其它端口>。\n`);
      process.exit(1);
    }
    console.error('服务异常:', err.message);
    process.exit(1);
  });

  server.listen(port, host, () => {
    writePidFile(port);
    try {
      const html = buildHtmlPage();
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      if (!blocks.length) throw new Error('页面里找不到任何内联脚本');
      blocks.forEach((code, i) => {
        try {
          new Function(code); // eslint-disable-line no-new-func
        } catch (err) {
          throw new Error(`第 ${i + 1} 个脚本块解析失败: ${err.message}`);
        }
      });
      if (!wantJson) console.log(`\n✅ 页面脚本自检通过（${blocks.length} 个脚本块 · buildId=${BUILD_ID}）`);
    } catch (err) {
      console.error(`\n❌ 页面脚本自检失败（页面可能无法正常使用）: ${err.message}`);
    }
    if (wantJson) {
      console.log(JSON.stringify({ ok: true, action: probe.running ? 'restarted' : 'started', url, port, pid: process.pid, buildId: BUILD_ID }));
    } else {
      console.log(`\n🌐 Leo Live Inspector 测试环境部署控制台已启动`);
      console.log(`   URL: ${url}`);
      console.log(`   提示: 仅在测试环境执行「合并 QA 分支 + 构建部署」，生产环境物理只读。`);
      console.log(`   按 Ctrl+C 停止服务。\n`);
    }
    if (wantOpen) openBrowserUrl(url);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      removePidFile(port);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
  return server;
}
