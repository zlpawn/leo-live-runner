#!/usr/bin/env node

import { resolveEsConfig, resolveEsTarget } from './common/es_resolver.js';
import { requestHttp } from './common/http.js';
import { classifyEnvironment } from './common/env_detector.js';

function printHelp() {
  console.log(`
🔍 Leo Live Inspector - ES 搜索与索引结构探查工具

用法:
  node scripts/es_query.js <appId> [serviceKey] [选项]
  node scripts/es_query.js -a <appId> -s <serviceKey> [选项]

核心场景示例:
  1. 列出微服务支持的所有 ES 索引/服务:
     node scripts/es_query.js iot-platform --list-services -e prod

  2. 探查索引结构 (Schema / Mapping 字段推断):
     node scripts/es_query.js iot-platform lock --schema -e prod

  3. 查询最新 5 条数据:
     node scripts/es_query.js iot-platform lock -n 5 -e prod

  4. 带关键词检索:
     node scripts/es_query.js iot-platform lock -q "合肥" -n 5 -e prod

  5. 按字段过滤:
     node scripts/es_query.js iot-platform lock --filter "cityCode:340100" -n 5 -e prod

选项说明:
  -a, --app <appId>             目标微服务名或别名 (如 zulin-iot-platform, iot-platform)
  -s, --service <serviceKey>    目标业务键名或 serviceId (如 lock, 1030902020)
  -e, --env <prod|test>         目标环境 (默认: prod 线上环境)
  -q, --query <keyword>         查询关键词
      --filter <k:v,k2:v2>      简单键值对过滤条件
  -n, --size <num>              每页条数 (默认: 10, 最大 100)
  -p, --page <num>              页码 (默认: 1)
      --schema                  探查并展示索引结构与字段元数据
      --list-services           仅列出当前服务配置的所有 ES 索引
      --json                    输出原始 JSON 格式结果
  -h, --help                    查看帮助信息
`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    appId: '',
    serviceKey: '',
    env: 'prod',
    query: '',
    filter: '',
    size: 10,
    page: 1,
    schema: false,
    listServices: false,
    json: false,
  };

  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-a' || arg === '--app') {
      options.appId = args[++i];
    } else if (arg === '-s' || arg === '--service') {
      options.serviceKey = args[++i];
    } else if (arg === '-e' || arg === '--env') {
      options.env = args[++i];
    } else if (arg === '-q' || arg === '--query') {
      options.query = args[++i];
    } else if (arg === '--filter') {
      options.filter = args[++i];
    } else if (arg === '-n' || arg === '--size') {
      options.size = parseInt(args[++i], 10) || 10;
    } else if (arg === '-p' || arg === '--page') {
      options.page = parseInt(args[++i], 10) || 1;
    } else if (arg === '--schema') {
      options.schema = true;
    } else if (arg === '--list-services') {
      options.listServices = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  if (!options.appId && positionals.length > 0) {
    options.appId = positionals[0];
  }
  if (!options.serviceKey && positionals.length > 1) {
    options.serviceKey = positionals[1];
  }

  return options;
}

/**
 * 格式化字段类型推断
 */
function inferType(val) {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) return 'Array';
  if (typeof val === 'number') return Number.isInteger(val) ? 'Long/Integer' : 'Float/Double';
  if (typeof val === 'boolean') return 'Boolean';
  if (typeof val === 'object') return 'Object/Nested';
  return 'String';
}

/**
 * 执行 Schema 采样分析
 */
function analyzeSchema(docs) {
  const fieldMap = new Map();

  for (const doc of docs) {
    for (const [key, val] of Object.entries(doc)) {
      if (!fieldMap.has(key)) {
        fieldMap.set(key, {
          type: inferType(val),
          sample: val,
          hasValueCount: val !== null && val !== undefined && val !== '' ? 1 : 0
        });
      } else {
        const item = fieldMap.get(key);
        if (item.type === 'null' && val !== null && val !== undefined) {
          item.type = inferType(val);
          item.sample = val;
        }
        if (val !== null && val !== undefined && val !== '') {
          item.hasValueCount++;
        }
      }
    }
  }

  return Array.from(fieldMap.entries()).map(([field, meta]) => ({
    field,
    type: meta.type === 'null' ? 'String (Inferred)' : meta.type,
    nullable: meta.hasValueCount < docs.length ? 'YES' : 'NO',
    sample: typeof meta.sample === 'object' ? JSON.stringify(meta.sample) : String(meta.sample ?? '')
  }));
}

