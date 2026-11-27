#!/usr/bin/env node

/**
 * 📟 Leo Live Inspector - 设备硬件/嵌入式底层测试流水探查引擎 (Device Hardware Log Query Engine)
 * -----------------------------------------------------------------------------------------
 * 适用场景：
 *   在 LEO 本地开发终端与 SCS 智能客服排障中枢中，探查物联网设备 (门锁、钥匙箱、网关) 的硬件运行
 *   流水日志、单片机 RTOS 底层事件、蜂窝模组通用 AT 指令交互、死机崩溃 (Crash/HardFault) 现场与协议报文。
 *
 * 核心特性：
 *   1. 智能自适应路由：
 *      • 传 --imei 时：默认优先直查测试数据库 (集中式测试日志表 device_test_run_log)；
 *      • 传 --file 或 --local 时：解析本地磁盘中的仿真产物或 J-Link 捕获日志 (rtt_full.log)；
 *      • 无参执行时：默认扫描本地最近一次仿真产物目录，零配置直出；
 *   2. 通用硬件事件解析增强：
 *      • 自动反解 3GPP 标准 AT+CSQ (信号质量)、AT+CEREG (注网状态)、AT+CGATT、PDP 断开等模组事件；
 *      • 自动捕获 ARM Cortex-M HardFault、Zephyr Fault、看门狗复位与死机现场 PC/LR 寄存器；
 *   3. 毫秒级时序美化表格：输出终端对齐的 Markdown/ASCII 概况卡片与高亮日志流水。
 *
 * 用法示例：
 *   node scripts/device_log_query.js --imei 861993083543235               # 查测试库 (默认)
 *   node scripts/device_log_query.js --imei 861993083543235 --level ERROR # 仅过滤错误与死机
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

// 匹配 ARM Cortex-M / Zephyr 死机与异常
const RE_CRASH_FAULT = /\*{3,}\s*(HARD|USAGE|BUS|MEM)\s*FAULT\s*\*{3,}|ASSERTION FAIL|Watchdog timeout|WDT Reset|Brownout reset|Guru Meditation|Faulting instruction address|r15\/pc/i;
const RE_REG_PC = /(?:instruction address \(r15\/pc\)|r15\/pc|Faulting instruction address.*?|pc)\s*[:=]\s*(0x[0-9a-fA-F]{6,8})/i;
const RE_REG_LR = /(?:r14\/lr|lr)\s*[:=]\s*(0x[0-9a-fA-F]{6,8})/i;
const RE_REG_SP = /(?:r13\/sp|sp)\s*[:=]\s*(0x[0-9a-fA-F]{6,8})/i;

// 匹配 3GPP 标准 AT 指令与响应
const RE_AT_CSQ = /\+CSQ:\s*(\d+),(\d+)/i;
const RE_AT_CREG = /\+(?:CEREG|CREG|CGREG):\s*(?:\d+,)?(\d+)/i;
const RE_AT_CGATT = /\+CGATT:\s*(\d+)/i;
const RE_AT_QIACT = /\+QIACT:\s*\d+,\d+,\d+,"([^"]+)"/i;
const RE_AT_PDP_DEACT = /\+QIURC:\s*"pdpdeact"/i;
const RE_AT_OPEN = /\+(?:QIOPEN|QMTOPEN):\s*(\d+),(\d+)/i;
const RE_AT_SEND = /^(?:\[[0-9:.,\s]+\]\s*)?AT\+([A-Z0-9]+)/i;

/** 解析蜂窝模组通用 AT 指令语义 */
export function parseAtCommand(line) {
  // 1. 信号强度 (CSQ)
  const csqMatch = line.match(RE_AT_CSQ);
  if (csqMatch) {
    const rssi = parseInt(csqMatch[1], 10);
    let desc = '';
    if (rssi === 99) {
      desc = '📶 [模组信号] 无蜂窝网络信号或天线异常脱落 (CSQ: 99)';
    } else if (rssi >= 20) {
      desc = `📶 [模组信号] 信号极佳 (CSQ: ${rssi}/31, 约 -${113 - rssi * 2}dBm)`;
    } else if (rssi >= 12) {
      desc = `📶 [模组信号] 信号正常 (CSQ: ${rssi}/31, 约 -${113 - rssi * 2}dBm)`;
    } else {
      desc = `⚠️ [模组信号] 信号较弱 (CSQ: ${rssi}/31, 极易掉线)`;
    }
    return { isAt: true, desc, module: 'MODEM_AT' };
  }

  // 2. 蜂窝网络注网状态 (CEREG / CREG)
  const cregMatch = line.match(RE_AT_CREG);
  if (cregMatch) {
    const stat = parseInt(cregMatch[1], 10);
    const statMap = {
      0: '⚠️ [注网状态] 未搜网 / 未附着网络 (Not registered)',
      1: '🟢 [注网状态] 已成功注册本地网络 (Registered, home network)',
      2: '🔄 [注网状态] 正在搜网注册中... (Searching)',
      3: '🚨 [注网状态] 注网被基站拒绝 (Registration denied, 请检查SIM卡或欠费停机)',
      4: '⚪ [注网状态] 未知状态 (Unknown)',
      5: '🟢 [注网状态] 已成功注册漫游网络 (Registered, roaming)'
    };
    return { isAt: true, desc: statMap[stat] || `[注网状态] 状态码: ${stat}`, module: 'MODEM_AT' };
  }

  // 3. GPRS 附着状态 (CGATT)
  const cgattMatch = line.match(RE_AT_CGATT);
  if (cgattMatch) {
    const att = parseInt(cgattMatch[1], 10);
    const desc = att === 1 ? '🟢 [数据业务] GPRS 附着成功 (Attached)' : '⚠️ [数据业务] GPRS 分离脱网 (Detached)';
    return { isAt: true, desc, module: 'MODEM_AT' };
  }

  // 4. IP 分配 (QIACT)
  const qiactMatch = line.match(RE_AT_QIACT);
  if (qiactMatch) {
    return { isAt: true, desc: `🌐 [模组IP] 蜂窝模组成功获取网络 IP: ${qiactMatch[1]}`, module: 'MODEM_AT' };
  }

  // 5. 基站踢下线 (PDP Deact)
  if (RE_AT_PDP_DEACT.test(line)) {
    return { isAt: true, desc: '🚨 [数据链路] 收到基站 pdpdeact，数据链路被动断开踢下线！', module: 'MODEM_AT' };
  }

  // 6. 网络连接结果 (QIOPEN / QMTOPEN)
  const openMatch = line.match(RE_AT_OPEN);
  if (openMatch) {
    const errCode = openMatch[2];
    const desc = errCode === '0'
      ? '🟢 [网络握手] TCP/MQTT 链路连接成功 (Connect Success)'
      : `🚨 [网络握手] TCP/MQTT 连接失败 (ErrCode: ${errCode})`;
    return { isAt: true, desc, module: 'MODEM_AT' };
  }

  // 7. 纯 AT 指令发送
  const sendMatch = line.match(RE_AT_SEND);
  if (sendMatch) {
    return { isAt: true, desc: `[AT指令发送] AT+${sendMatch[1]}`, module: 'MODEM_AT' };
  }

  return null;
}

