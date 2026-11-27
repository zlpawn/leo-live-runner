#!/usr/bin/env node

/**
 * 📟 Leo Live Inspector - J-Link RTT 硬件测试流水日志中继与实时上报引擎 (Node.js 版)
 * ---------------------------------------------------------------------------------
 * 适用场景：
 *   在本地开发/硬件测试环境中，当单片机开发板通过 J-Link 调试器连接时，本工具监听 J-Link
 *   在本地开放的 RTT Telnet 服务 (默认 127.0.0.1:19021)，流式捕获固件业务日志、通信报文、
 *   模组 AT 指令交互与单片机死机 (Crash/HardFault) 现场，并按批次实时上报至后端测试环境数据库。
 *
 * 核心特性：
 *   1. 纯 Node.js 原生实现：零第三方 npm 依赖，基于 node:net 与原生 fetch 实现流式抓取与 HTTP 上报；
 *   2. 智能重连与引导：自动轮询等待 J-Link 连接建立，断连自动无缝重连，对测试同学极度友好；
 *   3. 批量缓冲平滑上报：支持按行数 (batchSize) 与时间间隔 (flushInterval) 缓冲聚合 POST；
 *   4. 通用 AT 指令解析：自动反解 3GPP 标准 AT+CSQ (信号质量)、AT+CEREG (注网状态)、AT+CGATT 等；
 *   5. HardFault/死机现场捕获：自动识别 ARM Cortex-M 异常、Zephyr Fault、看门狗复位并提取 PC/LR；
 *   6. 优雅关机闭环：Ctrl+C 中断时自动推送 isFinal=true 状态封板主表运行会话。
 *
 * 用法示例：
 *   node scripts/jlink_forwarder.js --imei 861993083543235
 *   node scripts/jlink_forwarder.js --imei 861993083543235 --url http://127.0.0.1:8080/backdoor/device/log/batch
 */

import net from 'node:net';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import process from 'node:process';
import { parseAtCommand, parseCrashFault } from './device_log_query.js';

const DEFAULT_TARGET_URL = 'http://test.huiju.iot.cloud.ke.com:8080/backdoor/device/log/batch';
const DEFAULT_TELNET_HOST = '127.0.0.1';
const DEFAULT_TELNET_PORT = 19021;

// 匹配 Zephyr RTT 格式: [00:00:02.130,000] <inf> net_interface: content 或 <inf> net_interface: content
const RE_ZEPHYR_LOG = /^(?:\[([^\]]+)\]\s*)?<([a-z]+)>\s*([^:\s]+):\s*(.*)$/i;
// 匹配十六进制协议报文特征: BE00... 或 be00...
const RE_HEX_FRAME = /\b(be[0-9a-fA-F]{10,})\b/i;
// 匹配指令码
const RE_CMD_TYPE = /\b(0x[0-9a-fA-F]{4})\b/i;

/** 单行日志结构化解析 */
export function parseLogLine(rawLine, defaultImei, runId) {
  const cleanLine = rawLine.trim();
  if (!cleanLine) return null;

  let level = 'INFO';
  let module = 'rtt';
  let content = cleanLine;
  let rawHex = '';
  let cmdType = '';
  let deviceTime = '';

  // 1. 尝试匹配 Zephyr RTOS 标准日志
  const zephyrMatch = cleanLine.match(RE_ZEPHYR_LOG);
  if (zephyrMatch) {
    deviceTime = zephyrMatch[1] || '';
    const lvlTag = (zephyrMatch[2] || '').toLowerCase();
    if (lvlTag === 'err' || lvlTag === 'error') level = 'ERROR';
    else if (lvlTag === 'wrn' || lvlTag === 'warn') level = 'WARN';
    else if (lvlTag === 'dbg' || lvlTag === 'debug') level = 'DEBUG';
    else level = 'INFO';

    module = zephyrMatch[3] || 'zephyr';
    content = zephyrMatch[4] || '';
  } else {
    if (/error|fault|assert|panic/i.test(cleanLine)) level = 'ERROR';
    else if (/warn/i.test(cleanLine)) level = 'WARN';
  }

  // 2. 通用 Crash / HardFault 异常解析
  const crashInfo = parseCrashFault(cleanLine);
  if (crashInfo) {
    level = 'ERROR';
    module = crashInfo.module;
    content = `${crashInfo.desc} ➔ 原始日志: ${content}`;
  }

  // 3. 通用 AT 指令解析
  const atInfo = parseAtCommand(cleanLine);
  if (atInfo) {
    module = atInfo.module;
    content = `${atInfo.desc} ➔ 原始: ${content}`;
  }

  // 4. 鉴权关键事件检测
  let authEvent = 0; // 0-无, 1-通过, 2-失败
  const lower = cleanLine.toLowerCase();
  if (lower.includes('auth pass') || lower.includes('鉴权成功')) {
    authEvent = 1;
    content = `🟢 [鉴权成功] ${content}`;
  } else if (lower.includes('auth fail') || lower.includes('auth err') || lower.includes('鉴权失败')) {
    authEvent = 2;
    level = 'ERROR';
    content = `🔴 [鉴权失败] ${content}`;
  }

  // 5. 提取 Hex 报文
  const hexMatch = cleanLine.match(RE_HEX_FRAME);
  if (hexMatch) {
    rawHex = hexMatch[1];
  }

  // 6. 提取协议指令码
  const cmdMatch = cleanLine.match(RE_CMD_TYPE);
  if (cmdMatch) {
    cmdType = cmdMatch[1].toLowerCase();
  }

  return {
    item: {
      source: 'JLINK_RTT',
      logLevel: level,
      module,
      content,
      rawHex,
      cmdType,
      deviceTime
    },
    authEvent
  };
}

