#!/usr/bin/env node

/**
 * 🚀 Leo Live Inspector - 贝壳前端 CI/CD 平台 (FeCI / 青蝉 cicada) 通用构建与部署引擎
 * 
 * 核心设计：
 *   1. 【全工程通用 (Zero-Hardcoding)】：绝不绑定单一项目，适用于公司所有前端工程 (IOT, JZ, ZK, HT 等)；
 *   2. 【零配置自适应与自学习 (Auto-Discovery & Self-Learning)】：
 *      - 自动从本地 Git 仓库探测前端微服务名与当前分支；
 *      - 自动通过 FeCI 检索 API (GET /api/job/list) 动态嗅探匹配 Job ID；
 *      - 成功后自动沉淀至 ~/.shrimp/skills/live-inspector/feci_catalog.json，越用越快；
 *   3. 【全流程闭环自动化】：
 *      - 任务详情查询 (GET /api/job/detail)；
 *      - 触发流水线构建 (POST /api/build/start)；
 *      - 实时轮询构建日志与终态 (GET /api/build/list, /api/build/recordsLogs)；
 *      - 提取静态资源上传 CDN 与 Nginx 服务端部署结果 (GET /api/build/recordsProduct)；
 *   4. 【多维度调试与搜索】：支持 --search 关键词搜索全平台任务，--list 查看历史版本。
 */

import https from 'node:https';
import { createCredentialSession, isLoginFailure } from './common/browser_credentials.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { URL } from 'node:url';
import { loadFeciCookie, saveFeciCookie, loadCloudCookie, saveCloudCookie, loadShipwrightCookie, saveShipwrightCookie } from './common/credentials.js';
import { getFeciJobMeta, saveFeciJobMeta } from './common/services.js';

const FECI_HOST = 'https://feci-next.ke.com';


const credentialSessions = new Map();
async function doRequest(urlStr, options = {}, ignoredCookie = '') {
  const url = new URL(urlStr.startsWith('http') ? urlStr : `${FECI_HOST}${urlStr}`);
  let session = credentialSessions.get(url.origin);
  if (!session) {
    const configs = {
      'https://cloud.intra.ke.com': {load:loadCloudCookie, save:saveCloudCookie, explicit:Boolean(process.env.CLOUD_COOKIE)},
      'https://shipwright.ke.com': {load:loadShipwrightCookie, save:saveShipwrightCookie, explicit:Boolean(process.env.SHIPWRIGHT_COOKIE)},
      'https://feci-next.ke.com': {load:loadFeciCookie, save:saveFeciCookie, explicit:Boolean(process.env.FECI_COOKIE), isAuthFailure:r=>isLoginFailure(r) || r.json?.code===4000}
    };
    if (!configs[url.origin]) throw new Error('不支持的凭据目标站点');
    session = createCredentialSession(configs[url.origin]);
    credentialSessions.set(url.origin, session);
  }
  const method = options.method || (options.body ? 'POST' : 'GET');
  const readOnly = method === 'GET' || (method === 'POST' && /^\/apis\/cloud-application\/list\/virtual-service\/integration\/record(?:\/[^/]+)?$/.test(url.pathname));
  return session.run(url.href, cookie => rawDoRequest(url.href,options,cookie), {readOnly});
}

// ---------------- 基础 HTTP 请求封装 ----------------

function rawDoRequest(urlStr, options = {}, cookie = '') {
  return new Promise((resolve) => {
    const url = new URL(urlStr.startsWith('http') ? urlStr : `${FECI_HOST}${urlStr}`);
    const postBody = options.body;
    const bodyStr = postBody
      ? (typeof postBody === 'string' ? postBody : JSON.stringify(postBody))
      : null;

    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
      ...(cookie ? { 'Cookie': cookie } : {}),
      ...(options.headers || {})
    };

    if (bodyStr) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json;charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: options.method || (bodyStr ? 'POST' : 'GET'),
      headers,
      timeout: options.timeout || 15000
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          data: json !== null ? json : raw,
          json,
          raw
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 504, error: 'Request Timeout (15s)' });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 500, error: err.message });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------- 凭证缺失与过期引导 ----------------

