/**
 * Task 4 · 自研门锁维修单 → 客服跟进短信
 *
 * 验证 SendMessageLogicImpl.sendMessageRepairOrderFollowUpWithFallback：
 *   首号码未达限额 → 发首号码
 *   首号码达 300   → 轮转下一号码
 *   首号码失败     → 轮转下一号码
 *   Redis 异常     → Fail-Open 放行
 *   非 hui_ju 单   → 静默跳过
 *
 * 文档：references/scenarios/task4-customer-service.md
 */
import { capabilities as C } from '../capabilities/index.js';
import { createLogSource } from '../common/logs.js';

const SMS_TEMPLATE = 'repair_order_notify_customer_service';
const DAILY_KEY = (phone, ymd) => `iot:sms:daily_count:${SMS_TEMPLATE}:${phone}:${ymd}`;

export default {
  name: 'sms-task4-customer-service',
  description: '自研门锁维修单的客服跟进短信限额轮转',

  async precheck(ctx, _carry, opts = {}) {
    const checks = [];
    const missing = [];

    // 1. 先确定开城城市，优先在开城城市里找门锁
    const openCities = await getCustomerServiceCities(ctx, 'hui_ju');
    let lock = null;
    let usedCity = null;

    if (!opts.cityCode && openCities.length) {
      for (const city of openCities) {
        const candidate = await C.discover.findLock({
          cityCode: city, manufacturerCode: 'hui_ju'
        }, ctx);
        if (candidate.ok) { lock = candidate; usedCity = city; break; }
      }
    }
    if (!lock) {
      lock = await C.discover.findLock({
        cityCode: opts.cityCode,
        manufacturerCode: 'hui_ju',
        requireNoTenant: false,
        requireNotToLandlord: false
      }, ctx);
    }
    checks.push({
      ok: lock.ok,
      name: 'hui_ju 门锁',
      detail: lock.ok
        ? `house ${lock.handle.houseId} / 售后厂商 ${lock.handle.afterSaleManufacturerCode}`
        : `[${lock.reason}] ${lock.message}`
    });
    if (!lock.ok) {
      missing.push('lock');
      return { ok: false, checks, missing, canProceed: false, message: lock.message };
    }

    // 2. 售后厂商必须是 hui_ju
    const isHuiJu = lock.handle.afterSaleManufacturerCode === 'hui_ju';
    checks.push({
      ok: isHuiJu,
      name: '售后厂商 = hui_ju',
      detail: lock.handle.afterSaleManufacturerCode
    });
    if (!isHuiJu) missing.push('hui_ju');

    // 3. 房源存在
    const house = await C.house.resolve({ houseId: lock.handle.houseId }, ctx);
    checks.push({ ok: house.ok, name: '房源', detail: house.ok ? lock.handle.houseId : '缺失' });

    // 4. 客服跟进开城（关键：城市必须在该厂商的配置里）
    const cityOpen = openCities.includes(String(lock.handle.cityCode));
    checks.push({
      ok: cityOpen,
      name: '客服跟进开城',
      detail: cityOpen
        ? `${lock.handle.cityCode} 已开城`
        : `${lock.handle.cityCode} 未开城（已开城: ${openCities.join(', ') || '无'}）`
    });
    if (!cityOpen) missing.push('customerServiceOpenCity');

    return {
      ok: missing.length === 0,
      checks,
      missing,
      canProceed: missing.length === 0,
      context: lock.handle
    };
  },

  async seed(ctx, pre) {
    return { ok: true, source: 'reused', handle: pre.context };
  },

  async trigger(ctx, pre, opts = {}) {
    const h = pre.context;
    if (ctx.mode !== 'execute') {
      return {
        ok: false, reason: 'readonly',
        message: `将 POST /iot/repairOrders/add，deviceId=${h.lockId}, orderType=common`
      };
    }
    const baseUrl = process.env.SEEDER_IOT_BASE_URL || 'http://127.0.0.1:18081';
    const res = await fetch(`${baseUrl}/iot/repairOrders/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'lianjia-ucid': opts.operatorUcid || '1000000030556621',
        'name': opts.operatorName || 'AI-verify'
      },
      body: JSON.stringify({
        contactName: '测试租客',
        faultType: '1',
        manufacturerCode: h.manufacturerCode,
        afterSaleManufacturerCode: h.afterSaleManufacturerCode,
        deviceTypeCode: 1,
        deviceId: h.lockId,
        orderType: 'common',
        phone: opts.phone || '00000000000',
        content: 'AI-verify lock repair',
        planVisitStartTime: opts.planVisitStartTime || tomorrow(9),
        planVisitEndTime: opts.planVisitEndTime || tomorrow(12)
      })
    });
    const json = await res.json().catch(() => ({}));
    const ok = json?.success === true;
    return { ok, detail: ok ? `工单 id=${json.data}` : `失败: ${json?.msg}`, handle: { ...h, orderId: json?.data } };
  },

  async assert(ctx, pre, opts = {}) {
    const logs = createLogSource({ file: opts.logFile, testApp: opts.testApp }, ctx);
    const mode = opts.expect || 'normal';   // normal | rotate | failopen | skip
    const evidence = [];

    if (mode === 'normal') {
      evidence.push(await logs.expect('客服跟进短信发送成功'));
    } else if (mode === 'rotate') {
      evidence.push(await logs.expect('已达限额'));
      evidence.push(await logs.expect('客服跟进短信发送成功'));
    } else if (mode === 'failopen') {
      evidence.push(await logs.expect('Fail-Open放行'));
      evidence.push(await logs.expect('客服跟进短信发送成功'));
    } else if (mode === 'skip') {
      evidence.push(await logs.expect('非自研门锁维修单无需客服跟进短信'));
      evidence.push(await logs.expect('客服跟进短信发送成功', { shouldExist: false }));
    }

    return { ok: evidence.every(e => e.ok), evidence };
  },

  async cleanup(ctx, pre) {
    if (ctx.mode !== 'execute') return { ok: true, planned: [], done: [] };
    return { ok: true, planned: ctx.ledger.reverseOrder() };
  }
};

function tomorrow(hour) {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00`;
}

/**
 * 读取 Apollo repair.order.customer.service.city，返回指定厂商已开城的城市列表。
 * 未接入 Apollo 客户端时返回空数组（视为未开城）。
 */
async function getCustomerServiceCities(ctx, manufacturerCode) {
  try {
    const cfg = ctx.systems.config?.apollo;
    if (!cfg) return [];
    // 通过 Apollo ConfigService 拉取
    const url = `${cfg.test.configService}/configs/${cfg.test.appId}/default/application`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = data?.configurations?.['repair.order.customer.service.city'];
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Object.keys(parsed[manufacturerCode] || {});
  } catch {
    return [];
  }
}
