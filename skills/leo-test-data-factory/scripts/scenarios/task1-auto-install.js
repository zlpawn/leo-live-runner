/**
 * Task 1 · 全自动下单 → 租务管家通知
 *
 * 验证 LockOrderLogicImpl.sendAutoOrderDispatchNotice 的开关分流：
 *   开关开 + 有 UCID  → Link Push（LINK_BEIKEZULIN，scheme=""）
 *   开关关 / 无 UCID  → 短信 zuwu_auto_order_dispatch_notice
 *
 * 文档：references/scenarios/task1-auto-install.md
 */
import { capabilities as C } from '../capabilities/index.js';
import { createLogSource } from '../common/logs.js';

const TEMPLATE = 'lock_install';
const SMS_TEMPLATE = 'zuwu_auto_order_dispatch_notice';
const SWITCH = 'zuwu.auto.order.dispatch.link.push.enable';

export default {
  name: 'sms-task1-auto-install',
  description: '全自动下单后的租务管家通知分流',
  switchKey: SWITCH,

  async precheck(ctx, _carry, opts = {}) {
    const checks = [];
    const missing = [];

    // 1. 自动发现可用组合
    const found = await C.discover.findContractWithUsableEquity(
      { templateCode: TEMPLATE, cityCode: opts.cityCode, workOrderType: 'INS' }, ctx
    );
    checks.push({
      ok: found.ok,
      name: '合同 + 权益 + 商品',
      detail: found.ok
        ? `${found.handle.contractCode} / 商品 ${found.handle.commodityName}`
        : `[${found.reason}] ${found.message}`
    });
    if (!found.ok) {
      missing.push('equity_combination');
      return { ok: false, checks, missing, canProceed: false, message: found.message };
    }
    const h = found.handle;

    // 2. 房源
    const house = await C.house.resolve({ houseId: h.houseId }, ctx);
    checks.push({
      ok: house.ok,
      name: '房源',
      detail: house.ok ? `${h.houseId} (${house.handle.meta.cityName})` : '缺失，seed 阶段创建'
    });
    if (!house.ok) missing.push('house');

    // 3. 房源未装锁
    const noLock = await C.lock.ensureAbsent({ houseId: h.houseId }, ctx);
    checks.push({
      ok: noLock.ok,
      name: '房源未装锁',
      detail: noLock.ok ? '无锁' : `已装锁 ${noLock.handle?.id}`
    });
    if (!noLock.ok) missing.push('lock_absent');

    return {
      ok: missing.length === 0,
      checks,
      missing,
      canProceed: missing.length === 0,
      handle: h,
      context: { ...h }
    };
  },

  async seed(ctx, pre) {
    const h = pre.context;
    // 只补房源，其余复用
    const house = await C.house.ensure({
      houseId: h.houseId, cityCode: h.cityCode, houseType: 2
    }, ctx);
    return house;
  },

  async trigger(ctx, pre) {
    if (ctx.mode !== 'execute') {
      return {
        ok: false, reason: 'readonly',
        message: `将执行 POST /zuwu/order/createAutoInstallOrder，body={contractCode:"${pre.context.contractCode}", needDelay:false}`
      };
    }
    const h = pre.context;
    const svc = ctx.systems.getHttpService('beijia-trade-access');
    // 实际入口是 iot 自身的接口，这里走本地或测试环境网关
    const baseUrl = process.env.SEEDER_IOT_BASE_URL || 'http://127.0.0.1:18081';
    const res = await fetch(`${baseUrl}/zuwu/order/createAutoInstallOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractCode: h.contractCode, needDelay: false })
    });
    const json = await res.json().catch(() => ({}));
    const ok = json?.success === true;
    return {
      ok,
      detail: ok ? '接口返回成功' : `接口返回失败: ${json?.msg || ''}`,
      handle: { ...h }
    };
  },

  async assert(ctx, pre, opts = {}) {
    const logs = createLogSource({ file: opts.logFile, testApp: opts.testApp }, ctx);
    const pushEnabled = opts.pushEnabled !== false;
    const evidence = [];

    if (pushEnabled) {
      evidence.push(await logs.expect('AutoOrderDispatchNotify: Link Push 发送成功'));
      evidence.push(await logs.expect('LINK_BEIKEZULIN'));
      evidence.push(await logs.expect(SMS_TEMPLATE, { shouldExist: false }));
    } else {
      evidence.push(await logs.expect(SMS_TEMPLATE));
      evidence.push(await logs.expect('LINK_BEIKEZULIN', { shouldExist: false }));
    }

    return { ok: evidence.every(e => e.ok), evidence };
  },

  async cleanup(ctx) {
    if (ctx.mode !== 'execute') {
      return { ok: true, planned: [], done: [] };
    }
    const planned = ctx.ledger.reverseOrder();
    return { ok: true, planned };
  }
};
