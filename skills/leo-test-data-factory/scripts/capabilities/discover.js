/**
 * discover 自动发现：按条件扫出可用的数据组合，不依赖文档里写死的 ID。
 *
 * 这是 skill 真正「开箱即用」的关键——测试环境数据天天变，
 * 使用者不该被要求知道某个合同号。
 */
import * as contract from './contract.js';
import * as equity from './equity.js';
import * as commodity from './commodity.js';
import * as managerTask from './managerTask.js';
import * as installOrder from './installOrder.js';

/**
 * 找一份「有指定权益、且该城市有白名单内商品」的合同。
 *
 * @param {Object} opts
 * @param {string} opts.templateCode   权益模板编码，如 'lock_install'
 * @param {string} [opts.cityCode]     限定城市，不传则全城市扫
 * @param {string} [opts.workOrderType] 工单类型，如 'INS' / 'REPAIR'，用于选商品
 * @param {number} [opts.limit]        最多返回几个候选
 */
export async function findContractWithUsableEquity({ templateCode, cityCode, workOrderType = 'INS', limit = 5 }, ctx) {
  // 1. 扫出所有有该模板有效实例的合同
  let sql = `
    SELECT ti.id AS templateInstId, ti.biz_code AS contractId, pi.city_code AS cityCode
      FROM template_instance ti
      JOIN template t ON t.id = ti.template_id
      JOIN package_instance pi ON pi.biz_code = ti.biz_code
       AND pi.package_id = ti.package_id
     WHERE t.code = ?
       AND ti.status = 2
       AND pi.status = 1
       AND ti.effective_start_time <= NOW()
       AND ti.effective_end_time >= NOW()`;
  const params = [templateCode];
  if (cityCode) { sql += ' AND pi.city_code = ?'; params.push(String(cityCode)); }
  sql += ' ORDER BY ti.id DESC LIMIT ?';
  params.push(limit * 20);

  const candidates = await ctx.systems.query('sun-core', sql, params);
  if (!candidates.length) {
    return {
      ok: false, reason: 'no_contract_with_equity',
      message: `未找到任何持有 ${templateCode} 权益的合同${cityCode ? `（城市 ${cityCode}）` : ''}`,
      candidates: []
    };
  }

  // 2. 逐个验证：合同有效 + 商品在白名单内
  const usable = [];
  const rejected = [];

  for (const c of candidates) {
    const cid = Number(c.contractId);
    const city = String(c.cityCode);

    // 合同必须存在且已签约
    const ct = await contract.resolve({ contractId: cid, status: 2 }, ctx);
    if (!ct.ok) {
      rejected.push({ contractId: cid, cityCode: city, reason: 'contract_not_signed' });
      continue;
    }

    // 校验扫到的实例确实属于该合同（防止 JOIN 串行导致张冠李戴）
    const instCheck = await ctx.systems.query(
      'sun-core',
      'SELECT id, biz_code FROM template_instance WHERE id = ?',
      [Number(c.templateInstId)]
    );
    if (!instCheck.length || String(instCheck[0].biz_code) !== String(cid)) {
      rejected.push({ contractId: cid, cityCode: city, reason: 'template_inst_mismatch' });
      continue;
    }

    // 拿白名单
    const eqProbe = await equity.resolve({ contractId: cid, templateCode, cityCode: city }, ctx);
    if (!eqProbe.handle?.meta) {
      rejected.push({ contractId: cid, cityCode: city, reason: eqProbe.reason });
      continue;
    }
    const whitelist = eqProbe.handle.meta.whitelist;

    // 按白名单挑商品
    const cmd = await commodity.resolveWithWhitelist({ cityCode: city, workOrderType, whitelist }, ctx);
    if (!cmd.ok) {
      rejected.push({ contractId: cid, cityCode: city, reason: cmd.reason });
      continue;
    }

    usable.push({
      contractCode: ct.handle.key,
      contractId: cid,
      houseId: ct.handle.meta.houseId,
      cityCode: city,
      templateInstId: Number(c.templateInstId),
      shelfCode: cmd.handle.key,
      commodityCode: cmd.handle.meta.commodityCode,
      commodityName: cmd.handle.meta.commodityName,
      whitelist
    });

    if (usable.length >= limit) break;
  }

  if (!usable.length) {
    return {
      ok: false,
      reason: 'no_usable_combination',
      message: `找到 ${candidates.length} 个持有 ${templateCode} 权益的合同，但都不满足「已签约 + 商品在白名单内」`,
      candidates: [],
      rejected: rejected.slice(0, 10)
    };
  }

  return {
    ok: true,
    handle: usable[0],
    source: 'reused',
    candidates: usable.slice(1),
    rejected: rejected.slice(0, 10)
  };
}

/**
 * 找一份「有在途安装单 + 有收房合同 + 收房合同有任务处理人」的组合（Task 2 用）。
 */