function printCredentialGuide(reason = '未配置登录凭证') {
  console.log(`\n❌ 【FeCI / 青蝉平台凭证错误】: ${reason}`);
  console.log(`💡 FeCI 平台构建与部署需要独立登录态凭证 (feci-next.ke.com)`);
  console.log(`\n🔑 【请任选一种方式快速配置】:`);
  console.log(`1. 命令行快速写入:`);
  console.log(`   node scripts/feci_deploy.js --set-cookie "<完整的 Cookie 字符串>"`);
  console.log(`2. 浏览器开发者工具 (F12) 手动获取:`);
  console.log(`   在已登录的 https://feci-next.ke.com 页面按 F12 ➜ Network ➜ 复制任意接口的 Cookie 标头。`);
  console.log(`3. Chrome 扩展一键导出:`);
  console.log(`   在页面点击 "Leo cookie.txt Locally" 扩展 ➜ 下载 cookies.txt (放置在 ~/Downloads 自动识别)。\n`);
}

// ---------------- 本地 Git 工程与分支自嗅探 ----------------

function detectLocalContext() {
  let detectedApp = null;
  let detectedBranch = null;

  try {
    const remoteUrl = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim();
    if (remoteUrl) {
      const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
      if (match) detectedApp = match[1];
    }
  } catch {}

  if (!detectedApp) {
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name) detectedApp = pkg.name;
      }
    } catch {}
  }

  if (!detectedApp) {
    detectedApp = path.basename(process.cwd());
  }

  try {
    detectedBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {}

  return { detectedApp, detectedBranch };
}

// ---------------- 动态任务检索与自适应解析 ----------------

async function searchJobs(keyword, cookie) {
  const queryUrl = `/api/job/list?name=${encodeURIComponent(keyword)}&page=1&pageSize=20`;
  const res = await doRequest(queryUrl, { method: 'GET' }, cookie);
  if (res.json?.code === 4000) {
    printCredentialGuide('未登录或登录会话已过期');
    process.exit(1);
  }
  return res.json?.data?.list || [];
}

async function resolveFeciJobId(target, cookie) {
  // 1. 如果传入的是纯数字 ID，直接使用并反查验证
  if (/^\d+$/.test(target)) {
    const id = Number(target);
    const detail = await getJobDetail(id, cookie);
    if (detail) {
      const appName = detail.name || `job-${id}`;
      saveFeciJobMeta(appName, { jobId: id, jobName: detail.name, gitUrl: detail.gitUrl });
    }
    return id;
  }

  const appName = target.trim();

  // 2. 检查本地持久化自学习缓存 (feci_catalog.json)
  const cachedMeta = getFeciJobMeta(appName);
  if (cachedMeta?.jobId) {
    console.log(`⚡ 命中本地自学习资产库: [${appName}] -> Job ID: ${cachedMeta.jobId} (${cachedMeta.jobName || '-'})`);
    return cachedMeta.jobId;
  }

  // 3. 动态调用平台 API 进行自适应嗅探
  console.log(`🔍 正在 FeCI 平台动态检索微服务 [${appName}] 对应的流水线任务...`);
  let list = await searchJobs(appName, cookie);

  // 如果带 -fe 搜不到，尝试去除 -fe 检索
  if ((!list || list.length === 0) && appName.endsWith('-fe')) {
    const stripped = appName.replace(/-fe$/, '');
    list = await searchJobs(stripped, cookie);
  }

  if (!list || list.length === 0) {
    throw new Error(`在 FeCI 平台未检索到与 [${appName}] 相关的构建任务，请使用 --search <关键词> 查询任务列表`);
  }

  // 4. 精准匹配候选：优先匹配 gitUrl 包含工程名的任务，其次匹配任务名称
  const exactGit = list.find(j => j.gitUrl && (j.gitUrl.includes(`/${appName}.git`) || j.gitUrl.includes(`/${appName}/`) || j.gitUrl.endsWith(`/${appName}`)));
  const exactName = list.find(j => j.name && j.name.toLowerCase() === appName.toLowerCase());
  const fuzzy = list[0];

  const matched = exactGit || exactName || fuzzy;

  console.log(`✅ 自动嗅探到目标流水线: ${matched.name} (Job ID: ${matched.id})`);
  console.log(`   代码仓库: ${matched.gitUrl || '-'}`);

  // 5. 静默沉淀至本地自学习缓存
  saveFeciJobMeta(appName, {
    jobId: matched.id,
    jobName: matched.name,
    gitUrl: matched.gitUrl
  });

  return matched.id;
}

