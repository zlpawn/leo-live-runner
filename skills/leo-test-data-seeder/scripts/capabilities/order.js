/**
 * order 家服订单 —— 可造（调接口）
 * 创建：POST /api/manager/cloud/maintain/create
 * 取消：POST /api/manager/cloud/order/cancel
 *
 * 前置：房源 + 合同 + 权益实例且商品在白名单，三者缺一必失败。
 * 副作用：创建成功后家服自动发社区服务单 Kafka 消息，可能触发下游通知。
 */
const SERVICE = 'beijia-trade-access';
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json'
};

async function post(ctx, path, body, extraHeaders = {}) {
  const svc = ctx.systems.getHttpService(SERVICE);
  const url = `${svc.baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

export async function ensure({
  houseResourceId,
  contractId,
  templateInstId,
  shelfCodeList,
  serviceTime,
  contactUser,
  contactUserMobile,
  userRemark = 'AI验证',
  channelCode = 'newpuzuManager',
  fromSource = 'zuwu-auto-create-task',
  ucid = process.env.SEEDER_OPERATOR_UCID || '1000000030556621',
  sid = 'zulin-iot-platform-pa'
}, ctx) {
  if (ctx.mode !== 'execute') {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'order_create_readonly',
      message: `只读模式不创建家服订单。需要 POST ${SERVICE}/api/manager/cloud/maintain/create`,
      missing: ['order'],
      candidates: []
    };
  }

  const body = {
    houseResourceId,
    contractId,
    templateInstId,
    commodityCodeList: shelfCodeList,
    commodityInfos: null,
    emergencyType: 0,
    contactUser,
    contactUserMobile,
    userRemark,
    serviceTime,
    templateTagType: 1,
    fromSource,
    channelCode
  };

  const { status, json } = await post(ctx, '/api/manager/cloud/maintain/create', body, {
    'X-BeiKe-Ucid': String(ucid || ''),
    'X-Ke-Sid': sid
  });

  if (json?.errno !== '0' || !json?.data?.orderCode) {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'order_create_failed',
      message: `家服建单失败: errno=${json?.errno}, errmsg=${json?.errmsg || json?.error || ''}`,
      missing: [],
      candidates: []
    };
  }

  const orderCode = json.data.orderCode;
  ctx.ledger.record({
    capability: 'order',
    system: SERVICE,
    key: orderCode,
    kind: 'api',
    payload: { path: '/api/manager/cloud/order/cancel', body: { orderCode, cancelReason: 1, cancelRemark: 'AI验证数据清理' } },
    description: `家服订单 orderCode=${orderCode}`
  });

  return {
    ok: true,
    handle: {
      type: 'order',
      id: orderCode,
      key: orderCode,
      meta: { houseResourceId, contractId, templateInstId, shelfCodeList, serviceTime }
    },
    source: 'created',
    cleanup: { reversible: true, kind: 'api', payload: 'POST /api/manager/cloud/order/cancel' },
    reason: null, message: null, missing: [], candidates: []
  };
}

export async function reverse({ orderCode }, ctx) {
  if (ctx.mode !== 'execute') {
    return { ok: false, reason: 'readonly', message: '只读模式不执行取消' };
  }
  const { json } = await post(ctx, '/api/manager/cloud/order/cancel', {
    orderCode,
    cancelReason: 1,
    cancelRemark: 'AI验证数据清理'
  });
  return { ok: json?.errno === '0', message: json?.errmsg || '' };
}
