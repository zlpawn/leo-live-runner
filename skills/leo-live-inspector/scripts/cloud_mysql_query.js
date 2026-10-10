#!/usr/bin/env node

/**
 * 🗄️ Leo Live Inspector - 服务云 MySQL 自助查询引擎 (Cloud MySQL Query Engine)
 * 
 * 功能：
 *   1. 免本地安装 MySQL/VPN，免鉴权直连服务云 DQL 网关执行只读 SQL 查询；
 *   2. 支持读取本地持久化 Token (~/.shrimp/skills/live-inspector/cloud_token.json)；
 *   3. 智能微服务简称映射 (如 recorder -> port: 6763, db: utopia_scs_recorder)；
 *   4. 自动解析服务端返回的 Base64 Excel 数据流并格式化为精美终端表格 / JSON；
 *   5. 内置 Token 引导与一键配置 (--set-token <token>)。
 */

import http from 'node:http';
import { createCredentialSession } from './common/browser_credentials.js';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadServiceCatalog, resolveAppId } from './common/services.js';
import { SHRIMP_LIVE_DIR, loadCloudConsoleToken, saveCloudConsoleToken } from './common/credentials.js';
import { parseXlsxBase64WithPython } from './common/xlsx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = SHRIMP_LIVE_DIR;
const TOKEN_FILE = path.join(CONFIG_DIR, 'cloud_token.json');
const CATALOG_FILE = path.join(CONFIG_DIR, 'db_catalog.json');

let credentials;
async function getJson(url, token) {
  const result = await credentials.run(url, value => rawGetJson(url, value), {readOnly:true});
  return result?.data;
}
async function postJson(url, payload, token) {
  return credentials.run(url, value => rawPostJson(url, payload, value), {readOnly:true});
}

// 从统一服务注册表动态加载服务到端口和库名的映射
function loadPresetServiceDbMapping() {
  const mapping = {};
  const catalog = loadServiceCatalog();
  for (const [key, val] of Object.entries(catalog)) {
    if (val.port && val.database) {
      mapping[key.toLowerCase()] = {
        port: String(val.port),
        database: val.database,
        role: 'Slave',
        name: val.dbDesc || key
      };
    }
  }
  return mapping;
}

const SERVICE_DB_MAPPING = loadPresetServiceDbMapping();

function rawGetJson(urlStr, token) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.get({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Cookie': `cloud_console_token_egg=${token};`,
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 6000
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({statusCode:res.statusCode,headers:res.headers,data:JSON.parse(raw)}); } catch { resolve({statusCode:res.statusCode,headers:res.headers,data:null,error:"INVALID_JSON"}); }
      });
    }).on('error', () => resolve(null)).on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchDbCatalog(token) {
  const portsRes = await getJson('https://cloud.intra.ke.com/cloud-proxy-api/xmen/mysql/dql/query_port', token);
  const ports = portsRes?.data || [];
  const catalog = [];
  for (const p of ports) {
    const dbRes = await getJson(`https://cloud.intra.ke.com/cloud-proxy-api/xmen/mysql/dql/query_database?port=${p}`, token);
    const dbs = dbRes?.data || [];
    for (const db of dbs) {
      catalog.push({ port: String(p), database: db });
    }
  }
  if (catalog.length > 0) {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify({
      updated_at: new Date().toISOString(),
      list: catalog
    }, null, 2), 'utf8');
  }
  return catalog;
}

async function loadDbCatalog(token, forceRefresh = false) {
  if (!forceRefresh && fs.existsSync(CATALOG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      if (Array.isArray(data.list) && data.list.length > 0) {
        // 如果文件少于 24 小时则直接复用
        const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / (1000 * 3600);
        if (ageHours < 24) return data.list;
      }
    } catch {}
  }
  return await fetchDbCatalog(token);
}