/** 解析单片机死机 (Crash / HardFault) 现场 */
export function parseCrashFault(line) {
  if (!RE_CRASH_FAULT.test(line)) return null;

  let faultType = 'HardFault / Panic';
  const m = line.match(RE_CRASH_FAULT);
  if (m && m[1]) {
    faultType = `${m[1].toUpperCase()} FAULT`;
  } else if (/ASSERTION FAIL/i.test(line)) {
    faultType = 'Assertion Failure';
  } else if (/Watchdog|WDT/i.test(line)) {
    faultType = 'Watchdog Reset (看门狗复位)';
  }

  // 尝试抓取 PC/LR/SP 寄存器
  const pcM = line.match(RE_REG_PC);
  const lrM = line.match(RE_REG_LR);
  const spM = line.match(RE_REG_SP);

  let regDetails = '';
  if (pcM) regDetails += ` | PC=${pcM[1]}`;
  if (lrM) regDetails += ` | LR=${lrM[1]}`;
  if (spM) regDetails += ` | SP=${spM[1]}`;

  const desc = `💥 [单片机死机崩溃现场] 发现异常: ${faultType}${regDetails}`;
  return { isCrash: true, faultType, desc, module: 'CRASH_HANDLER' };
}

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

    // 通用 Crash / HardFault 异常解析
    const crashInfo = parseCrashFault(trimmed);
    if (crashInfo) {
      level = 'ERROR';
      module = crashInfo.module;
      content = `${crashInfo.desc} ➔ 原始日志: ${content}`;
    }

    // 通用 AT 指令解析
    const atInfo = parseAtCommand(trimmed);
    if (atInfo) {
      module = atInfo.module;
      content = `${atInfo.desc} ➔ 原始: ${content}`;
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
    const recordRaw = execFileSync('node', [testMysqlScript, 'platform', recordSql, '-d', 'iot_access', '--json'], { encoding: 'utf8', timeout: 8000 });
    let runRecord = null;
    try {
      const arr = JSON.parse(recordRaw);
      if (Array.isArray(arr) && arr.length > 0) runRecord = arr[0];
    } catch {}

    // 执行日志流水查询
    const logsRaw = execFileSync('node', [testMysqlScript, 'platform', logSql, '-d', 'iot_access', '--json'], { encoding: 'utf8', timeout: 10000 });
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
  console.log(`📟 设备硬件/嵌入式底层测试流水概览 (Device Hardware & Firmware Logs) [模式: ${modeDesc}]`);
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

  // 统计死机与异常
  const crashCount = logs.filter(l => (l.content || '').includes('单片机死机崩溃') || (l.module || '').includes('CRASH')).length;
  if (crashCount > 0) {
    console.log(`🚨 警告: 本次流水中检测到 ${crashCount} 次单片机崩溃/死机 (Crash/HardFault) 事件，请优先排查！`);
  }

  console.log(`\n📜 硬件/嵌入式流水明细 (显示最新 ${logs.length} 条):`);
  console.log(`| ID | 时间 | 级别 | 模块 | 协议指令 | 日志内容 |`);
  console.log(`|:---|:---|:---|:---|:---|:---|`);

  for (const item of logs) {
    const id = item.id || '-';
    const time = item.device_time || item.deviceTime || item.ctime || '-';
    const lvl = item.log_level || item.logLevel || 'INFO';
    const mod = item.module || '-';
    const cmd = item.cmd_type || item.cmdType || '-';

    let content = (item.content || '').replace(/\|/g, '\\|');
    if (content.includes('单片机死机崩溃') || mod.includes('CRASH')) {
      content = `💥 **${content}**`;
    } else if (content.toLowerCase().includes('auth pass')) {
      content = `🟢 **${content}**`;
    } else if (lvl === 'ERROR') {
      content = `🔴 ${content}`;
    } else if (content.includes('模组信号') || content.includes('注网状态')) {
      content = `📶 ${content}`;
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
      console.error(`❌ 仿真目录中未找到 rtt_full.log: ${rttFile}`);
      process.exit(1);
    }

    try {
      const logs = parseLocalLogFile(rttFile, options);
      renderOutput({ runRecord: null, logs }, options, `本地仿真产物: ${path.basename(localDir)}`);
      return;
    } catch (e) {
      console.error(`❌ 解析本地仿真日志失败: ${e.message}`);
      process.exit(1);
    }
  }

  // 3. 默认模式：通过 IMEI / runId 直查测试数据库
  if (!options.imei && !options.runId) {
    // 若未传 IMEI 也未传 runId，尝试查找本地最新仿真目录兜底
    const localDir = findLatestLocalRunDir();
    if (localDir) {
      const rttFile = path.join(localDir, 'rtt_full.log');
      if (fs.existsSync(rttFile)) {
        try {
          const logs = parseLocalLogFile(rttFile, options);
          renderOutput({ runRecord: null, logs }, options, `未指定 IMEI，自动匹配本地最新仿真`);
          return;
        } catch {}
      }
    }

    console.error(`❌ 错误: 请指定设备 IMEI 或 RunId (例如: node scripts/device_log_query.js --imei 861993083543235)`);
    console.error(`   或指定 --local 查本地最近一次仿真，--file <路径> 查指定日志文件。`);
    process.exit(1);
  }

  try {
    const data = queryTestDatabase(options);
    renderOutput(data, options, `测试环境数据库 (iot_access.device_test_run_log)`);
  } catch (err) {
    console.error(`❌ 数据库查询失败: ${err.message}`);
    // 优雅兜底：尝试在本地查
    const localDir = findLatestLocalRunDir(options.imei);
    if (localDir) {
      const rttFile = path.join(localDir, 'rtt_full.log');
      if (fs.existsSync(rttFile)) {
        console.log(`💡 自动回退尝试读取本地仿真产物...`);
        const logs = parseLocalLogFile(rttFile, options);
        renderOutput({ runRecord: null, logs }, options, `离线本地仿真产物回退`);
        return;
      }
    }
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('device_log_query.js')) {
  main();
}
