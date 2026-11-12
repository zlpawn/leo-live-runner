#!/usr/bin/env node

/**
 * 📜 Leo Live Inspector - Apollo 配置项发布轨迹与版本追溯引擎 (Apollo Config Release History Tracker)
 * 
 * 核心功能：
 *   1. 秒级追溯任意配置项（Key）的历史发布轨迹与生命周期变更（新增、修改、删除）；
 *   2. 全环境支持：
 *      - 🔴 生产环境 (PROD):   直连 apollo.portal.life.ke.com (默认环境)
 *      - 🟡 测试环境 (TEST):   直连 test-apollo.portal.life.ke.com
 *      - 🟠 预发环境 (PREVIEW): 自适应探测 preview/prev 集群，无独立集群自动归入 PROD default 集群并对照 prev.config.apollo.ke.com 实时值；
 *   3. 智能 Namespace 自动嗅探定位：无需死记命名空间，自动跨 Namespace 精准定位 Key 归属；
 *   4. 时序 Diff 引擎：逐版本比对历次 Release Snapshot，提取变更人、变更时间、发布说明与新旧值对比；
 *   5. 状态闭环验证：自动拉取对应环境 ConfigService 当前实时生效值，进行双向比对核验；
 *   6. 凭证自愈与统一中继：复用 ~/.shrimp 凭证，失效自动触发本地 Chrome 扩展探针中继无感刷新。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveAppId, APOLLO_SERVERS } from './common/services.js';
import {
  SHRIMP_LIVE_DIR,
  loadApolloCookie,
  saveApolloCookie,
  loadApolloTestCookie,
  saveApolloTestCookie,
  loadApolloProdCookie,
  saveApolloProdCookie
} from './common/credentials.js';
import { createCredentialSession } from './common/browser_credentials.js';
import { getBrowserCookies } from './credential_relay.js';
import { requestHttp as rawRequestHttp } from './common/http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORTAL_HOSTS = {
  prod: 'apollo.portal.life.ke.com',
  production: 'apollo.portal.life.ke.com',
  preview: 'apollo.portal.life.ke.com',
  prev: 'apollo.portal.life.ke.com',
  pre: 'apollo.portal.life.ke.com',
  test: 'test-apollo.portal.life.ke.com',
  qa: 'test-apollo.portal.life.ke.com',
  dev: 'test-apollo.portal.life.ke.com'
};

const DEFAULT_DEPTH = 50;
const DEFAULT_PAGE_SIZE = 20;

function printUsage() {
  console.log(`
📜 Leo Apollo Config Release History Tracker (配置项发布轨迹追踪引擎)

用法:
  node scripts/apollo_history.js <appId|alias> [namespace] <key> [options]
  node scripts/apollo_history.js <appId|alias> <key> [options]

参数说明:
  <appId|alias>           微服务应用 ID 或业务别名 (如 iot, platform, saas, zulin-iot-platform)
  [namespace]             命名空间 (可选，未指定时自动全命名空间扫描定位)
  <key>                   待追溯发布轨迹的配置项键名 (如 lockAuth.noNeedRetryCode, rentButton)

选项 (Options):
  --env, -e <env>         目标环境 (可选: prod, test, preview/pre; 默认: prod)
  --cluster, -c <cluster> 指定集群名称 (默认: default; 预发环境自动探测 preview 集群)
  --depth, -n <depth>     最大扫描历史版本数量 (默认: 50; 范围: 10~200)
  --page-size, -s <size>  每次分页查询条数 (默认: 20; 范围: 5~50)
  --all                   展示扫描的所有发布版本 (默认仅展示该 key 发生变更的版本)
  --json                  以结构化 JSON 格式输出变更轨迹
  --cookie <str>          临时覆盖 Portal 请求使用的 Cookie 凭据
  --set-cookie <str>      保存更新 Cookie 凭证至本地缓存 (~/.shrimp)
  -h, --help              查看本帮助信息

示例:
  # 1. 查【线上生产】某个配置项的发布历史 (默认环境)
  node scripts/apollo_history.js iot lockAuth.noNeedRetryCode
  node scripts/apollo_history.js zulin-iot-platform rentButton

  # 2. 查【测试环境】某个配置项的发布轨迹
  node scripts/apollo_history.js iot liveRunner.access.ucIdWhitelist -e test

  # 3. 查【预发环境】某个配置项的发布轨迹 (自适应集群探测 + 预发实时值对照)
  node scripts/apollo_history.js zulin-iot-platform rentButton -e preview

  # 4. 回溯更深版本 (扫描最近 100 个发布版本)
  node scripts/apollo_history.js saas timeout -n 100
`);
}

function tryParseJson(str) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return str;
    }
  }
  return str;
}

function formatJsonValue(val, indent = 4) {
  if (val === undefined || val === null) return String(val);
  const parsed = tryParseJson(val);
  if (typeof parsed === 'object' && parsed !== null) {
    return JSON.stringify(parsed, null, 2)
      .split('\n')
      .map(line => ' '.repeat(indent) + line)
      .join('\n');
  }
  return String(val);
}

function formatTimestamp(raw) {
  if (!raw) return '-';
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    const pad = n => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return `${y}-${m}-${day} ${h}:${min}:${s}`;
  } catch {
    return String(raw);
  }
}

/**
 * 快速读取 ConfigService 获取当前实时配置快照 (毫秒级免鉴权)
 */
