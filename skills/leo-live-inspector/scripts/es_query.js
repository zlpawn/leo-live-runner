#!/usr/bin/env node

import {
  createSearchSession,
  loadEsCatalog,
  resolveEsTarget,
  buildSearchRequest,
  parseSearchResponse,
  getEsCatalogFile
} from './common/es_resolver.js';
import { requestHttp } from './common/http.js';
import { saveSearchCookie } from './common/credentials.js';

function printHelp() {
  console.log(`
🔍 Leo Live Inspector - Search 云平台 ES 索引探查与查询工具 (search.ke.com)

用法:
  node scripts/es_query.js --list-indexes [--refresh] [--json]
  node scripts/es_query.js <serviceId|关键词> [选项]

核心场景示例:
  1. 列出当前工号已授权的所有 ES 索引 (脱离项目目录自动发现):
     node scripts/es_query.js --list-indexes

  2. 查看索引有哪些字段、类型、数据源与样本值 (理解字段含义):
     node scripts/es_query.js 1036710001 --schema
     node scripts/es_query.js 订单 --schema -e prod
     node scripts/es_query.js 智能客服 --schema -e test

  3. 查询线上 / 测试环境最新数据:
     node scripts/es_query.js 1036710001 -n 5
     node scripts/es_query.js 门锁 -n 5 -e test

  4. 按关键词 / 字段过滤 / 原生 DSL 查询:
     node scripts/es_query.js 门锁 -q "合肥" --filter "cityCode:340100" -n 5
     node scripts/es_query.js 订单 --filter "city_code:340100,order_status:24" -n 5
     node scripts/es_query.js 1013506001 -e test --dsl '{"query":{"term":{"cityCode":"110000"}}}'

选项说明:
  --list-indexes, --catalog     列出当前工号已授权的所有 ES 索引资产
  --refresh                     强制刷新 search.ke.com 索引目录缓存
  -e, --env <prod|test>         目标环境 (默认: prod 线上环境)
  --role <qa|rd>                测试环境配置视角优先级 (默认自动尝试 QA -> RD)
  --schema, --fields-info       查看完整 Mapping 字段结构、数据源与样本值
  --no-sample                   --schema 模式下不拉取实时样本数据，仅展示 Mapping
  -q, --query <keyword>         查询关键词
  --filter <k:v,k2:v2>          精确键值对过滤 (多条件用英文逗号分隔)
  --dsl <json>                  自定义查询 JSON 请求体 (高级检索 / ES DSL)
  --fields <f1,f2,...>          指定返回/展示的字段列表
  -n, --size <num>              每页条数 (默认: 10, 最大 100)
  -p, --page <num>              页码 (默认: 1)
  --set-cookie <cookie>         手动配置并保存 search.ke.com Cookie
  --cookie <cookie>             单次临时覆盖 search.ke.com Cookie
  --json                        输出结构化 JSON 格式结果
  -h, --help                    查看帮助信息
`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    target: '',
    env: 'prod',
    role: '',
    query: '',
    filter: '',
    dsl: '',
    fields: '',
    size: 10,
    page: 1,
    schema: false,
    noSample: false,
    listIndexes: false,
    refresh: false,
    setCookie: '',
    cookie: '',
    json: false
  };

  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-e' || arg === '--env') {
      options.env = args[++i] || 'prod';
    } else if (arg === '--role') {
      options.role = args[++i] || '';
    } else if (arg === '-s' || arg === '--service') {
      options.target = args[++i] || '';
    } else if (arg === '-q' || arg === '--query') {
      options.query = args[++i] || '';
    } else if (arg === '--filter') {
      options.filter = args[++i] || '';
    } else if (arg === '--dsl') {
      options.dsl = args[++i] || '';
    } else if (arg === '--fields') {
      options.fields = args[++i] || '';
    } else if (arg === '-n' || arg === '--size') {
      options.size = parseInt(args[++i], 10) || 10;
    } else if (arg === '-p' || arg === '--page') {
      options.page = parseInt(args[++i], 10) || 1;
    } else if (arg === '--schema' || arg === '--fields-info') {
      options.schema = true;
    } else if (arg === '--no-sample') {
      options.noSample = true;
    } else if (arg === '--list-indexes' || arg === '--catalog' || arg === '--list' || arg === '--list-services') {
      options.listIndexes = true;
    } else if (arg === '--refresh') {
      options.refresh = true;
    } else if (arg === '--set-cookie') {
      options.setCookie = args[++i] || '';
    } else if (arg === '--cookie') {
      options.cookie = args[++i] || '';
    } else if (arg === '--json') {
      options.json = true;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  if (!options.target && positionals.length > 0) {
    options.target = positionals.join(' ');
  }

  return options;
}

