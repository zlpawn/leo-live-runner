/**
 * contract 合同 —— 仅查
 * 载体：trusteeship_contract.contract
 * 注意：contractId（数字）与 contractCode（字符串）是两个体系，跨表必须显式转换
 */
const SYSTEM = 'trusteeship-contract';

const SELECT_COLS = 'id, contract_code, house_code, city_code, biz_type, sub_biz_type, status, real_signed_time, product_type';

function toHandle(row) {
  return {
    type: 'contract',
    id: row.id,
    key: row.contract_code,
    meta: {
      houseId: String(row.house_code),
      cityCode: String(row.city_code),
      bizType: row.biz_type,
      subBizType: row.sub_biz_type,
      status: row.status
    }
  };
}

export async function resolve(cond, ctx) {
  const { contractCode, contractId, houseId, bizType, status } = cond;

  let sql = `SELECT ${SELECT_COLS} FROM contract WHERE 1=1`;
  const params = [];

  if (contractCode) { sql += ' AND contract_code = ?'; params.push(contractCode); }
  if (contractId) { sql += ' AND id = ?'; params.push(contractId); }
  if (houseId) { sql += ' AND house_code = ?'; params.push(Number(houseId)); }
  if (bizType != null) { sql += ' AND biz_type = ?'; params.push(bizType); }
  if (status != null) { sql += ' AND status = ?'; params.push(status); }

  sql += ' ORDER BY id DESC LIMIT 5';

  const rows = await ctx.systems.query(SYSTEM, sql, params);
  if (!rows.length) {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'contract_not_found',
      message: `未找到符合条件的合同：${JSON.stringify(cond)}`,
      missing: ['contract'],
      candidates: []
    };
  }
  return {
    ok: true,
    handle: toHandle(rows[0]),
    source: 'reused',
    cleanup: null,
    reason: null,
    message: null,
    missing: [],
    candidates: rows.slice(1).map(r => ({ contractCode: r.contract_code, contractId: r.id, houseId: String(r.house_code) }))
  };
}

export async function ensure(cond, ctx) {
  // 仅查能力：ensure 等价 resolve，永不造
  return resolve(cond, ctx);
}

export async function resolveIdByCode(contractCode, ctx) {
  const r = await resolve({ contractCode }, ctx);
  return r.ok ? r.handle.id : null;
}

export async function resolveCodeById(contractId, ctx) {
  const r = await resolve({ contractId }, ctx);
  return r.ok ? r.handle.key : null;
}

export async function reverse() {
  throw new Error('contract 是仅查能力，不支持 reverse');
}
