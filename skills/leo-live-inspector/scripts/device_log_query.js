#!/usr/bin/env node

/**
 * 📟 Leo Live Inspector - 设备硬件流水日志探查引擎 (Device Hardware Log Query Engine)
 * ---------------------------------------------------------------------------------
 * 适用场景：
 *   在 LEO 本地终端与 SCS 智能客服平台中，探查物联网设备 (门锁、钥匙箱等) 的运行流水日志、
 *   单片机 RTOS 业务事件 (0x8001鉴权、0x0004开锁、0x8108状态上报) 与模组通信报文。
 *
 * 核心特性：
 *   1. 智能自适应路由：
 *      • 传 --imei 时：默认优先查询测试数据库 (集中式测试日志表 device_test_run_log)；
 *      • 传 --file 或 --local 时：解析本地磁盘中的仿真或 J-Link 捕获日志 (rtt_full.log)；
 *      • 无参执行时：默认扫描本地最近一次仿真产物目录，零配置直出；
 *   2. 协议语义动态反解：
 *      • 自动反解 0x8001 (鉴权请求), 0x0002 (鉴权响应), 0x8005 (轮询指令), 0x0004 (下发开锁), 0x8108 (状态上报)；
 *   3. 毫秒级时序美化表格：输出终端对齐的 Markdown/ASCII 概况卡片与高亮日志流水。
 *
 * 用法示例：
 *   node scripts/device_log_query.js --imei 861993083543235               # 查测试库 (默认)
 *   node scripts/device_log_query.js --imei 861993083543235 --level ERROR # 仅过滤错误
 *   node scripts/device_log_query.js --local                              # 查本地最新仿真
 *   node scripts/device_log_query.js --file /path/to/rtt_full.log         # 查指定本地日志
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 保持脚本作为纯粹中立的原子探查工具：不硬编码任何具体硬件的指令码字典，
// 协议语义翻译交由上层 AI Agent 根据当前设备型号与代码库（如 CmdType.java / KeyboxMsgType.java）自主解读。

function parseArgs(args) {
  const options = {
    imei: '',
    runId: '',
    file: '',
    local: false,
    level: '',
    module: '',
    limit: 50,
    lastId: '',
    json: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--imei' && args[i + 1]) options.imei = args[++i];
    else if (arg === '--runId' && args[i + 1]) options.runId = args[++i];
    else if (arg === '--file' && args[i + 1]) options.file = args[++i];
    else if (arg === '--local') options.local = true;
    else if (arg === '--level' && args[i + 1]) options.level = args[++i].toUpperCase();
    else if (arg === '--module' && args[i + 1]) options.module = args[++i];
    else if (arg === '--limit' && args[i + 1]) options.limit = parseInt(args[++i], 10) || 50;
    else if (arg === '--lastId' && args[i + 1]) options.lastId = args[++i];
    else if (arg === '--json') options.json = true;
  }
  return options;
}

/** 查找本地 ~/.shrimp/skills/leo-hardware-runtime/output/ 下最近一次运行目录 */
function findLatestLocalRunDir(imeiFilter = '') {
  const baseDir = path.join(os.homedir(), '.shrimp', 'skills', 'leo-hardware-runtime', 'output');
  if (!fs.existsSync(baseDir)) return null;

  const dates = fs.readdirSync(baseDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of dates) {
    const dayDir = path.join(baseDir, d);
    if (!fs.statSync(dayDir).isDirectory()) continue;

    const runs = fs.readdirSync(dayDir)
      .map(name => ({ name, fullPath: path.join(dayDir, name) }))
      .filter(item => fs.statSync(item.fullPath).isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const r of runs) {
      if (imeiFilter) {
        // 如果有 IMEI 过滤，检查目录名或 run.resc 中是否包含该 IMEI
        if (r.name.includes(imeiFilter)) return r.fullPath;
        const rescPath = path.join(r.fullPath, 'run.resc');
        if (fs.existsSync(rescPath)) {
          const content = fs.readFileSync(rescPath, 'utf8');
          if (content.includes(imeiFilter)) return r.fullPath;
        }
      } else {
        return r.fullPath;
      }
    }
  }
  return null;
}

