import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAtCommand, parseCrashFault } from '../scripts/device_log_query.js';
import { parseLogLine, JLinkForwarder } from '../scripts/jlink_forwarder.js';

test('parseAtCommand - 3GPP AT signal and registration parsing', () => {
  // CSQ
  const csqGood = parseAtCommand('+CSQ: 26,99');
  assert.equal(csqGood.isAt, true);
  assert.equal(csqGood.module, 'MODEM_AT');
  assert.match(csqGood.desc, /信号极佳/);

  const csqBad = parseAtCommand('+CSQ: 99,99');
  assert.equal(csqBad.isAt, true);
  assert.match(csqBad.desc, /无蜂窝网络信号/);

  // CEREG / CREG
  const regOk = parseAtCommand('+CEREG: 0,1');
  assert.equal(regOk.isAt, true);
  assert.match(regOk.desc, /已成功注册本地网络/);

  const regDenied = parseAtCommand('+CEREG: 0,3');
  assert.equal(regDenied.isAt, true);
  assert.match(regDenied.desc, /注网被基站拒绝/);

  // CGATT
  const gprs = parseAtCommand('+CGATT: 1');
  assert.equal(gprs.isAt, true);
  assert.match(gprs.desc, /GPRS 附着成功/);

  // IP & Disconnection
  const ip = parseAtCommand('+QIACT: 1,1,1,"10.128.45.67"');
  assert.equal(ip.isAt, true);
  assert.match(ip.desc, /10\.128\.45\.67/);

  const deact = parseAtCommand('+QIURC: "pdpdeact"');
  assert.equal(deact.isAt, true);
  assert.match(deact.desc, /被动断开踢下线/);

  // Non-AT line
  assert.equal(parseAtCommand('ordinary log content'), null);
});

test('parseCrashFault - ARM Cortex-M and Zephyr fault dump parsing', () => {
  // HardFault with PC
  const hf = parseCrashFault('***** HARD FAULT ***** Instruction address (r15/pc): 0x08004120');
  assert.equal(hf.isCrash, true);
  assert.equal(hf.faultType, 'HARD FAULT');
  assert.equal(hf.module, 'CRASH_HANDLER');
  assert.match(hf.desc, /PC=0x08004120/);

  // UsageFault
  const uf = parseCrashFault('***** USAGE FAULT ***** Faulting instruction address: 0x08001234');
  assert.equal(uf.isCrash, true);
  assert.match(uf.desc, /USAGE FAULT/);

  // Assertion failure
  const af = parseCrashFault('ASSERTION FAIL [false] at ../src/lock.c:120');
  assert.equal(af.isCrash, true);
  assert.match(af.desc, /Assertion Failure/);

  // Watchdog
  const wdt = parseCrashFault('Watchdog timeout reset occurred');
  assert.equal(wdt.isCrash, true);
  assert.match(wdt.desc, /Watchdog/);

  // Normal line
  assert.equal(parseCrashFault('system started successfully'), null);
});

test('parseLogLine - Zephyr log line extraction and event recognition', () => {
  const line1 = '[00:00:01.234,000] <inf> lock_app: 0x8001 Auth Pass';
  const res1 = parseLogLine(line1, '861993083543235', 'run_test');
  assert.equal(res1.item.logLevel, 'INFO');
  assert.equal(res1.item.module, 'lock_app');
  assert.equal(res1.item.cmdType, '0x8001');
  assert.equal(res1.authEvent, 1);
  assert.match(res1.item.content, /鉴权成功/);

  const line2 = '[00:00:02.000,000] <err> modem_bg95: +CSQ: 99,99';
  const res2 = parseLogLine(line2, '861993083543235', 'run_test');
  assert.equal(res2.item.logLevel, 'ERROR');
  assert.equal(res2.item.module, 'MODEM_AT');
  assert.match(res2.item.content, /无蜂窝网络信号/);
});

test('JLinkForwarder - port candidate configuration', () => {
  const f = new JLinkForwarder({ imei: '861993083543235' });
  assert.equal(f.portExplicit, false);
  assert.deepEqual(f.candidatePorts, [19021, 19022, 19023, 19024, 19025]);

  const fExplicit = new JLinkForwarder({ imei: '861993083543235', port: 19022, portExplicit: true });
  assert.equal(fExplicit.portExplicit, true);
  assert.equal(fExplicit.port, 19022);
});
