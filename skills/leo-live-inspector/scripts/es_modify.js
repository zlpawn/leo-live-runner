#!/usr/bin/env node

import fs from 'node:fs';
import {
  resolveEsTarget,
  buildSearchRequest,
  parseSearchResponse
} from './common/es_resolver.js';
import { requestHttp } from './common/http.js';
import { assertWritePermitted } from './common/env_detector.js';

function printHelp() {
  console.log(`
🛡️ Leo Live Inspector - ES 测试环境安全修改工具 (CRUD)

⚠️ 【安全原则】:
  - 生产环境 (PROD) 严格禁止执行任何写操作！代码物理阻断。
  - 测试环境修改强制采用两阶段确认：未传 --confirm 时仅执行 Pre-flight (Dry-Run) 并展示 Diff。

用法:
  node scripts/es_modify.js <serviceId|关键词> --action <action> --id <docId> [选项]

核心场景示例:
  1. 测试环境更新部分字段 (Dry-Run 预审模式):
     node scripts/es_modify.js 1013810021 --action update-part --id "10001" --data '{"battery": 88}' -e test

  2. 测试环境确认提交更新:
     node scripts/es_modify.js 1013810021 --action update-part --id "10001" --data '{"battery": 88}' -e test --confirm

  3. 测试环境删除记录 (预审与确认):
     node scripts/es_modify.js 门锁 --action delete --id "10001" -e test
     node scripts/es_modify.js 门锁 --action delete --id "10001" -e test --confirm

选项说明:
  -s, --service <target>        目标 serviceId 或索引名称关键词 (也可直接作为位置参数传入)
  -e, --env <test|prod>         目标环境 (必须为 test，prod 会被物理拦截)
      --role <qa|rd>            测试环境配置视角优先级 (默认自动尝试 QA -> RD)
      --action <action>         动作类型: insert | update | update-part | delete
      --id <docId>              文档主键 ID (对应 ES 索引中的唯一主键)
      --data <json|@file.json>  写入的数据 JSON 字符串或 @文件路径
      --cookie <cookie>         单次临时覆盖 search.ke.com Cookie
      --confirm                 确认正式提交写入 (未加时仅输出 Dry-Run Diff 对比)
  -h, --help                    查看帮助信息
`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    target: '',
    env: 'test',
    role: '',
    action: '',
    id: '',
    data: '',
    cookie: '',
    confirm: false
  };

  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-s' || arg === '--service') {
      options.target = args[++i] || '';
    } else if (arg === '-a' || arg === '--app') {
      // 兼容旧参数：若同时未传 -s，则保留但提醒以索引为入口
      if (!options.target) options.target = args[++i] || '';
      else args[++i];
    } else if (arg === '-e' || arg === '--env') {
      options.env = args[++i] || 'test';
    } else if (arg === '--role') {
      options.role = args[++i] || '';
    } else if (arg === '--action') {
      options.action = (args[++i] || '').toLowerCase();
    } else if (arg === '--id') {
      options.id = args[++i] || '';
    } else if (arg === '--data') {
      options.data = args[++i] || '';
    } else if (arg === '--cookie') {
      options.cookie = args[++i] || '';
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  if (!options.target && positionals.length > 0) {
    options.target = positionals.join(' ');
  }

  return options;
}

/**
 * 尝试通过 ID 查询现有记录 (Before State)
 */
async function fetchCurrentDoc(target, docId) {
  try {
    const reqBody = buildSearchRequest(target, {
      query: docId,
      page: 1,
      size: 10
    });
    const urlObj = new URL(target.searchUrl);
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
      timeout: 5000
    }, reqBody);

    if (res.statusCode >= 200 && res.statusCode < 300 && res.json) {
      const { docs } = parseSearchResponse(target, res.json);
      const matched = docs.find(d =>
        String(d._id || d.id || d.lockId || d.houseId || d.orderId || d.order_code || '') === String(docId)
      );
      return matched || docs[0] || null;
    }
  } catch {}
  return null;
}