export async function findSignInstallCombination({ cityCode, requireInFlightInstall = false, limit = 3 }, ctx) {
  let sql = `
    SELECT DISTINCT upstream_code AS contractCode, house_code AS houseId, city_code AS cityCode
      FROM manager_task
     WHERE task_type = 4 AND biz_type = 1
       AND EXISTS (SELECT 1 FROM task_relation r WHERE r.task_id = manager_task.task_id AND r.is_delete = 0)`;
  const params = [];
  if (cityCode) { sql += ' AND city_code = ?'; params.push(String(cityCode)); }
  sql += ' ORDER BY ctime DESC LIMIT ?';
  params.push(limit * 20);

  const rows = await ctx.systems.query('manager-workbench', sql, params);
  if (!rows.length) {
    return {
      ok: false, reason: 'no_contract_with_task_users',
      message: '未找到「门锁签约任务且有处理人」的收房合同',
      candidates: []
    };
  }

  const usable = [];
  const pendingInstall = [];

  for (const r of rows) {
    const mt = await managerTask.resolve({ contractCode: r.contractCode }, ctx);
    if (!mt.ok) continue;

    const item = {
      inContractCode: r.contractCode,
      houseId: String(r.houseId),
      cityCode: String(r.cityCode),
      dealUsers: mt.handle.meta.dealUsers
    };

    if (requireInFlightInstall) {
      // 同时要求该房源已有在途安装单
      const inst = await installOrder.resolve({ houseId: item.houseId, inFlight: true }, ctx);
      if (!inst.ok) {
        pendingInstall.push({ ...item, missing: 'installOrder' });
        continue;
      }
      item.installOrderId = inst.handle.id;
      item.thirdOrderCode = inst.handle.key;
    }

    usable.push(item);
    if (usable.length >= limit) break;
  }

  if (!usable.length) {
    if (pendingInstall.length) {
      return {
        ok: false,
        reason: 'install_order_missing',
        message: `找到 ${pendingInstall.length} 个「有任务处理人」的收房合同，但房源均无在途安装单（execute 模式可自动创建）`,
        handle: pendingInstall[0],
        candidates: pendingInstall.slice(1)
      };
    }
    return { ok: false, reason: 'no_usable_combination', message: '候选收房合同均无有效处理人', candidates: [] };
  }
  return { ok: true, handle: usable[0], source: 'reused', candidates: usable.slice(1) };
}

/**
 * 找一把可用于通知类场景的门锁房源（Task 4 / Task 5 用）。
 *
 * @param {Object} opts
 * @param {string} [opts.cityCode]           限定城市
 * @param {string} [opts.manufacturerCode]   厂商，如 'hui_ju'
 * @param {boolean} [opts.requireNoTenant]   要求无租客授权（低电量管家分支需要）
 * @param {boolean} [opts.requireNotToLandlord] 要求未移交业主
 * @param {number} [opts.limit]
 */
export async function findLock({
  cityCode,
  manufacturerCode = 'hui_ju',
  requireNoTenant = false,
  requireNotToLandlord = true,
  limit = 5
} = {}, ctx) {
  let sql = `
    SELECT l.lock_id, l.house_id, l.house_type, l.manufacturer_code,
           l.after_sale_manufacturer_code, l.prod_type, l.battery, l.to_landlord,
           h.city_code, h.city_name, h.house_address
      FROM house_lock l
      JOIN house_info h ON l.house_id = h.house_id AND l.house_type = h.house_type
     WHERE l.house_type = 2 AND l.status = 1
       AND l.manufacturer_code = ?`;
  const params = [manufacturerCode];

  if (cityCode) { sql += ' AND h.city_code = ?'; params.push(Number(cityCode)); }
  if (requireNotToLandlord) { sql += ' AND l.to_landlord = 0'; }
  if (requireNoTenant) {
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM lock_auth_info a
       WHERE a.house_id = l.house_id AND a.house_type = l.house_type AND a.target_type = 1
    )`;
  }
  sql += ' ORDER BY l.id DESC LIMIT ?';
  params.push(limit * 5);

  const rows = await ctx.systems.query('iot-platform', sql, params);
  if (!rows.length) {
    return {
      ok: false, reason: 'no_lock_found',
      message: `未找到符合条件的门锁（manufacturer=${manufacturerCode}${cityCode ? `, city=${cityCode}` : ''}）`,
      candidates: []
    };
  }

  const usable = rows.slice(0, limit).map(r => ({
    lockId: r.lock_id,
    houseId: String(r.house_id),
    houseType: r.house_type,
    cityCode: String(r.city_code),
    cityName: r.city_name,
    address: r.house_address,
    manufacturerCode: r.manufacturer_code,
    afterSaleManufacturerCode: r.after_sale_manufacturer_code,
    prodType: r.prod_type,
    battery: r.battery
  }));

  return {
    ok: true,
    handle: usable[0],
    source: 'reused',
    candidates: usable.slice(1)
  };
}

/**
 * 找一台「门锁已在白名单城市开城」的管家低电量场景可用房源（Task 5 用）。
 * 同时返回当前 Apollo 白名单，便于断言。
 */
export async function findLowBatteryCandidate({ cityCode, manufacturerCode = 'hui_ju', limit = 5 } = {}, ctx) {
  return findLock({ cityCode, manufacturerCode, requireNoTenant: true, requireNotToLandlord: true, limit }, ctx);
}