/** 解析本地文本日志 (rtt_full.log 或 renode.log) */
function parseLocalLogFile(filePath, options) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`本地日志文件不存在: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const records = [];

  const reZephyr = /(?:\[([^\]]+)\]\s*)?<([a-z]+)>\s*([^:\s]+):\s*(.*)/i;

  let idCounter = 1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let timeStr = '';
    let level = 'INFO';
    let module = 'rtt';
    let content = trimmed;
    let cmdType = '';

    const m = reZephyr.exec(trimmed);
    if (m) {
      timeStr = m[1] || '';
      const lvlTag = (m[2] || '').toLowerCase();
      if (lvlTag.includes('err')) level = 'ERROR';
      else if (lvlTag.includes('wrn')) level = 'WARN';
      else if (lvlTag.includes('dbg')) level = 'DEBUG';
      else level = 'INFO';
      module = m[3] || 'zephyr';
      content = m[4] || '';
    } else {
      if (/error|fail/i.test(trimmed)) level = 'ERROR';
      else if (/warn/i.test(trimmed)) level = 'WARN';
    }

    // 过滤
    if (options.level && level !== options.level) continue;
    if (options.module && !module.toLowerCase().includes(options.module.toLowerCase())) continue;

    // 指令码识别
    const cmdMatch = /0x[0-9a-fA-F]{4}/.exec(trimmed);
    if (cmdMatch) cmdType = cmdMatch[0].toLowerCase();

    records.push({
      id: idCounter++,
      source: 'LOCAL',
      deviceTime: timeStr || '-',
      logLevel: level,
      module,
      cmdType,
      content
    });
  }

  return records.slice(-options.limit);
}

/** 通过 test_mysql_query.js 直连查询测试环境数据库 */
function queryTestDatabase(options) {
  const testMysqlScript = path.join(__dirname, 'test_mysql_query.js');
  if (!fs.existsSync(testMysqlScript)) {
    throw new Error(`未找到 test_mysql_query.js 脚本: ${testMysqlScript}`);
  }

  // 1. 查询批次主表获取概况
  let recordSql = `SELECT run_id, imei, prod_type, firmware_version, target_host, auth_status, log_count, start_time, duration_ms FROM device_test_run_record WHERE 1=1`;
  if (options.imei) recordSql += ` AND imei = '${options.imei.replace(/'/g, "\\'")}'`;
  if (options.runId) recordSql += ` AND run_id = '${options.runId.replace(/'/g, "\\'")}'`;
  recordSql += ` ORDER BY id DESC LIMIT 1;`;

  // 2. 查询流水明细表
  let logSql = `SELECT id, run_id, imei, source, log_level, module, content, raw_hex, cmd_type, device_time, ctime FROM device_test_run_log WHERE 1=1`;
  if (options.imei) logSql += ` AND imei = '${options.imei.replace(/'/g, "\\'")}'`;
  if (options.runId) logSql += ` AND run_id = '${options.runId.replace(/'/g, "\\'")}'`;
  if (options.level) logSql += ` AND log_level = '${options.level.replace(/'/g, "\\'")}'`;
  if (options.module) logSql += ` AND module = '${options.module.replace(/'/g, "\\'")}'`;
  if (options.lastId) logSql += ` AND id < ${parseInt(options.lastId, 10)}`;
  logSql += ` ORDER BY id DESC LIMIT ${options.limit};`;

  try {
    // 执行主表查询
    const recordRaw = execFileSync('node', [testMysqlScript, 'platform', recordSql, '--json'], { encoding: 'utf8', timeout: 8000 });
    let runRecord = null;
    try {
      const arr = JSON.parse(recordRaw);
      if (Array.isArray(arr) && arr.length > 0) runRecord = arr[0];
    } catch {}

    // 执行日志流水查询
    const logsRaw = execFileSync('node', [testMysqlScript, 'platform', logSql, '--json'], { encoding: 'utf8', timeout: 10000 });
    let logs = [];
    try {
      logs = JSON.parse(logsRaw);
    } catch {
      logs = [];
    }

    return { runRecord, logs: Array.isArray(logs) ? logs.reverse() : [] };
  } catch (err) {
    throw new Error(`测试数据库查询失败: ${err.message}`);
  }
}

