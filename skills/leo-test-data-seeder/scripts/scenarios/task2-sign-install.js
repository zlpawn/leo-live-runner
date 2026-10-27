/**
 * Task 2 · 出房签约 → 在途安装单提醒
 *
 * 验证 TrusteeshipContractService.sendInstallOrderNoticeToManager：
 *   开关开 + 有 UCID → 按 UCID 逐个 Link Push（scheme=""）
 *   开关关           → 短信 install_order_notice_to_manager
 *
 * 文档：references/scenarios/task2-sign-install.md
 */
import { capabilities as C } from '../capabilities/index.js';
import { createLogSource } from '../common/logs.js';

const SMS_TEMPLATE = 'install_order_notice_to_manager';
const SWITCH = 'install.order.notice.manager.link.push.enable';
const TOPIC = 'contract-change-event-test';
const BROKER = 'kafka01-test.lianjia.com:9092';

export default {
  name: 'sms-task2-sign-install',
  description: '出房签约时的在途安装单提醒分流',
  switchKey: SWITCH,

  async precheck(ctx, _carry, opts = {}) {
    const checks = [];
    const missing = [];

    // 1. 优先找「有处理人 + 已有在途安装单」的完整组合；找不到再退回只要处理人
    let combo = await C.discover.findSignInstallCombination(
      { cityCode: opts.cityCode, requireInFlightInstall: true }, ctx
    );
    // 只有真正带 installOrderId 的才算 ready
    let installReady = combo.ok && combo.handle?.installOrderId != null;

    if (!installReady) {
      combo = await C.discover.findSignInstallCombination({ cityCode: opts.cityCode }, ctx);
      installReady = false;
    }

    checks.push({
      ok: combo.ok,
      name: '收房合同 + 任务处理人',
      detail: combo.ok
        ? `${combo.handle.inContractCode}，处理人 ${combo.handle.dealUsers.map(u => u.role).join('/')}`
        : `[${combo.reason}] ${combo.message}`
    });
    if (!combo.ok) {
      missing.push('managerTask');
      return { ok: false, checks, missing, canProceed: false, message: combo.message };
    }
    const c = combo.handle;

    // 2. 该房源有在途安装单（上面若已找到完整组合则必然有）
    const inst = installReady && c.installOrderId
      ? { ok: true, handle: { id: c.installOrderId, key: c.thirdOrderCode } }
      : await C.installOrder.resolve({ houseId: c.houseId, inFlight: true }, ctx);
    checks.push({
      ok: inst.ok,
      name: '在途安装单（status=4 且 order_status∈1,2,3）',
      detail: inst.ok ? `thirdOrderCode=${inst.handle.key}` : '缺失，seed 阶段创建'
    });
    if (!inst.ok) missing.push('installOrder');

    // 3. 该房源有已签约的出房合同（用于构造消息）
    const outCt = await C.contract.resolve({ houseId: c.houseId, bizType: 2, status: 2 }, ctx);
    checks.push({
      ok: outCt.ok,
      name: '出房合同（已签约）',
      detail: outCt.ok ? outCt.handle.key : '缺失，无法构造签约消息'
    });
    if (!outCt.ok) missing.push('outContract');

    return {
      ok: missing.length === 0,
      checks,
      missing,
      // 只缺 installOrder 时仍可继续（seed 会补）
      canProceed: missing.length === 0 || missing.every(m => m === 'installOrder'),
      context: { ...c, outContractCode: outCt.ok ? outCt.handle.key : null, installOrderId: inst.ok ? inst.handle?.id : null }
    };
  },

  async seed(ctx, pre) {
    const h = pre.context;
    if (ctx.mode !== 'execute') {
      return {
        ok: true, source: 'reused', handle: h,
        detail: h.installOrderId ? '在途安装单已就绪' : '只读模式：将创建在途安装单（需 --execute）'
      };
    }
    // 若缺在途安装单则补一条
    return C.installOrder.ensure({ houseId: h.houseId, cityCode: h.cityCode }, ctx);
  },

  async trigger(ctx, pre, opts = {}) {
    const h = pre.context;
    if (!h.outContractCode) {
      return { ok: false, reason: 'no_out_contract', message: '缺少出房合同，无法构造签约消息' };
    }
    if (ctx.mode !== 'execute') {
      return {
        ok: false, reason: 'readonly',
        message: `将向 ${TOPIC} 发送 eventType=1103 签约消息: contractCode=${h.outContractCode}, houseCode=${h.houseId}`
      };
    }
    const { Kafka } = await import('kafkajs');
    const kafka = new Kafka({ brokers: [BROKER], clientId: 'seeder-trigger' });
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: TOPIC,
      messages: [{
        key: String(h.houseId),
        value: JSON.stringify({
          detail: {
            bizType: 2, subBizType: 1, status: 2, eventType: 1103,
            contractCode: h.outContractCode,
            houseCode: Number(h.houseId),
            cityCode: h.cityCode,
            cellCode: Number(h.houseId) * 100 + 1,
            timeStamp: Date.now()
          },
          traceId: ''
        })
      }]
    });
    await producer.disconnect();
    return { ok: true, detail: '已发送签约消息', handle: h };
  },

  async assert(ctx, pre, opts = {}) {
    const logs = createLogSource({ file: opts.logFile, testApp: opts.testApp }, ctx);
    const pushEnabled = opts.pushEnabled !== false;
    const evidence = [];

    // 等待 Kafka 消费 + 异步落盘
    await new Promise(r => setTimeout(r, opts.waitMs || 15000));

    // 前置：必须走到新签
    const WINDOW = { since: 5 * 60 * 1000 };
    evidence.push(await logs.expect('【新签】new sign houseCode', WINDOW));
    // 前置：必须查到任务处理人
    evidence.push(await logs.expect('获取租务侧任务的处理人成功', WINDOW));

    if (pushEnabled) {
      evidence.push(await logs.expect('签约在途安装单提醒 Link Push 发送完成', WINDOW));
      evidence.push(await logs.expect(SMS_TEMPLATE, { ...WINDOW, shouldExist: false }));
    } else {
      evidence.push(await logs.expect(SMS_TEMPLATE));
      evidence.push(await logs.expect('Link Push 发送完成', { shouldExist: false }));
    }

    return { ok: evidence.every(e => e.ok), evidence };
  },

  async cleanup(ctx) {
    if (ctx.mode !== 'execute') return { ok: true, planned: [], done: [] };
    return { ok: true, planned: ctx.ledger.reverseOrder() };
  }
};