function blockProductionWrite(reason, writeUrl = '') {
  console.error('\n' + '='.repeat(68));
  console.error('🚨【风控红线拦截】生产环境 (PROD) 严格禁止执行任何新增/修改/删除操作！');
  console.error(`📌 拦截原因: ${reason}`);
  if (writeUrl) console.error(`🔗 目标写入网关: ${writeUrl}`);
  console.error('💡 线上生产环境仅支持只读查询，请使用 scripts/es_query.js 进行排查。');
  console.error('='.repeat(68) + '\n');
  process.exit(1);
}

async function main() {
  const opts = parseCliArgs();

  if (!opts.target) {
    console.error('❌ 缺少必须参数: 目标 serviceId 或索引名称关键词');
    printHelp();
    process.exit(1);
  }

  if (!opts.action) {
    console.error('❌ 缺少必须参数: 动作类型 (--action <insert|update|update-part|delete>)');
    printHelp();
    process.exit(1);
  }

  if (!opts.id) {
    console.error('❌ 缺少必须参数: 文档主键 ID (--id <docId>)');
    printHelp();
    process.exit(1);
  }

  const validActions = ['insert', 'update', 'update-part', 'delete'];
  if (!validActions.includes(opts.action)) {
    console.error(`❌ 无效动作类型 [${opts.action}]，支持的值: ${validActions.join(', ')}`);
    process.exit(1);
  }

  const normDeclared = String(opts.env || '').trim().toLowerCase();
  if (normDeclared === 'prod' || normDeclared === 'production' || normDeclared === 'online') {
    blockProductionWrite('用户显式指定了生产环境 (-e prod)，严格禁止执行写操作！');
  }

  // 1. 解析目标索引配置
  const target = await resolveEsTarget(opts.target, opts.env, {
    role: opts.role,
    cookie: opts.cookie
  });

  if (!target.writeUrl) {
    console.error(`❌ 索引 [${target.name || target.serviceId}] (${target.configSource}) 未配置数据推送/写入网关 (push)，无法执行修改！`);
    process.exit(1);
  }

  // 2. 🛡️ 核心风控安全检查 (严格拦截线上写操作)
  const writeCheck = assertWritePermitted(opts.env, target.writeUrl);
  if (!writeCheck.allowed) {
    blockProductionWrite(writeCheck.reason, target.writeUrl);
  }

  // 3. 解析传入的数据 (若为 insert/update)
  let payloadData = null;
  if (opts.action !== 'delete') {
    if (!opts.data) {
      console.error('❌ insert/update/update-part 操作必须提供数据参数 (--data <json>)');
      process.exit(1);
    }
    let rawData = opts.data.trim();
    if (rawData.startsWith('@')) {
      const filePath = rawData.slice(1);
      if (!fs.existsSync(filePath)) {
        console.error(`❌ 数据文件不存在: ${filePath}`);
        process.exit(1);
      }
      rawData = fs.readFileSync(filePath, 'utf8');
    }
    try {
      payloadData = JSON.parse(rawData);
    } catch (e) {
      console.error(`❌ 数据 JSON 格式非法: ${e.message}`);
      process.exit(1);
    }
  }

  // 4. 读取变更前快照 (Before State)
  const beforeDoc = await fetchCurrentDoc(target, opts.id);

  // 5. 阶段一：未带 --confirm 时执行 Pre-flight (Dry-Run)
  if (!opts.confirm) {
    console.log(`\n================================================================`);
    console.log(`🔍 Pre-flight Dry-Run (安全预审模式 - 暂未写入)`);
    console.log(`🎯 目标索引: [${target.name || target.serviceId}] (ID: ${target.serviceId})`);
    console.log(`🌐 目标环境: 🟡 测试环境 (TEST) | 配置来源: ${target.configSource}`);
    console.log(`🔗 写入网关: ${target.writeUrl}`);
    console.log(`⚡ 拟执行动作: ${opts.action.toUpperCase()} (文档ID: ${opts.id})`);
    console.log(`================================================================\n`);

    if (opts.action === 'delete') {
      console.log(`⚠️ 【高危操作提示】准备从测试环境 ES 中彻底删除以下记录:`);
      if (beforeDoc) {
        console.log(JSON.stringify(beforeDoc, null, 2));
      } else {
        console.log(`(当前查询未找到 ID 为 [${opts.id}] 的现有记录，删除操作仍将提交至网关)`);
      }
    } else {
      console.log(`📋 字段变更明细预览 (Diff Preview):\n`);
      console.log('| 变更字段 (Field) | 变更前现有值 (Before) | 拟写入新值 (After) |');
      console.log('| :--- | :--- | :--- |');

      for (const [key, newVal] of Object.entries(payloadData)) {
        const oldVal = beforeDoc ? beforeDoc[key] : '(新记录/不存在)';
        const oldStr = typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal ?? '-');
        const newStr = typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal ?? '-');
        console.log(`| \`${key}\` | ${oldStr} | **${newStr}** |`);
      }
    }

    console.log(`\n----------------------------------------------------------------`);
    console.log(`⚠️ 注意: 当前处于 Dry-Run 预审模式，测试数据未发生任何实质变更！`);
    console.log(`✅ 确认无误后，请追加 \`--confirm\` 参数再次运行以正式提交修改:`);
    console.log(`👉 node scripts/es_modify.js ${process.argv.slice(2).filter(a => a !== '--confirm').join(' ')} --confirm`);
    console.log(`----------------------------------------------------------------\n`);
    return;
  }

  // 6. 阶段二：带 --confirm 时正式提交写入
  console.log(`\n🚀 正在向测试环境 ES 写入数据...`);

  let apiAction = 'UPDATE_PART';
  if (opts.action === 'insert' || opts.action === 'update') {
    apiAction = 'UPDATE';
  } else if (opts.action === 'delete') {
    apiAction = 'DELETE';
  }

  const reqItem = {
    id: String(opts.id),
    action: apiAction,
    timestamp: Date.now(),
    version: 'v1.0'
  };
  if (opts.action !== 'delete') {
    reqItem.data = payloadData;
  }

  const requestBody = [reqItem];

  const urlObj = new URL(target.writeUrl);
  const startTime = Date.now();
  const res = await requestHttp({
    protocol: urlObj.protocol,
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...(target.writeToken ? { 'token': target.writeToken } : {})
    },
    timeout: 8000
  }, requestBody);

  const durationMs = Date.now() - startTime;

  if (res.statusCode < 200 || res.statusCode >= 300) {
    console.error(`❌ ES 写入网关响应异常 (HTTP ${res.statusCode}):`, res.raw);
    process.exit(1);
  }

  const json = res.json;
  if (json && json.code !== 0 && json.code !== 1 && !json.success) {
    console.error(`❌ 写入失败 (code: ${json.code}): ${json.message || json.msg || res.raw}`);
    process.exit(1);
  }

  console.log(`✅ 写入指令提交成功! (耗时: ${durationMs}ms, 网关响应: ${json?.message || 'OK'})`);

  // 7. 回查验证 (Verification Step)
  console.log(`🔍 正在回查验证最新状态...`);
  await new Promise(r => setTimeout(r, 800));

  const afterDoc = await fetchCurrentDoc(target, opts.id);
  if (afterDoc) {
    console.log(`\n📄 最新记录快照 (After State):`);
    console.log(JSON.stringify(afterDoc, null, 2));
  } else if (opts.action === 'delete') {
    console.log(`✅ 验证通过: 记录已从索引中清除或已标记删除。`);
  } else {
    console.log(`ℹ️ 写入已受理，ES 索引同步中。`);
  }
}

main().catch(err => {
  console.error(`💥 执行发生未捕获异常: ${err.message}`);
  process.exit(1);
});