function summarizeValue(val, maxLen = 60) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) {
    if (val.length > 16 && typeof val[0] === 'number') {
      const preview = val.slice(0, 3).map(n => Number(n).toFixed(4)).join(', ');
      return `[vector(${val.length}): ${preview}, ...]`;
    }
    const str = JSON.stringify(val);
    return str.length > maxLen ? `${str.slice(0, maxLen - 3)}...` : str;
  }
  if (typeof val === 'object') {
    const str = JSON.stringify(val);
    return str.length > maxLen ? `${str.slice(0, maxLen - 3)}...` : str;
  }
  const str = String(val).replace(/\s+/g, ' ');
  return str.length > maxLen ? `${str.slice(0, maxLen - 3)}...` : str;
}

function sanitizeDocForPreview(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) {
    if (Array.isArray(v) && v.length > 16 && typeof v[0] === 'number') {
      out[k] = `[dense_vector(${v.length}): ${v.slice(0, 4).map(n => Number(n).toFixed(4)).join(', ')}, ...]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function inferFieldMeaningHint(field, meta = {}, context = {}) {
  const hints = [];
  if (context.routingField && field === context.routingField) {
    hints.push('路由字段');
  }
  if (context.primaryKeys?.has(field)) {
    hints.push('业务主键');
  }
  if (meta.type === 'dense_vector') {
    const modelName = meta.meta?.name ? ` (${meta.meta.name})` : '';
    hints.push(`向量检索(${meta.dims || '?'}维)${modelName}`);
  } else if (meta.type === 'nested') {
    hints.push('嵌套子文档数组');
  } else if (meta.type === 'text') {
    hints.push('全文分词检索');
  } else if (meta.index === false) {
    hints.push('仅存储(不可过滤)');
  }

  const lower = field.toLowerCase();
  const knownHints = [
    [/^(city_?code)$/, '城市编码'],
    [/^(city_?name)$/, '城市名称'],
    [/^(district_?code)$/, '区县/行政区编码'],
    [/^(district_?name)$/, '区县名称'],
    [/^(house_?id|house_?resource_?id|standard_?house_?id)$/, '房源ID'],
    [/^(order_?code|order_?id)$/, '订单编码/ID'],
    [/^(order_?status)$/, '订单状态'],
    [/^(order_?type)$/, '订单类型'],
    [/^(contract_?id)$/, '合同ID'],
    [/^(service_?code)$/, '服务编码'],
    [/^(biz_?code)$/, '业务线编码'],
    [/^(channel_?code)$/, '渠道编码'],
    [/^(del_?status|is_?del|deleted)$/, '删除状态标记'],
    [/^(ctime|create_?time|create_?date)$/, '创建时间'],
    [/^(mtime|update_?time|utime)$/, '更新时间'],
    [/^(battery)$/, '设备电量'],
    [/^(lock_?id|device_?sn|imei)$/, '设备/门锁标识'],
    [/^(signal_?strength)$/, '信号强度']
  ];
  for (const [re, label] of knownHints) {
    if (re.test(lower)) {
      hints.push(label);
      break;
    }
  }
  return hints.join('；') || '-';
}

function extractBinlogSummary(binlogSource = []) {
  const summaries = [];
  const primaryKeys = new Set();

  for (const src of binlogSource) {
    const cluster = src.fromResourceName || src.kafkaCluster || src.cluster || '';
    const topics = Array.isArray(src.fromTopics) ? src.fromTopics.join(', ') : (src.topic || '');
    const tables = [];

    const dbInfos = Array.isArray(src.dbInfos) ? src.dbInfos : [];
    const defaultEndpoint = dbInfos
      .map(d => {
        const dbList = Array.isArray(d.dbs) ? d.dbs.join('/') : '';
        const hostPort = d.host ? (d.port ? `${d.host}:${d.port}` : d.host) : '';
        return [dbList, hostPort].filter(Boolean).join(' @ ');
      })
      .filter(Boolean)
      .join(' ; ');
    const defaultDbName = Array.isArray(src.dbs) ? src.dbs.join(', ') : '';

    if (Array.isArray(src.targetInfos) && src.targetInfos.length > 0) {
      for (const t of src.targetInfos) {
        const tableName = t.table || t.tableName || '';
        const pk = t.gidField || t.primaryKey || t.bizKey || '';
        if (pk) primaryKeys.add(pk);
        tables.push({
          dbName: defaultDbName,
          endpoint: defaultEndpoint,
          tableName,
          primaryKey: pk,
          columns: Array.isArray(t.fields) ? t.fields : []
        });
      }
    } else if (defaultEndpoint || defaultDbName) {
      tables.push({
        dbName: defaultDbName,
        endpoint: defaultEndpoint,
        tableName: '',
        primaryKey: '',
        columns: []
      });
    }

    summaries.push({ cluster, topics, tables });
  }

  return { summaries, primaryKeys };
}

function formatMetaDetails(meta = {}) {
  const parts = [];
  if (meta.analyzer) parts.push(`analyzer:${meta.analyzer}`);
  if (meta.search_analyzer && meta.search_analyzer !== meta.analyzer) {
    parts.push(`search:${meta.search_analyzer}`);
  }
  if (meta.type === 'dense_vector') {
    parts.push(`dims:${meta.dims || '?'}`);
    if (meta.similarity) parts.push(`sim:${meta.similarity}`);
  }
  if (meta.type === 'nested' && meta.properties) {
    const subs = Object.entries(meta.properties)
      .map(([k, v]) => `${k}:${v?.type || 'unknown'}`)
      .join(', ');
    parts.push(`子字段: { ${subs} }`);
  }
  return parts.join('; ') || '-';
}

function escapeCell(text) {
  return String(text ?? '-').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ');
}

async function executeSearchGateway(target, requestBody) {
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
      ...(target.token ? { 'token': target.token } : {})
    },
    timeout: 10000
  }, requestBody);
  const durationMs = Date.now() - startTime;

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`ES 搜索网关响应异常 (HTTP ${res.statusCode}): ${res.error || res.raw?.slice(0, 300)}`);
  }
  const { total, docs } = parseSearchResponse(target, res.json);
  return { total, docs, durationMs, raw: res.json };
}

function buildSchemaEntries(target, sampleDocs = []) {
  const mapping = target.mapping || {};
  const { primaryKeys } = extractBinlogSummary(target.binlogSource);
  const fieldNames = new Set(Object.keys(mapping));

  for (const doc of sampleDocs) {
    for (const key of Object.keys(doc || {})) {
      if (key !== '_id') fieldNames.add(key);
    }
  }

  const samplesByField = new Map();
  for (const doc of sampleDocs) {
    for (const [k, v] of Object.entries(doc || {})) {
      if (v === null || v === undefined || v === '') continue;
      if (!samplesByField.has(k)) {
        samplesByField.set(k, v);
      }
    }
  }

  return Array.from(fieldNames).map(field => {
    const meta = mapping[field] || {};
    const sampleVal = samplesByField.has(field) ? samplesByField.get(field) : undefined;
    const inferredType = meta.type || (
      sampleVal === undefined
        ? 'unknown'
        : Array.isArray(sampleVal)
          ? 'array'
          : typeof sampleVal === 'number'
            ? (Number.isInteger(sampleVal) ? 'long/integer' : 'float/double')
            : typeof sampleVal
    );
    return {
      field,
      type: inferredType,
      searchable: meta.index === false ? false : true,
      isRouting: target.routingField === field,
      details: formatMetaDetails(meta),
      meaningHint: inferFieldMeaningHint(field, meta, {
        routingField: target.routingField,
        primaryKeys
      }),
      sample: sampleVal !== undefined ? summarizeValue(sampleVal, 50) : '-'
    };
  });
}

async function handleListIndexes(opts) {
  const session = createSearchSession({ explicitCookie: opts.cookie });
  const { list, fromCache } = await loadEsCatalog(session, { forceRefresh: opts.refresh });

  if (opts.json) {
    console.log(JSON.stringify({
      success: true,
      fromCache,
      cacheFile: getEsCatalogFile(),
      total: list.length,
      indexes: list
    }, null, 2));
    return;
  }

  console.log(`\n📚 Search 云平台已授权 ES 索引目录 (共 ${list.length} 个${fromCache ? '，来自本地缓存，可用 --refresh 强制同步' : '，已实时同步'}):\n`);
  console.log('| Service ID | 系统号 | 索引名称 | 索引描述 | 接入方式 | 状态 |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const item of list) {
    console.log(`| \`${item.serviceId}\` | ${item.appSysCode ?? '-'} | ${item.name || '-'} | ${item.demandDesc || '-'} | ${item.accessType} | ${item.status || '-'} |`);
  }
  console.log(`\n💡 提示: 可直接按 Service ID 或名称关键词查询结构与数据，例如:`);
  if (list[0]) {
    console.log(`   node scripts/es_query.js ${list[0].serviceId} --schema`);
    console.log(`   node scripts/es_query.js ${list[0].serviceId} -n 5\n`);
  }
}

