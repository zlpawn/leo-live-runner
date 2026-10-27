/**
 * equity 权益 —— 仅查
 * 载体：sun_core 库（package_instance / template_instance / beijia_goods_range）
 *
 * 解析链三步（缺一不可）：
 *   1. package_instance：biz_code = contractId, city_code, status = 1
 *   2. template_instance：template_id = template.id（按 code 匹配）, status = 2, 有效期覆盖当天
 *   3. beijia_goods_range 白名单：template_id, type = 1, col_four = shelfCode
 *
 * 第 3 步是最容易漏的：权益实例存在但白名单不含货架码时，家服仍报「无可用权益」。
 */
const SYSTEM = 'sun-core';

export async function resolve({ contractId, templateCode, cityCode, shelfCode }, ctx) {
  // 1. 找模板
  const templates = await ctx.systems.query(
    SYSTEM,
    'SELECT id, code, name, use_range_type, status FROM template WHERE code = ? LIMIT 1',
    [templateCode]
  );
  if (!templates.length) {
    return fail('template_not_found', `权益模板 ${templateCode} 不存在`, ['equity']);
  }
  const template = templates[0];

  // 2. 找权益包实例
  let pkgSql = 'SELECT id, city_code, biz_code, package_id, status FROM package_instance WHERE biz_code = ? AND status = 1';
  const pkgParams = [String(contractId)];
  if (cityCode) { pkgSql += ' AND city_code = ?'; pkgParams.push(String(cityCode)); }
  const pkgs = await ctx.systems.query(SYSTEM, pkgSql, pkgParams);
  if (!pkgs.length) {
    return fail('package_instance_missing',
      `合同 ${contractId} 在${cityCode ? `城市 ${cityCode} ` : ''}没有权益包实例`, ['equity']);
  }

  // 3. 找模板实例
  // 注意：template_instance.package_id 关联的是 package_instance.package_id（即 package.id），
  // 不是 package_instance.id。这是实测踩过的坑。
  const pkgDefIds = [...new Set(pkgs.map(p => p.package_id))];
  const placeholders = pkgDefIds.map(() => '?').join(',');
  const insts = await ctx.systems.query(
    SYSTEM,
    `SELECT id, package_id, template_id, biz_code, stock, remain_amount, status,
            effective_start_time, effective_end_time
       FROM template_instance
      WHERE package_id IN (${placeholders})
        AND template_id = ?
        AND status = 2
      ORDER BY id DESC`,
    [...pkgDefIds, template.id]
  );

  const now = Date.now();
  const validInst = insts.find(i => {
    const start = i.effective_start_time ? new Date(i.effective_start_time).getTime() : 0;
    const end = i.effective_end_time ? new Date(i.effective_end_time).getTime() : Number.MAX_SAFE_INTEGER;
    return start <= now && now <= end;
  });

  if (!validInst) {
    return fail('equity_instance_missing',
      `合同 ${contractId} 有权益包但无有效的 ${templateCode} 实例（status=2 且有效期未覆盖当天）。` +
      `共查到 ${insts.length} 条实例`, ['equity']);
  }
  const inst = validInst;

  // 4. 白名单二次校验（最容易漏的一步）
  const whitelistRows = await ctx.systems.query(
    SYSTEM,
    'SELECT col_four FROM beijia_goods_range WHERE template_id = ? AND type = 1',
    [template.id]
  );
  const whitelist = whitelistRows.map(r => r.col_four).filter(Boolean);
  const goodsRangeOk = !shelfCode || whitelist.includes(shelfCode);

  const handle = {
    type: 'equity',
    id: inst.id,
    key: templateCode,
    meta: {
      instId: inst.id,
      templateId: template.id,
      packageId: inst.package_id,
      contractId: Number(contractId),
      cityCode: cityCode ? String(cityCode) : null,
      shelfCode: shelfCode || null,
      goodsRangeOk,
      whitelist
    }
  };

  if (!goodsRangeOk) {
    return {
      ok: false,
      handle,
      source: 'reused',
      cleanup: null,
      reason: 'equity_not_in_goods_range',
      message: `权益 ${templateCode} 的商品白名单不含 ${shelfCode}。白名单：${whitelist.join(', ') || '(空)'}`,
      missing: [],
      candidates: whitelist.map(code => ({ shelfCode: code }))
    };
  }

  return {
    ok: true,
    handle,
    source: 'reused',
    cleanup: null,
    reason: null,
    message: null,
    missing: [],
    candidates: []
  };
}

export async function ensure(cond, ctx) {
  // 仅查能力：ensure 等价 resolve，永不造
  return resolve(cond, ctx);
}

export async function reverse() {
  throw new Error('equity 是仅查能力，不支持 reverse');
}

function fail(reason, message, missing) {
  return { ok: false, handle: null, source: null, cleanup: null, reason, message, missing, candidates: [] };
}
