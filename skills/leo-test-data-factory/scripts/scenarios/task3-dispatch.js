/**
 * Task 3 · 社区服务单 → 派单通知
 *
 * 验证 OtherOrderService.doSendDispatchNotice 的三路分流：
 *   REPAIR + hui_ju          → 强制短信（与开关无关）
 *   其他工单 + 开关开 + UCID → 服务者 App Push（BJFWZ_LIUCHENGTONGZHI，scheme=""）
 *   开关关                   → 短信 order_dispatch_notice
 *
 * 文档：references/scenarios/task3-dispatch.md
 */
import { capabilities as C } from '../capabilities/index.js';
import { createLogSource } from '../common/logs.js';

const SMS_TEMPLATE = 'order_dispatch_notice';
const SWITCH = 'order.dispatch.servicer.app.push.enable';
const TOPIC = 'beijia-service-order-change';

export default {
  name: 'sms-task3-dispatch',
  description: '派单通知的服务者 Push / 短信分流',
  switchKey: SWITCH,

  async precheck(ctx, _carry, opts = {}) {
    const checks = [];
    const missing = [];
    const orderType = opts.orderType || 'INS';   // INS | REPAIR

    // 1. 找合同 + 权益 + 商品（安装用 lock_install，维修用 trusteeship_lock_fix）
    const templateCode = orderType === 'REPAIR' ? 'trusteeship_lock_fix' : 'lock_install';
    const found = await C.discover.findContractWithUsableEquity(
      { templateCode, cityCode: opts.cityCode, workOrderType: orderType }, ctx
    );
    checks.push({
      ok: found.ok,
      name: '合同 + 权益 + 商品',
      detail: found.ok
        ? `${found.handle.contractCode} / ${found.handle.commodityName}`
        : `[${found.reason}] ${found.message}`
    });
    if (!found.ok) {
      missing.push('equity_combination');
      return { ok: false, checks, missing, canProceed: false, message: found.message };
    }
    const h = found.handle;

    // 2. 房源（建单需要）
    const house = await C.house.resolve({ houseId: h.houseId }, ctx);
    checks.push({ ok: true, name: '房源', detail: house.ok ? h.houseId : '缺失，seed 阶段创建' });

    return {
      ok: missing.length === 0,
      checks,
      missing,
      canProceed: missing.length === 0,
      context: { ...h, orderType, templateCode }
    };
  },

  async seed(ctx, pre, opts = {}) {
    const h = pre.context;
    if (ctx.mode !== 'execute') {
      return {
        ok: true, source: 'reused', handle: h,
        detail: '只读模式：将创建家服订单（需 --execute）'
      };
    }
    // 先补房源，再建家服订单
    await C.house.ensure({ houseId: h.houseId, cityCode: h.cityCode, houseType: 2 }, ctx);
    const order = await C.order.ensure({
      houseResourceId: Number(h.houseId),
      contractId: h.contractId,
      templateInstId: h.templateInstId,
      shelfCodeList: [h.shelfCode],
      serviceTime: nextServiceTime(),
      contactUser: 'AI验证',
      contactUserMobile: process.env.SEEDER_CONTACT_PHONE || '00000000000',
      userRemark: 'AI验证-派单通知',
      ucid: opts.ucid || process.env.SEEDER_OPERATOR_UCID
    }, ctx);
    return order;
  },

  async trigger(ctx, pre, opts = {}) {
    const h = pre.context;
    if (ctx.mode !== 'execute') {
      return {
        ok: false, reason: 'readonly',
        message: `将通过 order.ensure 创建 ${h.orderType} 单，家服自动发出 ${TOPIC} 消息`
      };
    }
    // 家服建单成功后会自动发消息，无需手工发；这里等待消费
    await new Promise(r => setTimeout(r, opts.waitMs || 20000));
    return { ok: true, detail: '等待家服消息被消费', handle: h };
  },

  async assert(ctx, pre, opts = {}) {
    const logs = createLogSource({ file: opts.logFile, testApp: opts.testApp }, ctx);
    const h = pre.context;
    const orderCode = h.orderCode || h.order?.orderCode;
    const pushEnabled = opts.pushEnabled !== false;
    const isSelfRepair = h.orderType === 'REPAIR' && h.manufacturerCode !== undefined;
    const evidence = [];

    // 前置：必须进 HandleAddOrder 且是本订单（分两次字面匹配，避免正则语义）
    evidence.push(await logs.expect('doEventProcess HandleAddOrder'));
    if (orderCode) evidence.push(await logs.expect(orderCode));

    if (isSelfRepair) {
      evidence.push(await logs.expect(SMS_TEMPLATE));
      evidence.push(await logs.expect('服务者 App Push', { shouldExist: false }));
    } else if (pushEnabled) {
      evidence.push(await logs.expect('服务者 App Push 发送成功'));
      evidence.push(await logs.expect('BJFWZ_LIUCHENGTONGZHI'));
      // 负向断言限定本订单，避免历史日志误判
      // 负向断言：本订单不应触发派单短信（限定在 Push 成功的同一个 trace 内更准确，
      // 这里退化为「本次执行时间窗口内不应有 order_dispatch_notice」）
      evidence.push(await logs.expect(SMS_TEMPLATE, { shouldExist: false, since: 3 * 60 * 1000 }));
    } else {
      evidence.push(await logs.expect(SMS_TEMPLATE));
      evidence.push(await logs.expect('服务者 App Push', { shouldExist: false }));
    }

    return { ok: evidence.every(e => e.ok), evidence };
  },

  async cleanup(ctx) {
    if (ctx.mode !== 'execute') return { ok: true, planned: [], done: [] };
    const planned = ctx.ledger.reverseOrder();
    const done = [];
    for (const entry of planned) {
      if (entry.kind === 'api' && entry.capability === 'order') {
        const r = await C.order.reverse({ orderCode: entry.key }, ctx);
        done.push({ key: entry.key, ok: r.ok });
      }
    }
    return { ok: true, planned, done };
  }
};

function nextServiceTime() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd} 09:00-12:00`;
}