async function handleSchema(target, opts) {
  let sampleDocs = [];
  let sampleError = '';
  if (!opts.noSample) {
    try {
      const reqBody = buildSearchRequest(target, { page: 1, size: 3 });
      const res = await executeSearchGateway(target, reqBody);
      sampleDocs = res.docs;
    } catch (err) {
      sampleError = err.message;
    }
  }

  const schemaEntries = buildSchemaEntries(target, sampleDocs);
  const { summaries } = extractBinlogSummary(target.binlogSource);

  if (opts.json) {
    console.log(JSON.stringify({
      success: true,
      target: {
        serviceId: target.serviceId,
        name: target.name,
        demandDesc: target.demandDesc,
        env: target.env,
        version: target.version,
        configSource: target.configSource,
        indexName: target.indexName,
        accessType: target.accessType,
        gatewayMode: target.gatewayMode,
        searchUrl: target.searchUrl,
        routingField: target.routingField,
        searchCount: target.searchCount,
        readLimit: target.readLimit,
        topQps: target.topQps
      },
      binlogSource: summaries,
      gidApiTask: target.gidApiTask,
      godApiTask: target.godApiTask,
      fields: schemaEntries,
      sampleError: sampleError || undefined
    }, null, 2));
    return;
  }

  const envTag = target.env === 'test' ? '🟡 测试环境 (TEST)' : '🔴 生产环境 (PROD)';
  console.log(`================================================================`);
  console.log(`🔎 ES 索引字段与结构详情: [${target.name || target.serviceId}] (ID: ${target.serviceId})`);
  console.log(`📝 业务描述: ${target.demandDesc || '-'} | 接入方式: ${target.accessType} | 网关模式: ${target.gatewayMode}`);
  console.log(`🌐 目标环境: ${envTag} | 配置来源: ${target.configSource}`);
  console.log(`📦 物理索引: ${target.indexName || '-'} | 数据总量: ${target.searchCount ?? '-'} | 限流: ${target.readLimit ?? '-'} | 最高QPS: ${target.topQps ?? '-'}`);
  if (target.routingField) {
    console.log(`🧭 路由字段: ${target.routingField}`);
  }
  console.log(`================================================================\n`);

  if (summaries.length > 0) {
    console.log(`📡 数据监听源 (Binlog/Kafka -> ES 字段语义参考):`);
    for (const s of summaries) {
      if (s.topics) console.log(`  - Kafka Topic: ${s.topics}${s.cluster ? ` (集群: ${s.cluster})` : ''}`);
      for (const t of s.tables) {
        const tableLabel = t.dbName && t.tableName ? `${t.dbName}.${t.tableName}` : (t.tableName || t.dbName);
        const pkLabel = t.primaryKey ? ` | 业务主键: ${t.primaryKey}` : '';
        const colLabel = t.columns?.length ? ` | 监听字段数: ${t.columns.length}` : '';
        console.log(`  - MySQL: ${tableLabel}${t.endpoint ? ` (${t.endpoint})` : ''}${pkLabel}${colLabel}`);
      }
    }
    console.log('');
  }

  if (target.gidApiTask?.api?.length || target.godApiTask?.api?.length) {
    console.log(`🔄 数据拉取回调:`);
    for (const item of target.gidApiTask?.api || []) {
      if (item.url) console.log(`  - 全量回调: ${item.url}`);
    }
    for (const item of target.godApiTask?.api || []) {
      if (item.url) console.log(`  - 增量回调: ${item.url}`);
    }
    console.log('');
  }

  console.log(`📊 索引字段清单 (共 ${schemaEntries.length} 个字段):\n`);
  console.log('| 字段名 (Field) | ES 类型 | 可检索 | 特性 / 嵌套子字段 | 语义提示 | 真实样本值 (Sample) |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const item of schemaEntries) {
    console.log(`| \`${escapeCell(item.field)}\` | **${escapeCell(item.type)}** | ${item.searchable ? '是' : '否'} | ${escapeCell(item.details)} | ${escapeCell(item.meaningHint)} | ${escapeCell(item.sample)} |`);
  }

  if (sampleError) {
    console.log(`\n⚠️ 样本数据拉取失败 (${sampleError})，以上结构完全来自 search.ke.com 官方 Mapping。`);
  }
  console.log('');
}