function printTokenGuide() {
  const extPath = fs.existsSync(path.join(os.homedir(), '.agents', 'skills', 'leo-live-inspector', 'resources', 'chrome_extension'))
    ? path.join(os.homedir(), '.agents', 'skills', 'leo-live-inspector', 'resources', 'chrome_extension')
    : path.join(__dirname, '..', 'resources', 'chrome_extension');

  console.log(`
================================================================
🔑 如何获取服务云 Token 凭证？（提供两种极简方式）：
================================================================

【方式 1：最推荐】手动导入内置 Chrome 插件（一键复制/免网关下载）
----------------------------------------------------------------
1. 在 Chrome 打开: chrome://extensions/
   - 开启右上角【开发者模式 (Developer mode)】；
   - 点击左上角【加载已解压的扩展程序 (Load unpacked)】；
   - 选择/粘贴此插件目录: ${extPath}

2. 切回服务云页面 (https://cloud.intra.ke.com/database/mysql/self-check)；
   - 点击插件图标，点击【复制】单项 Token 或【📥 下载 cookies.txt】即可！

----------------------------------------------------------------
【方式 2：备用】使用浏览器开发者工具 F12 手动复制（无需装插件）
----------------------------------------------------------------
1. 在 Chrome 打开服务云页面: https://cloud.intra.ke.com/database/mysql/self-check
2. 按 F12 打开控制台 ➔ 顶部【Application (应用)】➔ 左侧【Cookies】➔ 点击【cloud.intra.ke.com】；
3. 找到名为【cloud_console_token_egg】的那一行，双击 Value 复制；
4. 运行配置命令:
   node scripts/cloud_mysql_query.js --set-token <你复制的token>
================================================================
`);
}

function loadToken() {
  return process.env.CLOUD_MYSQL_TOKEN?.trim() || loadCloudConsoleToken();
}

function saveToken(token) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  let cleanToken = token.trim();
  if (cleanToken.includes('cloud_console_token_egg=')) {
    const match = cleanToken.match(/cloud_console_token_egg=([^;]+)/);
    if (match) cleanToken = match[1].trim();
  } else {
    cleanToken = cleanToken.replace(/;.*$/, '').trim();
  }
  saveCloudConsoleToken(cleanToken);
  console.log(`✅ Token 已成功保存至: ${TOKEN_FILE}`);
}

function rawPostJson(urlStr, payload, token) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const bodyStr = JSON.stringify(payload);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': `cloud_console_token_egg=${token};`,
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 10000
    };

    const req = client.request(options, (res) => {
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        if (res.statusCode === 302 || (res.headers.location && res.headers.location.includes('login.ke.com'))) {
          return resolve({ success: false, isRedirect: true, statusCode: res.statusCode, headers: res.headers });
        }
        try {
          const json = JSON.parse(rawData);
          resolve({ success: true, data: json, statusCode: res.statusCode, headers: res.headers });
        } catch (e) {
          resolve({ success: false, raw: rawData, statusCode: res.statusCode, error: e.message });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout (10000ms)' });
    });

    req.write(bodyStr);
    req.end();
  });
}