async function main() {
  const opts = parseCliArgs();

  if (!opts.appId) {
    console.error('❌ 缺少必须参数: 微服务名 (-a / --app <appId>)');
    printHelp();
    process.exit(1);
  }

  // 1. 如果只需要列出当前微服务的所有 ES 索引服务
  if (opts.listServices) {
    const config = await resolveEsConfig(opts.appId, opts.env);
    if (!config) {
      console.error(`❌ 未能获取到 [${opts.appId}] 在 [${opts.env}] 的 ES 配置`);
      process.exit(1);
    }
    console.log(`\n📦 微服务 [${config.appId}] 的 ES 索引服务清单 (${config.source}):`);
    console.log(`🌐 默认读网关: ${config.domain || '未配置'}`);
    console.log(`🌐 默认写网关: ${config.writeDomain || '未配置'}\n`);
    console.log('| 业务标识 (bizKey) | Service ID | 独立 Domain | Token |');
    console.log('| :--- | :--- | :--- | :--- |');
    const seen = new Set();
    for (const [k, v] of Object.entries(config.services)) {
      if (seen.has(v.serviceId)) continue;
      seen.add(v.serviceId);
      console.log(`| ${v.bizKey || k} | ${v.serviceId} | ${v.domain || '-'} | ${v.token ? '已配置 (已脱敏)' : '未配置'} |`);
    }
    return;
  }

  // 2. 解析具体的 ES 目标
  const target = await resolveEsTarget(opts.appId, opts.serviceKey, opts.env);
  const envTag = target.env === 'prod' ? '🔴 生产环境 (PROD)' : '🟡 测试环境 (TEST)';

  if (!opts.json) {
    console.log(`\n================================================================`);
    console.log(`🚀 ES 探查: [${target.appId}] -> 业务: [${target.bizKey}] (ID: ${target.serviceId})`);
    console.log(`🌐 目标环境: ${envTag}`);
    console.log(`🔗 搜索网关: ${target.searchUrl}`);
    console.log(`📌 配置来源: ${target.source}`);
    console.log(`================================================================\n`);
  }

  // 3. 构建搜索请求参数
  const requestBody = {
    page: Math.max(0, opts.page - 1),
    size: Math.min(100, Math.max(1, opts.schema ? 10 : opts.size))
  };

  if (opts.query) {
    requestBody.query = opts.query;
  }

  if (opts.filter) {
    // 简单 filters 支持
    const filterPairs = opts.filter.split(',');
    const mustFilters = [];
    for (const pair of filterPairs) {
      const [k, v] = pair.split(':');
      if (k && v !== undefined) {
        mustFilters.push({
          field: k.trim(),
          values: [v.trim()],
          operator: 'IN'
        });
      }
    }
    if (mustFilters.length > 0) {
      requestBody.filters = { and: mustFilters };
    }
  }

  // 4. 发送 HTTP POST 请求
  const urlObj = new URL(target.searchUrl);
  const startTime = Date.now();
  const res = await requestHttp({
    protocol: urlObj.protocol,
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'token': target.token
    },
    timeout: 8000
  }, requestBody);

  const durationMs = Date.now() - startTime;

  if (res.statusCode !== 200) {
    console.error(`❌ ES 搜索网关响应异常 (HTTP ${res.statusCode}):`, res.raw);
    process.exit(1);
  }

  const json = res.json;
  if (!json || json.code !== 0) {
    console.error(`❌ ES 平台业务异常 (code: ${json?.code}): ${json?.msg || json?.message || res.raw}`);
    process.exit(1);
  }

  const data = json.data || {};
  const total = data.total ?? 0;
  const docs = data.docs || [];

  if (opts.json) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  // 5. 展示模式 A: 索引结构探查 (--schema)
  if (opts.schema) {
    if (docs.length === 0) {
      console.log(`⚠️ 当前索引暂无数据，无法完成采样推断！`);
      return;
    }
    const schemaItems = analyzeSchema(docs);
    console.log(`📊 索引字段结构推断 (采样 ${docs.length} 条文档，总数据量: ${total}):\n`);
    console.log('| 字段名 (Field) | 推断类型 (Type) | 允许为空 | 示例数据 (Sample Value) |');
    console.log('| :--- | :--- | :--- | :--- |');
    for (const item of schemaItems) {
      const samplePreview = item.sample.length > 50 ? item.sample.substring(0, 47) + '...' : item.sample;
      console.log(`| \`${item.field}\` | **${item.type}** | ${item.nullable} | ${samplePreview || '-'} |`);
    }
    console.log(`\n💡 提示: 上述 Schema 来源于线上/测试真实文档反推，包含索引全量可用查询与过滤字段。`);
    return;
  }

  // 6. 展示模式 B: 数据检索结果
  console.log(`⏱️ 检索耗时: ${durationMs}ms | 命中总数: ${total} 条 | 当前返回: ${docs.length} 条 (第 ${opts.page} 页)\n`);

  if (docs.length === 0) {
    console.log(`(无匹配数据)`);
    return;
  }

  // 展示前 10 条的精简表格
  const displayDocs = docs.slice(0, 10);
  // 提取常见高频展示字段
  const sampleDoc = displayDocs[0] || {};
  const allKeys = Object.keys(sampleDoc);
  const preferredKeys = ['id', 'lockId', 'houseId', 'deviceSn', 'imei', 'status', 'online', 'battery', 'mtime', 'ctime'];
  const columns = preferredKeys.filter(k => allKeys.includes(k));
  if (columns.length < 4) {
    columns.push(...allKeys.filter(k => !columns.includes(k)).slice(0, 6));
  }

  console.log('| # | ' + columns.map(c => `\`${c}\``).join(' | ') + ' |');
  console.log('| :--- | ' + columns.map(() => ':---').join(' | ') + ' |');

  displayDocs.forEach((doc, idx) => {
    const row = columns.map(c => {
      const val = doc[c];
      if (val === null || val === undefined) return '-';
      const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return s.length > 25 ? s.substring(0, 22) + '...' : s;
    });
    console.log(`| ${idx + 1} | ` + row.join(' | ') + ' |');
  });

  if (docs.length > 0) {
    console.log(`\n📄 第一条记录完整快照 (Preview):`);
    console.log(JSON.stringify(docs[0], null, 2));
  }
}

main().catch(err => {
  console.error(`💥 执行发生未捕获异常: ${err.message}`);
  process.exit(1);
});
