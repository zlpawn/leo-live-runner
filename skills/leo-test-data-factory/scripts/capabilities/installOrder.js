/**
 * installOrder 在途安装单 —— 可造
 * 载体：iot_plat.install_order_detail
 *
 * 致命陷阱：checkInstallOrder 查询条件是 status = 4 AND order_status IN (1,2,3)。
 * 两个字段任一不符就查不到，默认值必须同时给对。
 */
const SYSTEM = 'iot-platform';

// 与 getValidInstallOrderDetailByHouseId 完全一致的查询条件
const IN_FLIGHT_CONDITION = 'status = 4 AND order_status IN (1,2,3)';

export async function resolve({ houseId, inFlight = true }, ctx) {
  const sql = inFlight
    ? `SELECT id, house_id, house_type, city_code, address, manufacturer_code, third_order_code, status, order_status
         FROM install_order_detail WHERE house_id = ? AND ${IN_FLIGHT_CONDITION} ORDER BY id DESC LIMIT 1`
    : `SELECT id, house_id, house_type, city_code, address, manufacturer_code, third_order_code, status, order_status
         FROM install_order_detail WHERE house_id = ? ORDER BY id DESC LIMIT 1`;

  const rows = await ctx.systems.query(SYSTEM, sql, [String(houseId)]);
  if (!rows.length) {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: inFlight ? 'install_order_not_in_flight' : 'install_order_not_found',
      message: inFlight
        ? `房源 ${houseId} 无在途安装单（需 status=4 且 order_status IN (1,2,3)）`
        : `房源 ${houseId} 无安装单`,
      missing: ['installOrder'],
      candidates: []
    };
  }
  const r = rows[0];
  return {
    ok: true,
    handle: {
      type: 'installOrder',
      id: r.id,
      key: r.third_order_code,
      meta: {
        houseId: String(r.house_id),
        houseType: r.house_type,
        cityCode: String(r.city_code),
        address: r.address,
        manufacturerCode: r.manufacturer_code,
        status: r.status,
        orderStatus: r.order_status
      }
    },
    source: 'reused',
    cleanup: null,
    reason: null, message: null, missing: [], candidates: []
  };
}

export async function ensure({ houseId, cityCode, address, manufacturerCode = 'hui_ju', thirdOrderCode, status = 4, orderStatus = 1, contactPhone }, ctx) {
  const existing = await resolve({ houseId, inFlight: true }, ctx);
  if (existing.ok) return existing;

  if (ctx.mode !== 'execute') {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'install_order_missing_readonly',
      message: `房源 ${houseId} 无在途安装单，只读模式不创建`,
      missing: ['installOrder'],
      candidates: []
    };
  }

  const finalCode = thirdOrderCode || `T-AI-${Date.now()}`;
  const result = await ctx.systems.execute(
    SYSTEM,
    `INSERT INTO install_order_detail
       (order_time, house_type, rent_type, mount_location, house_id, standard_house_id,
        address, city_code, city, source_code, source_type,
        manufacturer_code, manufacturer_name, device_type_code, device_type_name,
        prod_type, prod_type_name, status, order_status,
        op_person_ucid, op_person_name, contact_name, contact_phone,
        third_order_code, is_direct_connection, ctime, mtime, biz_category)
     VALUES (NOW(), 2, 0, 0, ?, 0, ?, ?, '', 'light', 3,
             ?, '惠居', 1, '门锁', 'HJ02', '惠居NB锁', ?, ?,
             0, 'AI验证', '测试租客', ?,
             ?, 1, NOW(), NOW(), 0)`,
    [String(houseId), address || `AI验证房源${houseId}`, cityCode, manufacturerCode, status, orderStatus,
     contactPhone || '00000000000', finalCode],
    ctx
  );

  const newId = result.insertId;
  ctx.ledger.record({
    capability: 'installOrder',
    system: SYSTEM,
    key: finalCode,
    kind: 'sql',
    payload: { sql: 'DELETE FROM install_order_detail WHERE id = ?', params: [newId] },
    description: `在途安装单 id=${newId} (house ${houseId})`
  });

  return {
    ok: true,
    handle: {
      type: 'installOrder',
      id: newId,
      key: finalCode,
      meta: { houseId: String(houseId), cityCode: String(cityCode), address, manufacturerCode, status, orderStatus }
    },
    source: 'created',
    cleanup: { reversible: true, kind: 'sql', payload: 'DELETE FROM install_order_detail WHERE id = ?' },
    reason: null, message: null, missing: [], candidates: []
  };
}

export async function reverse({ id }, ctx) {
  await ctx.systems.execute(SYSTEM, 'DELETE FROM install_order_detail WHERE id = ?', [id], ctx);
  return { ok: true };
}