async function fetchConfigServiceLive(configServer, appId, cluster, namespace) {
  if (!configServer) return null;
  const url = `${configServer.replace(/\/+$/, '')}/configs/${encodeURIComponent(appId)}/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}`;
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          resolve(parsed?.configurations || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  let envInput = 'prod';
  let clusterInput = null;
  let depth = DEFAULT_DEPTH;
  let pageSize = DEFAULT_PAGE_SIZE;
  let showAllReleases = false;
  let outputJson = false;
  let customCookie = '';
  let setCookieArg = '';

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env' || a === '-e') {
      envInput = (argv[++i] || 'prod').toLowerCase();
    } else if (a === '--cluster' || a === '-c') {
      clusterInput = argv[++i];
    } else if (a === '--depth' || a === '-n') {
      depth = Math.max(1, Math.min(300, parseInt(argv[++i], 10) || DEFAULT_DEPTH));
    } else if (a === '--page-size' || a === '-s') {
      pageSize = Math.max(5, Math.min(100, parseInt(argv[++i], 10) || DEFAULT_PAGE_SIZE));
    } else if (a === '--all') {
      showAllReleases = true;
    } else if (a === '--json') {
      outputJson = true;
    } else if (a === '--cookie') {
      customCookie = argv[++i];
    } else if (a === '--set-cookie') {
      setCookieArg = argv[++i];
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  // 保存 Cookie 模式
  if (setCookieArg) {
    const isTest = ['test', 'qa', 'dev'].includes(envInput);
    if (isTest) {
      saveApolloTestCookie(setCookieArg);
      console.log(`✅ 已成功保存 Apollo 测试环境 Cookie 凭证至: ${path.join(SHRIMP_LIVE_DIR, 'test_apollo_cookie.json')}`);
    } else {
      saveApolloProdCookie(setCookieArg);
      console.log(`✅ 已成功保存 Apollo 生产/预发环境 Cookie 凭证至: ${path.join(SHRIMP_LIVE_DIR, 'apollo_cookie.json')}`);
    }
    process.exit(0);
  }

  if (positional.length < 2) {
    console.error(`❌ 参数不足！请至少提供 <appId> 和 <key>。`);
    printUsage();
    process.exit(1);
  }

  const inputApp = positional[0];
  let inputNamespace = '';
  let targetKey = '';

  if (positional.length === 2) {
    targetKey = positional[1];
  } else {
    inputNamespace = positional[1];
    targetKey = positional[2];
  }

  // 环境参数规范化
  const isTestEnv = ['test', 'qa', 'dev'].includes(envInput);
  const isPreviewEnv = ['preview', 'prev', 'pre', 'staging'].includes(envInput);
  const portalEnv = isTestEnv ? 'TEST' : 'PROD';
  const portalHost = PORTAL_HOSTS[envInput] || 'apollo.portal.life.ke.com';
  const configServer = APOLLO_SERVERS[envInput] || (isTestEnv ? APOLLO_SERVERS.test : APOLLO_SERVERS.prod);

  const envDisplayLabel = isPreviewEnv
    ? '🟠 预发环境 (PREVIEW)'
    : isTestEnv
      ? '🟡 测试环境 (TEST)'
      : '🔴 生产环境 (PROD)';

  const canonicalApp = resolveAppId(inputApp);

  // 初始化鉴权 Session
  const cookieGetter = () => customCookie || (isTestEnv ? loadApolloTestCookie() : loadApolloProdCookie());
  const cookieSaver = (c) => isTestEnv ? saveApolloTestCookie(c) : saveApolloProdCookie(c);

  const credentials = createCredentialSession({
    load: cookieGetter,
    save: cookieSaver,
    explicit: Boolean(customCookie || process.env.APOLLO_COOKIE || process.env.APOLLO_PROD_COOKIE || process.env.APOLLO_TEST_COOKIE),
    getCookies: (opts) => getBrowserCookies({ ...opts, timeoutMs: 30000 }),
    preflight: async ({ run }) => {
      const checkPath = `/apps/${encodeURIComponent(canonicalApp)}/envs/${portalEnv}/clusters/default/namespaces`;
      const checkUrl = `http://${portalHost}${checkPath}`;
      await run(checkUrl, async c => {
        return rawRequestHttp({
          hostname: portalHost,
          port: 80,
          path: checkPath,
          method: 'GET',
          headers: {
            Host: portalHost,
            Cookie: c,
            'User-Agent': 'Mozilla/5.0 (Leo-Live-Inspector)'
          }
        });
      }, { readOnly: true });
    }
  });

  async function requestPortal(path, body = null, method = 'GET') {
    const url = `http://${portalHost}${path}`;
    return credentials.run(url, async (activeCookie) => {
      return rawRequestHttp({
        hostname: portalHost,
        port: 80,
        path,
        method,
        headers: {
          Host: portalHost,
          Cookie: activeCookie,
          'User-Agent': 'Mozilla/5.0 (Leo-Live-Inspector)'
        }
      }, body);
    }, { readOnly: method === 'GET' });
  }

  const startTime = Date.now();

  // 1. 确定目标 Cluster
  let resolvedCluster = clusterInput || 'default';
  let previewNotice = '';

  if (isPreviewEnv && !clusterInput) {
    // 预发环境智能探测：优先探查是否存在 preview / prev 专有集群
    let foundPreviewCluster = false;
    for (const probeCluster of ['preview', 'prev']) {
      const probeRes = await requestPortal(`/apps/${encodeURIComponent(canonicalApp)}/envs/${portalEnv}/clusters/${encodeURIComponent(probeCluster)}/namespaces`);
      if (probeRes.statusCode === 200 && Array.isArray(probeRes.data) && probeRes.data.length > 0) {
        resolvedCluster = probeCluster;
        foundPreviewCluster = true;
        break;
      }
    }
    if (!foundPreviewCluster) {
      resolvedCluster = 'default';
      previewNotice = '💡 该应用在生产 Portal 下未配置独立的 [preview/prev] 集群，预发环境直接共享 [default] 集群配置。已自动为您按 PROD default 集群检索发布轨迹。';
    }
  }

  // 2. 确定目标 Namespace (若未指定，全自动嗅探)
  let targetNamespace = inputNamespace;
  let detectedFrom = 'explicit';

  if (!targetNamespace) {
    // 策略 A: 先秒级查 ConfigService (无需 Portal 鉴权，快至 20ms)
    for (const candidateNs of ['application', 'application.properties']) {
      const liveConfigs = await fetchConfigServiceLive(configServer, canonicalApp, resolvedCluster, candidateNs);
      if (liveConfigs && Object.prototype.hasOwnProperty.call(liveConfigs, targetKey)) {
        targetNamespace = candidateNs;
        detectedFrom = 'configservice_live';
        break;
      }
    }

    // 策略 B: 若快速检查未命中，拉取 Portal 全量 Namespace 列表
    if (!targetNamespace) {
      const nsRes = await requestPortal(`/apps/${encodeURIComponent(canonicalApp)}/envs/${portalEnv}/clusters/${encodeURIComponent(resolvedCluster)}/namespaces`);
      if (nsRes.statusCode === 200 && Array.isArray(nsRes.data)) {
        const matchingNamespaces = [];
        for (const nsObj of nsRes.data) {
          const nsName = nsObj.baseInfo?.namespaceName;
          if (!nsName) continue;

          // 优先看 ConfigService
          const liveConfigs = await fetchConfigServiceLive(configServer, canonicalApp, resolvedCluster, nsName);
          if (liveConfigs && Object.prototype.hasOwnProperty.call(liveConfigs, targetKey)) {
            matchingNamespaces.push(nsName);
            continue;
          }

          // 检查该 namespace 下的 items
          const itemRes = await requestPortal(`/apps/${encodeURIComponent(canonicalApp)}/envs/${portalEnv}/clusters/${encodeURIComponent(resolvedCluster)}/namespaces/${encodeURIComponent(nsName)}/items`);
          if (Array.isArray(itemRes.data) && itemRes.data.some(it => it.key === targetKey)) {
            matchingNamespaces.push(nsName);
          }
        }

        if (matchingNamespaces.length === 1) {
          targetNamespace = matchingNamespaces[0];
          detectedFrom = 'portal_items_scan';
        } else if (matchingNamespaces.length > 1) {
          if (!outputJson) {
            console.error(`\n⚠️ 配置项 [${targetKey}] 存在于多个命名空间中: ${matchingNamespaces.join(', ')}`);
            console.error(`👉 请显式指定命名空间，例如: node scripts/apollo_history.js ${canonicalApp} ${matchingNamespaces[0]} ${targetKey}\n`);
          } else {
            console.log(JSON.stringify({ error: 'AMBIGUOUS_NAMESPACE', matchingNamespaces }));
          }
          process.exit(1);
        }
      }
    }

    // 兜底为 application
    if (!targetNamespace) {
      targetNamespace = 'application';
      detectedFrom = 'default_fallback';
    }
  }

  // 3. 读取 ConfigService 客户端实时生效值 (用于闭环核验)
  const currentLiveConfigs = await fetchConfigServiceLive(configServer, canonicalApp, resolvedCluster, targetNamespace);
  const liveVerifiedValue = currentLiveConfigs ? currentLiveConfigs[targetKey] : undefined;

  // 4. 分页循环拉取历次 Release 历史快照
  const allReleases = [];
  const seenReleaseIds = new Set();
  let page = 0;
  const maxPages = Math.ceil(depth / pageSize);

  while (page < maxPages) {
    if (allReleases.length >= depth) break;

    // 保持 size = pageSize 不变，确保 Apollo 服务端 (offset = page * size) 分页不错位
    const histUrl = `/apps/${encodeURIComponent(canonicalApp)}/envs/${portalEnv}/clusters/${encodeURIComponent(resolvedCluster)}/namespaces/${encodeURIComponent(targetNamespace)}/releases/histories?page=${page}&size=${pageSize}`;
    const histRes = await requestPortal(histUrl);

    if (histRes.statusCode !== 200 || !Array.isArray(histRes.data)) {
      if (page === 0) {
        if (!outputJson) {
          console.error(`\n❌ 查询发布历史失败 (HTTP ${histRes.statusCode})！`);
          if (histRes.statusCode === 302) {
            console.error(`💡 登录态已失效，请在日常 Chrome 中登录 http://${portalHost} 后重试，或使用 --set-cookie 刷新。\n`);
          }
        } else {
          console.log(JSON.stringify({ error: 'FETCH_RELEASES_FAILED', statusCode: histRes.statusCode, data: histRes.data }));
        }
        process.exit(1);
      }
      break;
    }

    const pageData = histRes.data;
    if (pageData.length === 0) break;

    for (const r of pageData) {
      const rId = r.id || r.releaseId;
      if (rId && seenReleaseIds.has(rId)) continue;
      if (rId) seenReleaseIds.add(rId);

      allReleases.push(r);
      if (allReleases.length >= depth) break;
    }

    if (pageData.length < pageSize) break;
    page++;
  }

  function extractConfiguration(raw) {
    const configs = {};
    if (!raw) return configs;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && item.firstEntity !== undefined) {
          configs[item.firstEntity] = item.secondEntity;
        }
      }
    } else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return extractConfiguration(parsed);
      } catch {}
    } else if (typeof raw === 'object' && raw !== null) {
      if (raw.configuration) return extractConfiguration(raw.configuration);
      if (raw.configurations) return extractConfiguration(raw.configurations);
      Object.assign(configs, raw);
    }
    return configs;
  }

  // 5. Diff 状态机萃取：提取目标 Key 的变更节点
  // allReleases 是按发布时间倒序排列的（index 0 是最新版本）
  const parsedReleases = allReleases.map(r => {
    const title = r.releaseTitle || r.name || `release-${r.id}`;
    const comment = r.releaseComment || r.comment || '';
    const operator = r.operatorDisplayName
      ? `${r.operatorDisplayName} (${r.operator})`
      : (r.operator || r.dataChangeCreatedBy || 'unknown');
    const releaseTime = r.releaseTimeFormatted || r.releaseTime || r.dataChangeCreatedTime || '';
    const configs = extractConfiguration(r.configuration || r.configurations);

    return {
      id: r.id || r.releaseId,
      name: title,
      comment,
      createdBy: operator,
      createTime: releaseTime,
      configurations: configs
    };
  });

  const changeTimeline = [];

  for (let i = 0; i < parsedReleases.length; i++) {
    const curr = parsedReleases[i];
    const prev = i + 1 < parsedReleases.length ? parsedReleases[i + 1] : null;

    const currHasKey = Object.prototype.hasOwnProperty.call(curr.configurations, targetKey);
    const currVal = currHasKey ? curr.configurations[targetKey] : undefined;

    const prevHasKey = prev ? Object.prototype.hasOwnProperty.call(prev.configurations, targetKey) : false;
    const prevVal = prevHasKey ? prev.configurations[targetKey] : undefined;

    if (prev) {
      // 相邻两次发布对比
      if (!prevHasKey && currHasKey) {
        changeTimeline.push({
          type: 'CREATE',
          typeLabel: '新增 (CREATE)',
          releaseTitle: curr.name,
          releaseTime: curr.createTime,
          operator: curr.createdBy,
          comment: curr.comment,
          oldValue: null,
          newValue: currVal
        });
      } else if (prevHasKey && !currHasKey) {
        changeTimeline.push({
          type: 'DELETE',
          typeLabel: '删除 (DELETE)',
          releaseTitle: curr.name,
          releaseTime: curr.createTime,
          operator: curr.createdBy,
          comment: curr.comment,
          oldValue: prevVal,
          newValue: null
        });
      } else if (prevHasKey && currHasKey && String(prevVal) !== String(currVal)) {
        changeTimeline.push({
          type: 'MODIFY',
          typeLabel: '修改 (MODIFY)',
          releaseTitle: curr.name,
          releaseTime: curr.createTime,
          operator: curr.createdBy,
          comment: curr.comment,
          oldValue: prevVal,
          newValue: currVal
        });
      } else if (showAllReleases) {
        changeTimeline.push({
          type: 'UNCHANGED',
          typeLabel: '未变 (UNCHANGED)',
          releaseTitle: curr.name,
          releaseTime: curr.createTime,
          operator: curr.createdBy,
          comment: curr.comment,
          oldValue: currVal,
          newValue: currVal
        });
      }
    } else {
      // 最早一次扫描到的版本 (末尾基线)
      if (currHasKey) {
        changeTimeline.push({
          type: 'BASELINE',
          typeLabel: '初始状态 (BASELINE)',
          releaseTitle: curr.name,
          releaseTime: curr.createTime,
          operator: curr.createdBy,
          comment: curr.comment || '扫描范围内最早版本记录',
          oldValue: null,
          newValue: currVal
        });
      }
    }
  }

  const durationMs = Date.now() - startTime;

  // 6. JSON 格式输出
  if (outputJson) {
    console.log(JSON.stringify({
      appId: canonicalApp,
      env: portalEnv,
      envLabel: envDisplayLabel,
      cluster: resolvedCluster,
      namespace: targetNamespace,
      key: targetKey,
      liveVerifiedValue: liveVerifiedValue !== undefined ? liveVerifiedValue : null,
      scannedReleasesCount: allReleases.length,
      durationMs,
      changesCount: changeTimeline.length,
      history: changeTimeline
    }, null, 2));
    process.exit(0);
  }

  // 7. 高可读性文本输出
  console.log(`================================================================`);
  console.log(`📜 Apollo 配置项发布轨迹: [${targetKey}]`);
  console.log(`================================================================`);
  console.log(`📦 微服务应用: ${canonicalApp} | 🌐 环境: ${envDisplayLabel}`);
  console.log(`📁 命名空间:   【${targetNamespace}】 | 🔗 集群: ${resolvedCluster}`);
  console.log(`⏱️ 检索耗时:   ${durationMs}ms | 扫描版本: ${allReleases.length} 个 | 命中变更节点: ${changeTimeline.length} 次`);
  if (previewNotice) {
    console.log(`\n${previewNotice}`);
  }
  console.log(`----------------------------------------------------------------`);

  // 当前实时生效值
  if (liveVerifiedValue !== undefined) {
    console.log(`🌐 客户端实时生效值 (${configServer}):`);
    console.log(formatJsonValue(liveVerifiedValue, 4));
  } else {
    console.log(`🌐 客户端实时生效值 (${configServer}): ⚠️ 当前未在生效配置中（不存在或已删除）`);
  }
  console.log(`----------------------------------------------------------------`);

  if (changeTimeline.length === 0) {
    if (liveVerifiedValue !== undefined) {
      console.log(`ℹ️ 配置项 [${targetKey}] 当前存在生效值，但在扫描的最近 ${allReleases.length} 个发布版本中保持未变。`);
      console.log(`💡 说明：最近的 ${allReleases.length} 次发布仅修改了其他配置项，本项修改时间可能更早。`);
      console.log(`👉 若需回溯更早版本，可增加扫描深度，例如追加: -n 100\n`);
    } else {
      console.log(`⚠️ 未在命名空间 【${targetNamespace}】 最近扫描的 ${allReleases.length} 个发布版本中找到配置项 [${targetKey}]。\n`);
    }
  } else {
    console.log(`📊 变更轨迹时序 (按发布时间由近及远倒序排列):`);
    console.log(`----------------------------------------------------------------`);

    changeTimeline.forEach((item, index) => {
      const icon = item.type === 'CREATE' ? '🟢' : item.type === 'DELETE' ? '🔴' : item.type === 'MODIFY' ? '🟡' : '⚪';
      console.log(`${icon} [${index + 1}/${changeTimeline.length}] 【${item.typeLabel}】`);
      console.log(`   📅 发布时间: ${formatTimestamp(item.releaseTime)}`);
      console.log(`   🏷️ 版本标识: ${item.releaseTitle}`);
      console.log(`   👤 操 作 人: ${item.operator}`);
      if (item.comment) {
        console.log(`   📝 发布说明: ${item.comment}`);
      }

      if (item.type === 'CREATE') {
        console.log(`   🔄 变更对比:`);
        console.log(`      + 初始值: ${typeof tryParseJson(item.newValue) === 'object' ? '\n' + formatJsonValue(item.newValue, 8) : item.newValue}`);
      } else if (item.type === 'DELETE') {
        console.log(`   🔄 变更对比:`);
        console.log(`      - 删除前: ${typeof tryParseJson(item.oldValue) === 'object' ? '\n' + formatJsonValue(item.oldValue, 8) : item.oldValue}`);
        console.log(`      + 状态:   (已剔除)`);
      } else if (item.type === 'MODIFY') {
        console.log(`   🔄 变更对比:`);
        console.log(`      - 变更前: ${typeof tryParseJson(item.oldValue) === 'object' ? '\n' + formatJsonValue(item.oldValue, 8) : item.oldValue}`);
        console.log(`      + 变更后: ${typeof tryParseJson(item.newValue) === 'object' ? '\n' + formatJsonValue(item.newValue, 8) : item.newValue}`);
      } else if (item.type === 'BASELINE') {
        console.log(`   🔄 基准快照:`);
        console.log(`      * 配置值: ${typeof tryParseJson(item.newValue) === 'object' ? '\n' + formatJsonValue(item.newValue, 8) : item.newValue}`);
      }
      console.log(`----------------------------------------------------------------`);
    });
  }

  // 交付 Portal 深度直达链接
  const portalCluster = resolvedCluster === 'default' ? 'default' : resolvedCluster;
  const portalUrl = `http://${portalHost}/#/appid=${encodeURIComponent(canonicalApp)}&env=${portalEnv}&cluster=${encodeURIComponent(portalCluster)}&namespace=${encodeURIComponent(targetNamespace)}`;
  console.log(`🔗 Apollo Portal 发布历史控制台直达链接:`);
  console.log(`   ${portalUrl}\n`);
}

main().catch(err => {
  console.error('\n❌ Apollo History Tracker Fatal Error:', err.message || err);
  process.exit(1);
});