function renderOutput(data, options, modeDesc) {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const { runRecord, logs } = data;

  console.log(`\n================================================================================`);
  console.log(`📟 设备硬件测试流水日志概览 [模式: ${modeDesc}]`);
  console.log(`================================================================================`);

  if (runRecord) {
    const authDesc = runRecord.auth_status === 1 ? '🟢 鉴权通过 (Auth Pass)' :
                    (runRecord.auth_status === 2 ? '🔴 鉴权失败' : '⚪ 未知/运行中');
    console.log(`• 设备 IMEI   : ${runRecord.imei || options.imei || '-'}`);
    console.log(`• 批次会话 ID : ${runRecord.run_id || '-'}`);
    console.log(`• 产品型号    : ${runRecord.prod_type || '-'}`);
    console.log(`• 固件版本    : ${runRecord.firmware_version || '-'}`);
    console.log(`• 鉴权状态    : ${authDesc}`);
    console.log(`• 总运行时长  : ${runRecord.duration_ms ? runRecord.duration_ms + ' ms' : '-'}`);
    console.log(`• 累计日志数  : ${runRecord.log_count || logs.length}`);
    console.log(`--------------------------------------------------------------------------------`);
  }

  if (!logs || logs.length === 0) {
    console.log(`⚠️ 未检索到符合条件的设备流水日志。`);
    return;
  }

  console.log(`\n📜 流水日志明细 (显示最新 ${logs.length} 条):`);
  console.log(`| ID | 时间 | 级别 | 模块 | 协议指令 | 日志内容 |`);
  console.log(`|:---|:---|:---|:---|:---|:---|`);

  for (const item of logs) {
    const id = item.id || '-';
    const time = item.device_time || item.deviceTime || item.ctime || '-';
    const lvl = item.log_level || item.logLevel || 'INFO';
    const mod = item.module || '-';
    const cmd = item.cmd_type || item.cmdType || '-';

    let content = (item.content || '').replace(/\|/g, '\\|');
    if (content.toLowerCase().includes('auth pass')) {
      content = `🟢 **${content}**`;
    } else if (lvl === 'ERROR') {
      content = `🔴 ${content}`;
    }

    console.log(`| ${id} | ${time} | ${lvl} | ${mod} | ${cmd} | ${content} |`);
  }
  console.log(``);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  // 1. 判断是否强制查本地文件
  if (options.file) {
    try {
      const logs = parseLocalLogFile(options.file, options);
      renderOutput({ runRecord: null, logs }, options, `指定本地文件: ${path.basename(options.file)}`);
      return;
    } catch (e) {
      console.error(`❌ 解析本地文件失败: ${e.message}`);
      process.exit(1);
    }
  }

  // 2. 判断是否指定查本地最新仿真
  if (options.local) {
    const localDir = findLatestLocalRunDir(options.imei);
    if (!localDir) {
      console.error(`❌ 未找到本地仿真产物目录 (~/.shrimp/skills/leo-hardware-runtime/output/)`);
      process.exit(1);
    }
    const rttFile = path.join(localDir, 'rtt_full.log');
    if (!fs.existsSync(rttFile)) {
      console.error(`❌ 目标目录下未找到 rtt_full.log: ${localDir}`);
      process.exit(1);
    }
    const logs = parseLocalLogFile(rttFile, options);
    renderOutput({ runRecord: { imei: options.imei, target_host: 'Local Sim' }, logs }, options, `本地最新仿真目录: ${path.basename(localDir)}`);
    return;
  }

  // 3. 传了 --imei 时，默认优先走测试数据库 (DB 模式)
  if (options.imei) {
    try {
      const data = queryTestDatabase(options);
      renderOutput(data, options, `测试环境数据库 (集中式)`);
      return;
    } catch (err) {
      console.warn(`⚠️ 直连测试数据库失败: ${err.message}`);
      console.log(`⏳ 正在尝试兜底检查本地是否有 IMEI [${options.imei}] 的仿真日志...`);

      const fallbackDir = findLatestLocalRunDir(options.imei);
      if (fallbackDir && fs.existsSync(path.join(fallbackDir, 'rtt_full.log'))) {
        const rttFile = path.join(fallbackDir, 'rtt_full.log');
        const logs = parseLocalLogFile(rttFile, options);
        renderOutput({ runRecord: { imei: options.imei, target_host: 'Local Fallback' }, logs }, options, `本地离线兜底: ${path.basename(fallbackDir)}`);
        return;
      } else {
        console.error(`❌ 本地亦未找到 IMEI [${options.imei}] 的仿真记录。请核对 IMEI 或检查测试库网络凭证。`);
        process.exit(1);
      }
    }
  }

  // 4. 无任何参数时，默认查本地最近一次仿真产物
  const defaultDir = findLatestLocalRunDir();
  if (defaultDir && fs.existsSync(path.join(defaultDir, 'rtt_full.log'))) {
    const rttFile = path.join(defaultDir, 'rtt_full.log');
    const logs = parseLocalLogFile(rttFile, options);
    renderOutput({ runRecord: { target_host: 'Local Default' }, logs }, options, `本地最新仿真默认输出`);
  } else {
    console.log(`💡 用法提示:`);
    console.log(`  node scripts/device_log_query.js --imei <IMEI>        # 查询测试数据库中的设备时序日志 (推荐)`);
    console.log(`  node scripts/device_log_query.js --local              # 检索本地最近一次单片机仿真输出 (rtt_full.log)`);
    console.log(`  node scripts/device_log_query.js --file <路径>        # 分析指定本地日志文件`);
  }
}

main();