export class JLinkForwarder {
  constructor(options = {}) {
    this.imei = (options.imei || '').trim();
    if (!this.imei) {
      throw new Error('必须指定设备 IMEI (通过 --imei 参数)');
    }
    this.targetUrl = options.url || DEFAULT_TARGET_URL;
    this.host = options.host || DEFAULT_TELNET_HOST;
    this.port = parseInt(options.port || DEFAULT_TELNET_PORT, 10);
    this.portExplicit = !!options.portExplicit;
    this.candidatePorts = [19021, 19022, 19023, 19024, 19025];
    this.candidateIdx = 0;
    this.prodType = options.prodType || 'LOCK';
    this.batchSize = parseInt(options.batchSize || 50, 10);
    this.flushInterval = parseInt(options.interval || 1000, 10);

    const nowStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const randSuffix = crypto.randomUUID().slice(0, 6);
    this.runId = `run_${this.imei}_${nowStr}_${randSuffix}`;

    this.buffer = [];
    this.lastFlushTime = Date.now();
    this.running = true;
    this.totalSent = 0;
    this.authStatus = 0; // 0-未知, 1-通过, 2-失败
    this.startTime = Date.now();

    this.socket = null;
    this.flushTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    console.log(`\n================================================================================`);
    console.log(`🚀 J-Link RTT 硬件测试流水日志中继引擎启动 (Node.js)`);
    console.log(`================================================================================`);
    console.log(`• 设备 IMEI     : ${this.imei}`);
    console.log(`• 批次会话 ID   : ${this.runId}`);
    const portMode = this.portExplicit ? `指定端口 ${this.port}` : `自动探测 (候选: ${this.candidatePorts.join(', ')})`;
    console.log(`• J-Link 目标   : ${this.host} [${portMode}]`);
    console.log(`• 上报后端接口  : ${this.targetUrl}`);
    console.log(`• 缓冲策略      : 每 ${this.batchSize} 条或每 ${this.flushInterval}ms 批量上报一次`);
    console.log(`• 快捷中断      : 按 Ctrl+C 停止监听并自动封板数据`);
    console.log(`================================================================================\n`);

    // 定时刷盘计时器
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0 && Date.now() - this.lastFlushTime >= this.flushInterval) {
        this.flushBuffer(false);
      }
    }, 500);

    // 建立连接
    this.connect();
  }

  connect() {
    if (!this.running) return;

    const targetPort = this.portExplicit ? this.port : this.candidatePorts[this.candidateIdx];
    console.log(`⏳ 正在尝试连接 J-Link 本地 RTT 端口 (${this.host}:${targetPort})...`);
    this.socket = net.connect({ host: this.host, port: targetPort }, () => {
      this.port = targetPort;
      if (!this.portExplicit && targetPort !== DEFAULT_TELNET_PORT) {
        console.log(`💡 自动探测到活动中的 J-Link 端口: ${targetPort}，已成功接入！`);
      }
      console.log(`🟢 成功连接到 J-Link RTT Telnet 服务！正在实时监听硬件日志流水...\n`);
    });

    const rl = readline.createInterface({
      input: this.socket,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (!this.running) return;
      const res = parseLogLine(line, this.imei, this.runId);
      if (!res) return;

      if (res.authEvent !== 0) {
        this.authStatus = res.authEvent;
      }

      this.buffer.push(res.item);

      // 控制台简要实时打印 (单片机报错或特殊指令高亮)
      const prefix = res.item.logLevel === 'ERROR' ? '🔴' : (res.item.logLevel === 'WARN' ? '🟡' : '▫️');
      console.log(`${prefix} [${res.item.module}] ${res.item.content}`);

      if (this.buffer.length >= this.batchSize) {
        this.flushBuffer(false);
      }
    });

    this.socket.on('error', (err) => {
      if (!this.running) return;
      if (err.code === 'ECONNREFUSED') {
        if (!this.portExplicit) {
          // 切换到下一个候选端口尝试
          this.candidateIdx = (this.candidateIdx + 1) % this.candidatePorts.length;
          if (this.candidateIdx === 0) {
            console.log(`⚠️  未检测到 J-Link RTT 端口 (已轮询 ${this.candidatePorts.join(', ')})，请确认已连接硬件并打开 J-Link RTT Viewer...`);
          }
        } else {
          console.log(`⚠️  未检测到指定的 J-Link RTT 服务 (${this.host}:${this.port})，请确认端口是否开启...`);
        }
      } else {
        console.log(`⚠️  J-Link Socket 异常: ${err.message}`);
      }
    });

    this.socket.on('close', () => {
      if (!this.running) return;
      const delay = (!this.portExplicit && this.candidateIdx !== 0) ? 600 : 3000;
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, delay);
    });
  }

  async flushBuffer(isFinal = false) {
    if (this.buffer.length === 0 && !isFinal) return;

    const itemsToSend = [...this.buffer];
    this.buffer = [];
    this.lastFlushTime = Date.now();

    const payload = {
      runId: this.runId,
      imei: this.imei,
      prodType: this.prodType,
      firmwareVersion: '',
      targetHost: this.host,
      authStatus: this.authStatus,
      isFinal,
      logs: itemsToSend
    };

    try {
      const resp = await fetch(this.targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      });

      if (!resp.ok) {
        console.error(`❌ 上报失败 (HTTP ${resp.status})`);
        return;
      }

      const resJson = await resp.json();
      this.totalSent += itemsToSend.length;
      const nowStr = new Date().toLocaleTimeString();
      console.log(`[${nowStr}] 📦 成功上报 ${itemsToSend.length} 条流水至 access 服务 (累计: ${this.totalSent} 条, isFinal: ${isFinal})`);
    } catch (err) {
      console.error(`❌ HTTP 上报请求失败: ${err.message}`);
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    console.log(`\n🛑 正在停止抓取并封板测试会话...`);

    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    if (this.socket) {
      this.socket.destroy();
    }

    // 最终封盘上报 (带上 isFinal: true)
    await this.flushBuffer(true);
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`🎉 运行会话 [${this.runId}] 已封板！总耗时: ${duration}s，共上报: ${this.totalSent} 条日志。`);
    process.exit(0);
  }
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    imei: '',
    url: process.env.ACCESS_BACKDOOR_URL || DEFAULT_TARGET_URL,
    host: process.env.JLINK_RTT_HOST || DEFAULT_TELNET_HOST,
    port: process.env.JLINK_RTT_PORT ? parseInt(process.env.JLINK_RTT_PORT, 10) : DEFAULT_TELNET_PORT,
    portExplicit: !!process.env.JLINK_RTT_PORT,
    batchSize: 50,
    interval: 1000,
    prodType: 'LOCK'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--imei' && args[i + 1]) options.imei = args[++i];
    else if (arg === '--url' && args[i + 1]) options.url = args[++i];
    else if (arg === '--host' && args[i + 1]) options.host = args[++i];
    else if (arg === '--port' && args[i + 1]) {
      options.port = parseInt(args[++i], 10);
      options.portExplicit = true;
    }
    else if (arg === '--batch-size' && args[i + 1]) options.batchSize = parseInt(args[++i], 10);
    else if (arg === '--interval' && args[i + 1]) options.interval = parseInt(args[++i], 10);
    else if (arg === '--prod-type' && args[i + 1]) options.prodType = args[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log(`
用法:
  node scripts/jlink_forwarder.js --imei <设备IMEI> [选项]

选项:
  --imei <IMEI>        [必填] 目标设备 IMEI 号
  --port <PORT>        J-Link 本地 RTT 监听端口 (默认: 19021; 未指定时会自动在 19021-19025 之间智能自适应探测)
  --host <HOST>        J-Link 本地 RTT 监听主机 (默认: 127.0.0.1)
  --url <URL>          后端测试接入服务批量上报接口 (默认: ${DEFAULT_TARGET_URL})
  --batch-size <NUM>   批量上报阈值 (默认: 50)
  --interval <MS>      批量上报最大时间间隔毫秒 (默认: 1000)
  --prod-type <TYPE>   设备品类 (默认: LOCK, 可选 KEYBOX, GATEWAY)
  -h, --help           显示帮助信息
`);
      process.exit(0);
    }
  }

  return options;
}

if (process.argv[1] && process.argv[1].endsWith('jlink_forwarder.js')) {
  try {
    const opts = parseCliArgs();
    if (!opts.imei) {
      console.error('❌ 错误: 必须指定设备 IMEI! 示例: node scripts/jlink_forwarder.js --imei 861993083543235');
      process.exit(1);
    }
    const forwarder = new JLinkForwarder(opts);

    process.on('SIGINT', () => forwarder.stop());
    process.on('SIGTERM', () => forwarder.stop());

    forwarder.start();
  } catch (err) {
    console.error(`❌ 启动失败: ${err.message}`);
    process.exit(1);
  }
}