function printUsage() {
  console.log(`
🔍 Leo Cloud MySQL Query Tool (服务云 MySQL 自助查询引擎)
用法:
  node scripts/cloud_mysql_query.js <appId|port> [database|sql] [sql] [options]

参数说明:
  <appId|port>     微服务别名 (如 recorder, saas, algo) 或 数据库端口号 (如 6763)
  [database|sql]   库名 (如 utopia_scs_recorder) 或 待执行的 SQL 语句 (当第 1 个参数是服务别名时)
  [sql]            当传入端口和库名时，第 3 个参数为待执行的 SQL 语句

选项 (Options):
  --set-token <token>   配置/更新服务云 cloud_console_token_egg 凭证
  --port <port>         指定端口号 (默认自动根据服务映射解析)
  --db <database>       指定库名
  --role <role>         角色: Slave (默认从库只读) 或 Master (主库)
  --token <token>       单次临时覆盖 Token
  --json                以纯 JSON 格式输出匹配结果
  --table               以控制台对齐表格输出 (默认)

示例:
  # 1. 首次配置 Token (只需贴一次，保存后长期有效)
  node scripts/cloud_mysql_query.js --set-token 2.0111a9beb284238b...

  # 2. 口语化通过服务简称查表数据 (自动解析为对应端口和库名)
  node scripts/cloud_mysql_query.js recorder "SELECT id, ctime FROM image_understanding_detail ORDER BY id DESC LIMIT 5"

  # 3. 指定端口与库名查询
  node scripts/cloud_mysql_query.js 6763 utopia_scs_recorder "SELECT count(*) FROM image_understanding_detail"
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  // 1. 设置 token
  const setTokenIdx = args.findIndex(a => a === '--set-token');
  if (setTokenIdx !== -1 && args[setTokenIdx + 1]) {
    saveToken(args[setTokenIdx + 1]);
    process.exit(0);
  }

  // 2. 自动环境路由：若指定 --env test / -e test，自动委派给 test_mysql_query.js 直连执行
  const envIdx = args.findIndex(a => a === '--env' || a === '-e');
  if (envIdx !== -1 && ['test', 'dev', 'qa', 'local'].includes(String(args[envIdx + 1]).toLowerCase())) {
    const filteredArgs = args.filter((_, idx) => idx !== envIdx && idx !== envIdx + 1);
    const testScript = path.join(__dirname, 'test_mysql_query.js');
    const child = spawnSync(process.execPath, [testScript, ...filteredArgs], { stdio: 'inherit' });
    process.exit(child.status !== null ? child.status : 0);
  }

  let customPort = null;
  let customDb = null;
  let customRole = 'Slave';
  let tempToken = null;
  let outputJson = false;

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      customPort = args[++i];
    } else if ((arg === '--db' || arg === '--database') && args[i + 1]) {
      customDb = args[++i];
    } else if (arg === '--role' && args[i + 1]) {
      customRole = args[++i];
    } else if (arg === '--token' && args[i + 1]) {
      tempToken = args[++i];
    } else if (arg === '--json') {
      outputJson = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const token = tempToken || loadToken();
  credentials = createCredentialSession({load:()=>token, save:saveCloudConsoleToken,
    explicit:Boolean(tempToken || process.env.CLOUD_MYSQL_TOKEN || process.env.CLOUD_CONSOLE_TOKEN), names:['cloud_console_token_egg'],
    fromCookies:cookies=>cookies.find(c=>c.name==='cloud_console_token_egg')?.value || ''});


  // 2. 列出所有数据库资产
  if (args.includes('--list-dbs') || args.includes('--catalog')) {
    const catalog = await loadDbCatalog(token, args.includes('--refresh'));
    console.log(`\n📚 服务云当前工号已授权数据库资产 (${catalog.length} 个库):`);
    console.log(`| 端口号 (Port) | 数据库名称 (Database) |`);
    console.log(`| :--- | :--- |`);
    for (const item of catalog) {
      console.log(`| **${item.port}** | \`${item.database}\` |`);
    }
    console.log(`\n💡 提示: 查库时可直接使用库名关键词（例如: node scripts/cloud_mysql_query.js ${catalog[0]?.database || 'device'} "SQL"）\n`);
    process.exit(0);
  }

  // 解析目标服务、端口、库名与 SQL
  let port = customPort;
  let database = customDb;
  let sql = null;
  let serviceLabel = '';

  const firstArg = positional[0];
  if (firstArg && SERVICE_DB_MAPPING[firstArg.toLowerCase()]) {
    const mapping = SERVICE_DB_MAPPING[firstArg.toLowerCase()];
    port = port || mapping.port;
    database = database || mapping.database;
    serviceLabel = `${mapping.name} [${firstArg}]`;
    sql = positional[1];
  } else if (firstArg && /^\d+$/.test(firstArg)) {
    port = firstArg;
    database = positional[1];
    sql = positional[2];
    serviceLabel = `端口 ${port}`;
  } else if (firstArg && positional.length >= 2) {
    // 动态模糊匹配数据库资产库名
    const catalog = await loadDbCatalog(token);
    const q = firstArg.toLowerCase();
    const exact = catalog.find(c => c.database.toLowerCase() === q);
    const matches = exact ? [exact] : catalog.filter(c => c.database.toLowerCase().includes(q));

    if (matches.length === 1) {
      port = matches[0].port;
      database = matches[0].database;
      serviceLabel = `智能资产寻址 [${database}]`;
      sql = positional[1];
    } else if (matches.length > 1) {
      console.log(`ℹ️ 关键词 "${firstArg}" 模糊匹配到 ${matches.length} 个库，智能优选: ${matches[0].port} [${matches[0].database}]`);
      port = matches[0].port;
      database = matches[0].database;
      serviceLabel = `智能资产寻址 [${database}]`;
      sql = positional[1];
    } else {
      sql = positional[0];
    }
  } else {
    sql = positional[0];
  }

  if (!port || !database || !sql) {
    console.error(`❌ 参数不完整！必须指定微服务名称 (如 recorder) 或 [端口号 库名]，以及要执行的 SQL！`);
    printUsage();
    process.exit(1);
  }

  const startTime = Date.now();
  if (!outputJson) {
    console.log(`================================================================`);
    console.log(`🚀 服务云 MySQL 自助查询: ${serviceLabel}`);
    console.log(`🌐 实例: 端口 ${port} | 数据库: ${database} | 角色: ${customRole}`);
    console.log(`📝 SQL:  ${sql.replace(/\n+/g, ' ')}`);
    console.log(`================================================================\n`);
  }

  // 1. 发起查询
  const queryUrl = process.env.LEO_CLOUD_MYSQL_QUERY_URL || 'https://cloud.intra.ke.com/cloud-proxy-api/xmen/mysql/dql/query';
  const queryRes = await postJson(queryUrl, {
    port: port.toString(),
    database: database,
    role: customRole,
    query: sql
  }, token);

  if (queryRes.isRedirect) {
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: 'Token 已失效（服务云已重定向至登录页）',
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ Token 已失效（服务云已重定向至登录页）！`);
      console.error(`💡 原因：您可能在浏览器中重新扫码登录过，服务云踢出了旧 Session。`);
      printTokenGuide();
    }
    process.exit(1);
  }

  if (!queryRes.success || !queryRes.data) {
    const errMsg = queryRes.error || `HTTP ${queryRes.statusCode}`;
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: `查询请求失败: ${errMsg}`,
        raw: queryRes.raw ? queryRes.raw.slice(0, 300) : undefined,
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ 查询请求失败: ${errMsg}`);
      if (queryRes.raw) console.error(`响应内容: ${queryRes.raw.slice(0, 300)}`);
    }
    process.exit(1);
  }

  const resJson = queryRes.data;
  if (resJson.code !== 200000) {
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        code: resJson.code,
        error: resJson.message,
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ 服务云返回错误 [${resJson.code}]: ${resJson.message}`);
    }
    process.exit(1);
  }

  if (!resJson.data) {
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: '服务云返回数据为空',
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ 服务云返回数据为空！`);
    }
    process.exit(1);
  }

  // 核心修复点 1：检查 SQL 执行本身返回的错误（当表不存在、语法错误、非只读等，code 为 200000 但 data.error 包含具体报错）
  if (resJson.data.error) {
    const sqlError = resJson.data.error;
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: sqlError,
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ SQL 执行失败: ${sqlError}`);
      if (sqlError.includes("doesn't exist")) {
        console.error(`💡 提示: 目标表可能不存在。可先执行 "SHOW TABLES" 查看当前库中的所有表。`);
      } else if (sqlError.includes("Unknown column")) {
        console.error(`💡 提示: 目标列可能不存在。可先执行 "DESCRIBE <表名>" 查看表字段结构。`);
      } else if (sqlError.includes("仅允许执行")) {
        console.error(`💡 提示: 服务云线上数据库仅支持 SELECT/SHOW/EXPLAIN 等只读查询；若需执行写入/更新，请使用测试环境脚本 test_mysql_query.js。`);
      }
    }
    process.exit(1);
  }

  const queryId = resJson.data.query_id || resJson.data.queryId || resJson.data.QueryId;
  const filePath = resJson.data.file_path || resJson.data.filePath || resJson.data.FilePath;
  const queryResultMeta = resJson.data.query_result || '';

  // 核心修复点 2：防御性校验 queryId 是否存在，避免发起无效的 get_result 请求触发 validator 报错
  if (!queryId) {
    const errorMsg = resJson.data.error || resJson.message || '服务端未返回有效 query_id';
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: errorMsg,
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ 服务端未生成有效 query_id: ${errorMsg}`);
    }
    process.exit(1);
  }

  // 2. 拉取结果 Excel Base64
  const getResultUrl = process.env.LEO_CLOUD_MYSQL_GET_RESULT_URL || 'https://cloud.intra.ke.com/cloud-proxy-api/xmen/mysql/dql/get_result';
  const resultRes = await postJson(getResultUrl, {
    query_id: queryId,
    file_path: filePath
  }, token);

  if (!resultRes.success || !resultRes.data || resultRes.data.code !== 200000) {
    const errorDetail = resultRes.error || (resultRes.data && resultRes.data.message) || `HTTP ${resultRes.statusCode}`;
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: `获取查询结果失败: ${errorDetail}`,
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ 获取查询结果失败: ${errorDetail}`);
    }
    process.exit(1);
  }

  const b64Data = resultRes.data.data;
  const parsedRows = parseXlsxBase64WithPython(b64Data);

  if (parsedRows.error) {
    if (outputJson) {
      console.log(JSON.stringify({
        success: false,
        error: `解析 Excel 数据流失败: ${parsedRows.error}`,
        service: firstArg,
        port,
        database,
        sql
      }, null, 2));
    } else {
      console.error(`❌ 解析 Excel 数据流失败: ${parsedRows.error}`);
    }
    process.exit(1);
  }

  const costMs = Date.now() - startTime;

  if (outputJson) {
    console.log(JSON.stringify({
      success: true,
      service: firstArg,
      port,
      database,
      role: customRole,
      sql,
      costMs,
      meta: queryResultMeta.trim(),
      headers: parsedRows[0] || [],
      rows: parsedRows.slice(1)
    }, null, 2));
    return;
  }

  console.log(`⏱️ 状态: 成功 | ${queryResultMeta.trim()} | 总耗时: ${costMs}ms\n`);

  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    console.log(`⚠️ 查询结果为空 (0 rows)`);
    return;
  }

  const headers = parsedRows[0] || [];
  const rows = parsedRows.slice(1);

  if (rows.length === 0) {
    console.log(`⚠️ 表头: [${headers.join(', ')}]，但未匹配到数据行 (0 rows)`);
    return;
  }

  // 简单 Markdown 表格输出
  console.log(`| ` + headers.join(' | ') + ` |`);
  console.log(`| ` + headers.map(() => '---').join(' | ') + ` |`);
  for (const r of rows) {
    // 补齐列数
    const padded = headers.map((_, i) => (r[i] !== undefined && r[i] !== null) ? String(r[i]).replace(/\n/g, ' ') : '');
    console.log(`| ` + padded.join(' | ') + ` |`);
  }
  console.log(``);
}

main().catch(err => {
  console.error('执行异常:', err);
  process.exit(1);
});