// ---------------- FeCI API 业务接口 ----------------

async function getJobDetail(jobId, cookie) {
  const res = await doRequest(`/api/job/detail?id=${jobId}`, { method: 'GET' }, cookie);
  if (res.json?.code === 4000) {
    printCredentialGuide('未登录或登录会话已过期');
    process.exit(1);
  }
  if (res.json?.code !== 0 && res.json?.code !== 200) {
    throw new Error(`获取任务详情失败: ${res.json?.msg || JSON.stringify(res.data)}`);
  }
  return res.json.data;
}

async function listBuildRecords(jobId, cookie, page = 1, pageSize = 5) {
  const res = await doRequest(`/api/build/list?id=${jobId}&page=${page}&pageSize=${pageSize}`, { method: 'GET' }, cookie);
  if (res.json?.code === 4000) {
    printCredentialGuide('未登录或登录会话已过期');
    process.exit(1);
  }
  return res.json?.data?.list || [];
}

async function triggerBuild(jobId, branch, cookie) {
  console.log(`\n📦 【步骤 1/2: 触发前端 FeCI 构建】`);
  console.log(`   任务 ID: ${jobId}`);
  console.log(`   目标分支: ${branch}`);

  const res = await doRequest(`/api/build/start`, {
    method: 'POST',
    body: { id: Number(jobId), branch }
  }, cookie);

  if (res.json?.code === 4000) {
    printCredentialGuide('未登录或登录会话已过期');
    process.exit(1);
  }

  if (res.json?.code !== 0 && res.json?.code !== 200) {
    throw new Error(`触发构建失败: ${res.json?.msg || JSON.stringify(res.data)}`);
  }

  console.log(`   ✅ 构建指令已下发成功! (${res.json?.msg || '开始构建'})`);
  return res.json.data;
}

