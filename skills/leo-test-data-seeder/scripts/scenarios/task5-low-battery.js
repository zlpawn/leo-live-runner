/**
 * Task 5 · 门锁低电量 → 管家短信（城市白名单）
 *
 * 验证 LockLogicImpl.isZuwuManagerLowBatteryCityOpen：
 *   城市在白名单   → 正常提醒
 *   城市不在白名单 → 静默拦截
 *   白名单为空 []  → 拦截所有城市
 *
 * 文档：references/scenarios/task5-low-battery.md
 */
import { capabilities as C } from '../capabilities/index.js';
import { createLogSource } from '../common/logs.js';

const TOPIC = 'beijia-iot-metadata-change';
const WHITELIST_KEY = 'lowBatteryZuwuManagerCityList';

export default {
  name: 'sms-task5-low-battery',
  description: '门锁低电量管家短信的城市白名单过滤',
  switchKey: WHITELIST_KEY,

  async precheck(ctx, _carry, opts = {}) {
    const checks = [];
    const missing = [];

    // 1. 找一把符合条件的门锁（无租客、未移交、轻托管）
    const lock = await C.discover.findLock({
      cityCode: opts.cityCode,
      manufacturerCode: 'hui_ju',
      requireNoTenant: true,
      requireNotToLandlord: true
    }, ctx);
    checks.push({
      ok: lock.ok,
      name: '门锁房源',
      detail: lock.ok
        ? `house ${lock.handle.houseId} / lock ${lock.handle.lockId} / 电量 ${lock.handle.battery}%`
        : `[${lock.reason}] ${lock.message}`
    });
    if (!lock.ok) {
      missing.push('lock');
      return { ok: false, checks, missing, canProceed: false, message: lock.message };
    }

    // 2. 房源 house_type 必须是 2
    checks.push({
      ok: lock.handle.houseType === 2,
      name: 'house_type=2（轻托管整租）',
      detail: `houseType=${lock.handle.houseType}`
    });

    // 3. 无租客授权（findLock 已保证）
    checks.push({ ok: true, name: '无租客授权', detail: 'findLock 已过滤' });

    return {
      ok: missing.length === 0,
      checks,
      missing,
      canProceed: missing.length === 0,
      context: lock.handle
    };
  },

  async seed(ctx, pre) {
    // 本场景不需要造数
    return { ok: true, source: 'reused', handle: pre.context };
  },

  async trigger(ctx, pre, opts = {}) {
    const h = pre.context;
    const battery = opts.battery || 5;
    if (ctx.mode !== 'execute') {
      return {
        ok: false, reason: 'readonly',
        message: `将向 ${TOPIC} 发送低电量消息: deviceId=${h.lockId}, battery=${battery}`
      };
    }
    const { Kafka } = await import('kafkajs');
    const kafka = new Kafka({ brokers: ctx.systems.getKafka('test').brokers, clientId: 'seeder-trigger' });
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: TOPIC,
      messages: [{
        key: h.lockId,
        value: JSON.stringify({
          data: { battery },
          deviceId: h.lockId,
          deviceType: 1,
          directConnection: false,
          manufacturerCode: h.manufacturerCode,
          source: 3,
          updateTime: new Date().toISOString().slice(0, 19)
        })
      }]
    });
    await producer.disconnect();
    return { ok: true, detail: `已发送 battery=${battery}`, handle: h };
  },

  async assert(ctx, pre, opts = {}) {
    const logs = createLogSource({ file: opts.logFile, testApp: opts.testApp }, ctx);
    const cityOpen = opts.cityOpen === true;
    const evidence = [];

    if (cityOpen) {
      evidence.push(await logs.expect('低电量给资管发送短信'));
      evidence.push(await logs.expect('静默拦截', { shouldExist: false }));
    } else {
      evidence.push(await logs.expect('[ZuwuLowBattery]'));
      evidence.push(await logs.expect('低电量给资管发送短信', { shouldExist: false }));
    }

    return { ok: evidence.every(e => e.ok), evidence };
  },

  async cleanup(ctx) {
    if (ctx.mode !== 'execute') return { ok: true, planned: [], done: [] };
    return { ok: true, planned: ctx.ledger.reverseOrder() };
  }
};
