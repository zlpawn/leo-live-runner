/**
 * commodity 商品 —— 仅查
 * 载体：beijia_commodity 库
 * 注意：shelf_code（SCM…，下单用）与 commodity_code（CM…，配置用）不可混用
 */
const SYSTEM = 'beijia-commodity';

// workOrderType → 一级品类 + 商品名关键词
const WORK_ORDER_MATCH = {
  INS: { level1: '10003', nameLike: '%安装%' },
  REPAIR: { level1: '10003', nameLike: '%维修%' },
  FIX: { level1: '10003', nameLike: '%维修%' },
  REPLACE: { level1: '10003', nameLike: '%迁移%' },
  RECYCLE: { level1: '10003', nameLike: '%回收%' }
};

export async function resolve({ cityCode, workOrderType, commodityNameLike, lockOnly = true }, ctx) {
  let sql = `SELECT shelf_code, commodity_code, commodity_name, city_code, city_name,
                    level1_code, level2_code, level3_code, selling_price
               FROM commodity_shelf_info
              WHERE city_code = ? AND del_status = 1 AND shelf_status = 1`;

  const params = [String(cityCode)];

  const match = WORK_ORDER_MATCH[workOrderType];
  if (match) {
    sql += ' AND level1_code = ?';
    params.push(match.level1);
    sql += ' AND commodity_name LIKE ?';
    params.push(match.nameLike);
  }
  if (lockOnly) {
    sql += ' AND commodity_name LIKE ?';
    params.push('%门锁%');
  }
  if (commodityNameLike) {
    sql += ' AND commodity_name LIKE ?';
    params.push(`%${commodityNameLike}%`);
  }

  sql += ' ORDER BY id DESC LIMIT 20';

  const rows = await ctx.systems.query(SYSTEM, sql, params);
  if (!rows.length) {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'commodity_not_found',
      message: `城市 ${cityCode} 未找到 ${workOrderType || ''} 类商品`,
      missing: ['commodity'],
      candidates: []
    };
  }

  const first = rows[0];
  return {
    ok: true,
    handle: {
      type: 'commodity',
      id: first.shelf_code,
      key: first.shelf_code,
      meta: {
        commodityCode: first.commodity_code,
        commodityName: first.commodity_name,
        cityCode: String(first.city_code),
        sellingPrice: first.selling_price
      }
    },
    source: 'reused',
    cleanup: null,
    reason: null,
    message: null,
    missing: [],
    candidates: rows.slice(1).map(r => ({ shelfCode: r.shelf_code, commodityCode: r.commodity_code, name: r.commodity_name }))
  };
}

/**
 * 按白名单挑商品：优先返回 shelf_code 命中白名单的候选。
 * 用于解决「商品存在但权益白名单不含它」的问题。
 */
export async function resolveWithWhitelist({ cityCode, workOrderType, whitelist = [], lockOnly = true }, ctx) {
  const r = await resolve({ cityCode, workOrderType, lockOnly }, ctx);
  if (!r.ok) return r;

  const all = [
    { shelfCode: r.handle.key, commodityCode: r.handle.meta.commodityCode, name: r.handle.meta.commodityName },
    ...r.candidates
  ];
  const hit = all.find(c => whitelist.includes(c.shelfCode));
  if (!hit) {
    return {
      ok: false,
      handle: null,
      source: null,
      cleanup: null,
      reason: 'commodity_not_in_whitelist',
      message: `城市 ${cityCode} 的门锁 ${workOrderType} 商品均不在权益白名单内。` +
        `候选：${all.map(c => c.shelfCode).join(', ')}；白名单：${whitelist.join(', ')}`,
      missing: ['commodity'],
      candidates: all
    };
  }
  return {
    ok: true,
    handle: {
      type: 'commodity',
      id: hit.shelfCode,
      key: hit.shelfCode,
      meta: { commodityCode: hit.commodityCode, commodityName: hit.name, cityCode: String(cityCode) }
    },
    source: 'reused',
    cleanup: null,
    reason: null, message: null, missing: [],
    candidates: all.filter(c => c.shelfCode !== hit.shelfCode)
  };
}

export async function ensure(cond, ctx) {
  // 仅查能力：ensure 等价 resolve，永不造
  return resolve(cond, ctx);
}

/**
 * 按 shelf_code 查商品编码（判断是否门锁类）
 */
export async function resolveByShelfCode(shelfCode, ctx) {
  const rows = await ctx.systems.query(
    SYSTEM,
    'SELECT shelf_code, commodity_code, commodity_name, city_code, level1_code FROM commodity_shelf_info WHERE shelf_code = ? LIMIT 1',
    [shelfCode]
  );
  if (!rows.length) {
    return { ok: false, reason: 'shelf_code_not_found', message: `货架码 ${shelfCode} 不存在`, candidates: [] };
  }
  const r = rows[0];
  return {
    ok: true,
    handle: {
      type: 'commodity',
      id: r.shelf_code,
      key: r.shelf_code,
      meta: { commodityCode: r.commodity_code, commodityName: r.commodity_name, cityCode: String(r.city_code) }
    },
    source: 'reused',
    candidates: []
  };
}

export async function reverse() {
  throw new Error('commodity 是仅查能力，不支持 reverse');
}