async function pollBuildUntilComplete(jobId, branch, cookie, timeoutMs = 600000, intervalMs = 5000, previousLatestId = null) {
  console.log(`\n⏳ 【步骤 2/2: 轮询构建与发布状态】(超时限制: ${Math.round(timeoutMs/1000)}s)`);
  const startTime = Date.now();

  let targetRecordId = null;

  while (Date.now() - startTime < timeoutMs) {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`   [${elapsedSec}s] 检查构建状态... `);

    const records = await listBuildRecords(jobId, cookie, 1, 3);
    const latest = records[0];

    if (!latest) {
      console.log('未查到构建记录，稍后重试...');
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    if (!targetRecordId) {
      if (previousLatestId) {
        const newer = records.find(r => (r.id && r.id > previousLatestId) || (r.recordId && r.recordId !== previousLatestId));
        if (newer) {
          targetRecordId = newer.id || newer.recordId;
        } else {
          console.log('等待新构建任务入队...');
          await new Promise(r => setTimeout(r, intervalMs));
          continue;
        }
      } else {
        targetRecordId = latest.id || latest.recordId;
      }
    }

    const currentRecord = records.find(r => (r.recordId || r.id) === targetRecordId) || latest;
    const status = currentRecord.status || currentRecord.workflowInfo?.status?.runningStatus || currentRecord.state || 'RUNNING';
    const statusStr = currentRecord.statusText || currentRecord.statusStr || status;

    console.log(`记录: #${currentRecord.id || targetRecordId} | 状态: ${statusStr}`);

    if (status === 'SUCCESS' || status === 'success' || status === 2 || statusStr === '构建成功') {
      console.log(`   🎉 前端构建与部署成功完成! 总耗时: ${elapsedSec} 秒`);

      // 获取产物详情
      const recId = currentRecord.recordId || currentRecord.id;
      let productData = null;
      try {
        const productRes = await doRequest(`/api/build/recordsProduct?recordId=${recId}`, { method: 'GET' }, cookie);
        productData = productRes.json?.data;
      } catch {}

      return {
        status: 'SUCCESS',
        record: currentRecord,
        product: productData,
        elapsedSec
      };
    }

    if (status === 'FAILED' || status === 'FAIL' || status === 'ERROR' || status === 3 || statusStr === '构建失败') {
      throw new Error(`前端构建失败! 终态: ${statusStr} (详情查看: ${FECI_HOST}/jobDetail?id=${jobId})`);
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`构建超时 (${Math.round(timeoutMs/1000)} 秒) 未完成`);
}

// ---------------- 服务云交付中心 (Cloud Console Delivery) 前端发布执行器 ----------------

async function fetchCloudWorkloads(serviceId, envType, cookie) {
  const wlRes = await doRequest(`https://cloud.intra.ke.com/apis/cloud-application/app/${serviceId}/virtual-services?serviceId=${serviceId}&envType=${envType}`, {
    method: 'GET'
  }, cookie);

  if (wlRes.statusCode === 200 && wlRes.json?.code === 200000 && Array.isArray(wlRes.json.data)) {
    return wlRes.json.data;
  }
  return [];
}

async function fetchIntegrationRecords(serviceId, envType, cookie) {
  const recRes = await doRequest('https://cloud.intra.ke.com/apis/cloud-application/list/virtual-service/integration/record', {
    method: 'POST',
    body: {
      service_id: serviceId,
      page_size: 10,
      envtype: envType,
      page_number: 1
    }
  }, cookie);

  if (recRes.statusCode === 200 && recRes.json?.code === 200000 && Array.isArray(recRes.json.data?.list)) {
    return recRes.json.data.list;
  }
  return [];
}

async function fetchRecordDetail(recordId, cookie) {
  const detailRes = await doRequest(`https://cloud.intra.ke.com/apis/cloud-application/list/virtual-service/integration/record/${recordId}`, {
    method: 'POST',
    body: {}
  }, cookie);

  if (detailRes.statusCode === 200 && detailRes.json?.code === 200000 && detailRes.json.data) {
    return detailRes.json.data;
  }
  return null;
}

async function fetchCdnModules(serviceId, envType, cookie) {
  const envKey = envType === 'test' ? 'testing' : 'staging';
  const cdnRes = await doRequest(`https://cloud.intra.ke.com/cloud-proxy-api/resource_instance/cdn_path/slave_search/list_by_service_id?current_page=1&page_size=10&path=&environment=${envKey}&service_id=${serviceId}`, {
    method: 'GET'
  }, cookie);

  if (cdnRes.statusCode === 200 && Array.isArray(cdnRes.json?.data?.list)) {
    return cdnRes.json.data.list.map(item => ({
      module: `${item.cdn_domain}/${item.path}`,
      path: item.path
    }));
  }
  return [];
}

async function deployFrontendToCloudConsole({
  serviceId,
  envType = 'test',
  targetCommitId = null,
  targetRecordId = null,
  cloudCookie = null
}) {
  console.log(`\n🚀 【步骤: 服务云交付中心自动化发布】`);
  console.log(`   目标微服务: ${serviceId}`);
  console.log(`   目标环境: ${envType}`);

  const cookie = cloudCookie || loadCloudCookie();


  // 1. 获取工作负载
  console.log(`   🔍 正在查询服务 [${serviceId}] 的 [${envType}] 工作负载...`);
  let workloads = await fetchCloudWorkloads(serviceId, envType, cookie);
  if (workloads.length === 0 && serviceId.endsWith('-fe')) {
    const stripped = serviceId.replace(/-fe$/, '');
    workloads = await fetchCloudWorkloads(stripped, envType, cookie);
  }

  const targetWl = workloads.find(w => w.envType === envType) || workloads[0];
  if (!targetWl) {
    throw new Error(`在服务云中未找到服务 [${serviceId}] 对应的 [${envType}] 工作负载`);
  }
  const workloadId = targetWl.id;
  const workloadName = targetWl.name || workloadId;
  console.log(`   ✅ 匹配到工作负载: ${workloadName} (${workloadId})`);

  // 2. 查询云平台 integration record
  console.log(`   🔍 正在检索服务云构建产物记录...`);
  const recordList = await fetchIntegrationRecords(serviceId, envType, cookie);
  if (!recordList || recordList.length === 0) {
    throw new Error(`未查询到服务 [${serviceId}] 在服务云的构建产物记录`);
  }

  let matchedRecord = null;
  if (targetRecordId) {
    matchedRecord = recordList.find(r => r.recordId === targetRecordId);
  }
  if (!matchedRecord && targetCommitId) {
    matchedRecord = recordList.find(r => r.commitId?.startsWith(targetCommitId) || targetCommitId.startsWith(r.commitId));
  }
  if (!matchedRecord) {
    matchedRecord = recordList[0];
  }

  console.log(`   ✅ 选取构建记录: #${matchedRecord.recordId} (Commit: ${matchedRecord.commitId?.slice(0, 8) || '-'})`);

  // 3. 查询单条记录产物详情
  const product = await fetchRecordDetail(matchedRecord.recordId, cookie);
  if (!product) {
    throw new Error(`获取记录 [${matchedRecord.recordId}] 产物详情失败`);
  }
  console.log(`   🏷️  容器镜像: ${product.imageAddress || '无'}`);
  console.log(`   📦 静态资源: ${product.tarAddress ? '已生成 TAR' : '无'}`);

  // 4. 查询静态资源 CDN 模块配置
  let cdnApplyParams = [];
  if (product.cdnApply) {
    console.log(`   🔍 正在匹配静态资源 CDN 映射...`);
    const cdnList = await fetchCdnModules(serviceId, envType, cookie);
    if (cdnList.length > 0) {
      cdnApplyParams = cdnList.slice(0, 1);
      console.log(`   🌐 绑定 CDN 模块: ${cdnApplyParams[0].module}`);
    }
  }

  // 5. 下发 Delivery Task 发布指令
  console.log(`   🚀 正在向服务云下发【创建发布任务】指令...`);
  const deliveryPayload = {
    serviceId,
    envType,
    recordId: matchedRecord.recordId,
    envName: workloadId,
    deploymentApply: product.deploymentApply !== false,
    cdnApply: product.cdnApply !== false && cdnApplyParams.length > 0,
    cdn_apply_params: cdnApplyParams,
    imageAddress: product.imageAddress,
    tarAddress: product.tarAddress
  };

  const deliverRes = await doRequest(`https://cloud.intra.ke.com/apis/cloud-application/app/${serviceId}/virtual-service/delivery`, {
    method: 'PUT',
    body: deliveryPayload
  }, cookie);

  if (deliverRes.statusCode !== 200 || deliverRes.json?.code !== 200000) {
    throw new Error(`服务云下发发布失败: ${deliverRes.json?.message || JSON.stringify(deliverRes.data)}`);
  }

  const deliveryTaskId = deliverRes.json.data?.workflow_id || '-';
  console.log(`   ✅ 发布任务已创建! 交付流水线 ID: ${deliveryTaskId}`);

  // 6. 实时轮询发布进度
  console.log(`   ⏳ 正在轮询服务云交付任务执行进度...`);
  const pollStart = Date.now();
  const timeoutMs = 300000;
  let finalStatus = null;

  while (Date.now() - pollStart < timeoutMs) {
    const elapsedSec = Math.round((Date.now() - pollStart) / 1000);
    const statusRes = await doRequest(`https://cloud.intra.ke.com/apis/cloud-application/app/${serviceId}/virtual-service/${workloadId}/delivery/status`, {
      method: 'GET'
    }, cookie);

    if (statusRes.statusCode === 200 && statusRes.json?.code === 200000 && statusRes.json.data?.status) {
      const statusObj = statusRes.json.data.status;
      const steps = statusObj.steps || [];
      const latest = steps[steps.length - 1];

      process.stdout.write(`\r   [${elapsedSec}s] 状态: ${statusObj.status} | 阶段: ${latest?.typeDisplay || '执行中'} (${latest?.phase || 'running'})    `);

      if (statusObj.finished || statusObj.status === 'succeeded') {
        console.log(`\n   🎉 服务云交付发布全部完成! 总耗时: ${elapsedSec} 秒`);
        steps.forEach(s => {
          console.log(`      ✔ [${s.typeDisplay}]: ${s.phase}`);
        });
        finalStatus = statusObj;
        break;
      }

      if (statusObj.status === 'failed') {
        console.log(`\n   ❌ 交付发布失败!`);
        throw new Error(`服务云交付失败: ${JSON.stringify(statusObj)}`);
      }
    }

    await new Promise(r => setTimeout(r, 4000));
  }

  if (!finalStatus) {
    throw new Error('服务云交付任务轮询超时 (300s)');
  }

  return {
    success: true,
    workloadId,
    workloadName,
    recordId: matchedRecord.recordId,
    imageAddress: product.imageAddress,
    deliveryTaskId
  };
}

// ---------------- 主入口函数 ----------------

async function main() {
  const args = process.argv.slice(2);

  // 0. 帮助说明
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`\n🚀 Leo Live Inspector - 贝壳前端 CI/CD 平台 (FeCI / 青蝉) 通用自动化构建部署引擎`);
    console.log(`用法: node scripts/feci_deploy.js [appName|jobId] [options]`);
    console.log(`\n选项:`);
    console.log(`  [appName|jobId]        目标前端项目名或 FeCI 任务 ID (默认自动从当前 Git 仓库识别)`);
    console.log(`  -b, --branch <branch>  构建的代码分支 (默认自动从当前 Git 分支提取)`);
    console.log(`  -e, --env <env>        目标部署环境类型 (默认: test, 严格拦截生产环境)`);
    console.log(`  -s, --search <keyword> 搜索 FeCI 平台上的所有任务`);
    console.log(`  -l, --list             列出当前任务的历史构建记录`);
    console.log(`  --dry-run              预检模式，打印任务配置与分支信息，不触发实际构建`);
    console.log(`  --deploy-only          跳过 FeCI 构建，直接提取最新构建记录部署至服务云测试工作负载`);
    console.log(`  --ci-only              仅执行 FeCI 流水线构建，不触发服务云工作负载部署`);
    console.log(`  --set-cookie "<str>"   保存 FeCI (feci-next.ke.com) Session Cookie 凭证至本地缓存`);
    console.log(`  --set-cloud-cookie "<str>" 保存服务云 (cloud.intra.ke.com) Session Cookie 凭证至本地缓存`);
    console.log(`  -h, --help             显示帮助信息`);
    console.log(`\n示例:`);
    console.log(`  # 在任意前端项目根目录下 0 参数全自动执行 (FeCI 构建 + 服务云工作负载与 CDN 部署):`);
    console.log(`  node scripts/feci_deploy.js`);
    console.log(`  # 指定项目与分支:`);
    console.log(`  node scripts/feci_deploy.js smart-customer-service-fe -b master`);
    console.log(`  # 仅部署最新镜像至服务云测试环境:`);
    console.log(`  node scripts/feci_deploy.js smart-customer-service-fe --deploy-only`);
    console.log(`  # 仅在 FeCI 构建不部署:`);
    console.log(`  node scripts/feci_deploy.js smart-customer-service-fe --ci-only\n`);
    process.exit(0);
  }

  // 1. 设置 Cookie
  const setCookieIdx = args.indexOf('--set-cookie');
  if (setCookieIdx !== -1) {
    const val = args[setCookieIdx + 1];
    if (!val) {
      console.log(`❌ 请提供 Cookie 字符串: node scripts/feci_deploy.js --set-cookie "<cookie>"`);
      process.exit(1);
    }
    saveFeciCookie(val);
    console.log(`✅ FeCI 凭证已成功保存至 ~/.shrimp/skills/live-inspector/feci_cookie.json`);
    process.exit(0);
  }

  const setCloudCookieIdx = args.indexOf('--set-cloud-cookie');
  if (setCloudCookieIdx !== -1) {
    const val = args[setCloudCookieIdx + 1];
    if (!val) {
      console.log(`❌ 请提供 Cookie 字符串: node scripts/feci_deploy.js --set-cloud-cookie "<cookie>"`);
      process.exit(1);
    }
    saveCloudCookie(val);
    console.log(`✅ 服务云凭证已成功保存至 ~/.shrimp/skills/live-inspector/cloud_token.json`);
    process.exit(0);
  }

  // 2. 环境参数与生产红线拦截
  const envIdx = args.findIndex(a => a === '-e' || a === '--env');
  const envType = envIdx !== -1 && args[envIdx + 1] ? args[envIdx + 1].toLowerCase() : 'test';

  if (envType === 'prod' || envType === 'production' || envType === 'online') {
    console.log(`\n🛑 【安全红线拦截】: 前端微服务禁止全自动部署到生产环境 (prod/online)!`);
    console.log(`💡 请在服务云交付中心通过标准生产审批流程发布:`);
    console.log(`   👉 https://cloud.intra.ke.com/console/project/cloud/application/delivery-list?envType=online\n`);
    process.exit(1);
  }

  const isDeployOnly = args.includes('--deploy-only');
  const isCiOnly = args.includes('--ci-only');
  const isList = args.includes('--list') || args.includes('-l');
  const isDryRun = args.includes('--dry-run');

  // 3. 解析目标与分支 (自嗅探)
  let rawTarget = args.find(a => !a.startsWith('-'));
  const { detectedApp, detectedBranch } = detectLocalContext();

  if (!rawTarget) {
    rawTarget = detectedApp;
    console.log(`📍 自动从本地环境识别前端项目: [${rawTarget}]`);
  }

  let branch = null;
  const branchIdx = args.findIndex(a => a === '-b' || a === '--branch');
  if (branchIdx !== -1 && args[branchIdx + 1]) branch = args[branchIdx + 1];
  if (!branch) {
    branch = detectedBranch || 'master';
    console.log(`🌿 自动从本地 Git 提取构建分支: [${branch}]`);
  }

  // 4. 若为纯部署模式 (--deploy-only)，直接下发服务云交付
  if (isDeployOnly) {
    if (isDryRun) {
      console.log(`\n📋 【Pre-flight 预检确认 (纯部署模式)】:`);
      console.log(`   - 前端项目: ${rawTarget}`);
      console.log(`   - 目标环境: ${envType}`);
      console.log(`   - 模式: 仅部署 (--deploy-only)，跳过 FeCI 构建`);
      console.log(`   ✅ 预检通过，参数均已就绪。\n`);
      process.exit(0);
    }

    const deployResult = await deployFrontendToCloudConsole({
      serviceId: rawTarget,
      envType,
      cloudCookie: loadCloudCookie()
    });

    console.log(`\n🎉 ================== 前端部署完成报告 ==================`);
    console.log(`微服务 ID: ${rawTarget}`);
    console.log(`部署环境: ${envType}`);
    console.log(`目标负载: ${deployResult?.workloadName} (${deployResult?.workloadId})`);
    console.log(`容器镜像: ${deployResult?.imageAddress}`);
    console.log(`交付任务 ID: ${deployResult?.deliveryTaskId}`);
    console.log(`服务云控制台: https://cloud.intra.ke.com/console/project/cloud/application/${rawTarget}/delivery-list?envType=${envType}`);
    console.log(`========================================================\n`);
    process.exit(0);
  }

  // 5. 读取 FeCI 凭证
  const cookie = loadFeciCookie();


  // 6. 搜索模式
  const searchIdx = args.findIndex(a => a === '-s' || a === '--search');
  if (searchIdx !== -1) {
    const keyword = args[searchIdx + 1] || '';
    if (!keyword) {
      console.log(`❌ 请指定搜索关键词: node scripts/feci_deploy.js --search <keyword>`);
      process.exit(1);
    }
    console.log(`🔍 正在检索 FeCI 平台任务: [${keyword}]...`);
    const results = await searchJobs(keyword, cookie);
    if (!results || results.length === 0) {
      console.log(`未找到与 [${keyword}] 相关的任务。`);
    } else {
      console.log(`\n📋 命中 ${results.length} 个任务:`);
      console.log(`| # | Job ID | 任务名称 | Git 仓库 | 默认分支 | 类型 |`);
      console.log(`|---|---|---|---|---|---|`);
      results.forEach((item, idx) => {
        console.log(`| ${idx + 1} | ${item.id} | ${item.name} | ${item.gitUrl || '-'} | ${item.branch || item.defaultBranch || 'master'} | ${item.type || '-'} |`);
      });
      console.log(``);
    }
    process.exit(0);
  }

  // 7. 动态探查并解析 Job ID
  const jobId = await resolveFeciJobId(rawTarget, cookie);

  // 8. 获取任务详情
  const jobDetail = await getJobDetail(jobId, cookie);
  const jobName = jobDetail.name || `Job #${jobId}`;
  const gitUrl = jobDetail.gitUrl || jobDetail.repository || '-';
  const buildType = jobDetail.buildType || jobDetail.envType || '-';

  if (isList) {
    const list = await listBuildRecords(jobId, cookie, 1, 5);
    console.log(`\n📋 [${jobName}] 最近构建记录:`);
    console.log(`| # | 记录 ID | 分支 | 状态 | 触发人 | 时间 |`);
    console.log(`|---|---|---|---|---|---|`);
    list.forEach((item, idx) => {
      const branchName = item.gitInfo?.branch || item.branch || '-';
      const creatorName = item.createdByUser?.displayName || item.createdByUser?.account || item.creator || '-';
      const timeStr = item.createdAt ? item.createdAt.replace('T', ' ').slice(0, 19) : '-';
      console.log(`| ${idx + 1} | #${item.id || item.recordId} | ${branchName} | ${item.status || '-'} | ${creatorName} | ${timeStr} |`);
    });
    console.log(``);
    process.exit(0);
  }

  if (isDryRun) {
    console.log(`\n📋 【Pre-flight 预检确认】:`);
    console.log(`   - 前端项目: ${rawTarget}`);
    console.log(`   - 任务名称: ${jobName}`);
    console.log(`   - 任务 ID: ${jobId}`);
    console.log(`   - 构建分支: ${branch}`);
    console.log(`   - 代码仓库: ${gitUrl}`);
    console.log(`   - 构建环境: ${buildType}`);
    console.log(`   - 自动部署: ${isCiOnly ? '否 (--ci-only)' : `是 -> 服务云 [${envType}] 环境`}`);
    console.log(`   ✅ 预检通过，参数均已就绪。\n`);
    process.exit(0);
  }

  // 9. 触发 FeCI 构建与轮询
  console.log(`\n======================================================`);
  console.log(`🚀 开始执行 [${jobName}] 前端全自动构建与发布流水线`);
  console.log(`   项目: ${rawTarget} | 任务 ID: ${jobId} | 分支: ${branch}`);
  console.log(`======================================================`);

  let previousLatestId = null;
  try {
    const existing = await listBuildRecords(jobId, cookie, 1, 1);
    if (existing && existing.length > 0) {
      previousLatestId = existing[0].id || existing[0].recordId;
    }
  } catch {}

  await triggerBuild(jobId, branch, cookie);
  const result = await pollBuildUntilComplete(jobId, branch, cookie, 600000, 5000, previousLatestId);

  // 10. 若未禁用部署，自动联动服务云交付中心下发工作负载更新
  let deployResult = null;
  if (!isCiOnly) {
    try {
      deployResult = await deployFrontendToCloudConsole({
        serviceId: rawTarget,
        envType,
        targetCommitId: result.record?.gitInfo?.commitId || result.record?.commitId,
        cloudCookie: loadCloudCookie()
      });
    } catch (deployErr) {
      console.log(`\n⚠️ 服务云自动部署未完成: ${deployErr.message}`);
      console.log(`💡 您也可以稍后通过手动指令重新触发部署:`);
      console.log(`   node scripts/feci_deploy.js ${rawTarget} --deploy-only\n`);
    }
  }

  // 11. 交付报告
  console.log(`\n🎉 ================== 前端全流程交付报告 ==================`);
  console.log(`前端微服务: ${rawTarget}`);
  console.log(`FeCI 任务: ${jobName} (Job ID: ${jobId})`);
  console.log(`构建分支: ${branch}`);
  console.log(`构建耗时: ${result.elapsedSec} 秒`);
  console.log(`FeCI 记录: #${result.record?.id || '-'}`);
  console.log(`构建状态: ${result.status}`);
  if (deployResult) {
    console.log(`服务云工作负载: ${deployResult.workloadName} (${deployResult.workloadId})`);
    console.log(`容器镜像: ${deployResult.imageAddress}`);
    console.log(`交付任务 ID: ${deployResult.deliveryTaskId}`);
  }
  console.log(`FeCI 平台直达: ${FECI_HOST}/jobDetail?id=${jobId}`);
  console.log(`服务云交付中心: https://cloud.intra.ke.com/console/project/cloud/application/${rawTarget}/delivery-list?envType=${envType}`);
  console.log(`========================================================\n`);
}

main().catch(err => {
  console.error(`\n❌ 执行异常: ${err.message}\n`);
  process.exit(1);
});