async function handleQuery(target, opts) {
  const sourceFields = opts.fields
    ? opts.fields.split(',').map(f => f.trim()).filter(Boolean)
    : [];

  const requestBody = buildSearchRequest(target, {
    query: opts.query,
    filter: opts.filter,
    dsl: opts.dsl,
    page: opts.page,
    size: opts.size,
    sourceFields,
    excludeVectors: !opts.json && sourceFields.length === 0
  });

  const { total, docs, durationMs, raw } = await executeSearchGateway(target, requestBody);

  if (opts.json) {
    console.log(JSON.stringify({
      success: true,
      target: {
        serviceId: target.serviceId,
        name: target.name,
        env: target.env,
        gatewayMode: target.gatewayMode,
        searchUrl: target.searchUrl
      },
      durationMs,
      total,
      page: opts.page,
      size: opts.size,
      docs,
      raw
    }, null, 2));
    return;
  }

  const envTag = target.env === 'test' ? '🟡 测试环境 (TEST)' : '🔴 生产环境 (PROD)';
  console.log(`\n================================================================`);
  console.log(`🚀 ES 检索: [${target.name || target.serviceId}] (ID: ${target.serviceId})`);
  console.log(`🌐 目标环境: ${envTag} | 模式: ${target.gatewayMode} | 来源: ${target.configSource}`);
  console.log(`🔗 搜索网关: ${target.searchUrl}`);
  if (target.candidates.length > 1) {
    console.log(`ℹ️ 关键词匹配到多个索引，已优选首位；全部匹配: ${target.candidates.map(c => `${c.serviceId}(${c.name})`).join(', ')}`);
  }
  console.log(`================================================================\n`);

  console.log(`⏱️ 检索耗时: ${durationMs}ms | 命中总数: ${total} 条 | 当前返回: ${docs.length} 条 (第 ${opts.page} 页)\n`);

  if (docs.length === 0) {
    console.log('(无匹配数据)');
    return;
  }

  const displayDocs = docs.slice(0, 20);
  const allKeys = Array.from(new Set(displayDocs.flatMap(d => Object.keys(d || {}))));
  const vectorSet = new Set(
    Object.entries(target.mapping || {})
      .filter(([, meta]) => meta?.type === 'dense_vector')
      .map(([name]) => name)
  );

  let columns;
  if (sourceFields.length > 0) {
    columns = sourceFields.filter(f => allKeys.includes(f));
  } else {
    const scalarKeys = allKeys.filter(k => !vectorSet.has(k) && k !== '_id');
    const preferred = [
      target.routingField,
      'id', 'order_code', 'houseId', 'house_resource_id', 'lockId', 'deviceSn',
      'cityCode', 'city_code', 'cityName', 'status', 'order_status', 'battery',
      'titleText', 'content', 'mtime', 'ctime', 'create_time'
    ].filter(Boolean);
    columns = preferred.filter(k => scalarKeys.includes(k));
    for (const k of scalarKeys) {
      if (columns.length >= 8) break;
      if (!columns.includes(k)) columns.push(k);
    }
    if (columns.length === 0) {
      columns = allKeys.slice(0, 6);
    }
  }

  console.log('| # | ' + columns.map(c => `\`${c}\``).join(' | ') + ' |');
  console.log('| :--- | ' + columns.map(() => ':---').join(' | ') + ' |');
  displayDocs.forEach((doc, idx) => {
    const row = columns.map(c => summarizeValue(doc[c], 32) || '-');
    console.log(`| ${idx + 1} | ` + row.join(' | ') + ' |');
  });

  console.log(`\n📄 第一条记录快照 (Preview):`);
  console.log(JSON.stringify(sanitizeDocForPreview(docs[0]), null, 2));
}

async function main() {
  const opts = parseCliArgs();

  if (opts.setCookie) {
    saveSearchCookie(opts.setCookie);
    console.log('✅ search.ke.com Cookie 已保存。');
    return;
  }

  if (opts.listIndexes) {
    await handleListIndexes(opts);
    return;
  }

  if (!opts.target) {
    console.error('❌ 缺少目标索引参数！请提供 serviceId（如 1036710001）或索引名称关键词（如 订单），或使用 --list-indexes 查看目录。');
    printHelp();
    process.exit(1);
  }

  const target = await resolveEsTarget(opts.target, opts.env, {
    role: opts.role,
    cookie: opts.cookie,
    refresh: opts.refresh
  });

  if (opts.schema) {
    await handleSchema(target, opts);
  } else {
    await handleQuery(target, opts);
  }
}

main().catch(err => {
  console.error(`💥 执行异常: ${err.message}`);
  process.exit(1);
});
