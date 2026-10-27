/**
 * lock 门锁 —— 可造
 * 载体：iot_plat.house_lock
 */
const SYSTEM = 'iot-platform';

export async function resolve({ houseId, houseType = 2 }, ctx) {
  const rows = await ctx.systems.query(
    SYSTEM,
    `SELECT lock_id, house_id, house_type, manufacturer_code, after_sale_manufacturer_code,
            prod_type, status, battery, to_landlord
       FROM house_lock
      WHERE house_id = ? AND house_type = ?
      LIMIT 1`,
    [String(houseId), houseType]
  );
  if (!rows.length) {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'lock_not_found',
      message: `房源 ${houseId} 未安装门锁`,
      missing: ['lock'],
      candidates: []
    };
  }
  const r = rows[0];
  return {
    ok: true,
    handle: {
      type: 'lock',
      id: r.lock_id,
      key: r.lock_id,
      meta: {
        houseId: String(r.house_id),
        houseType: r.house_type,
        manufacturerCode: r.manufacturer_code,
        afterSaleManufacturerCode: r.after_sale_manufacturer_code,
        prodType: r.prod_type,
        battery: r.battery,
        toLandlord: r.to_landlord
      }
    },
    source: 'reused',
    cleanup: null,
    reason: null,
    message: null,
    missing: [],
    candidates: []
  };
}

/**
 * 造安装单前必须确保无锁
 */
export async function ensureAbsent({ houseId, houseType = 2 }, ctx) {
  const existing = await resolve({ houseId, houseType }, ctx);
  if (!existing.ok) {
    return { ok: true, handle: null, source: null, cleanup: null, reason: null, message: null, missing: [], candidates: [] };
  }
  return {
    ok: false,
    handle: existing.handle,
    source: null,
    cleanup: null,
    reason: 'lock_exists',
    message: `房源 ${houseId} 已装锁（lockId=${existing.handle.id}），造安装单前需先移除`,
    missing: [],
    candidates: [{ action: 'remove_lock', lockId: existing.handle.id }]
  };
}

export async function ensure({ houseId, houseType = 2, lockId, manufacturerCode, afterSaleManufacturerCode, prodType = 'HJ02' }, ctx) {
  const existing = await resolve({ houseId, houseType }, ctx);
  if (existing.ok) return existing;

  if (ctx.mode !== 'execute') {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'lock_missing_readonly',
      message: `房源 ${houseId} 无门锁，只读模式不创建`,
      missing: ['lock'],
      candidates: []
    };
  }

  const finalLockId = lockId || `AI${Date.now()}`;
  await ctx.systems.execute(
    SYSTEM,
    `INSERT INTO house_lock
       (lock_id, house_id, house_type, source_code, source_type,
        manufacturer_code, after_sale_manufacturer_code, prod_type,
        status, to_landlord, ctime, mtime)
     VALUES (?, ?, ?, 'light', 3, ?, ?, ?, 1, 0, NOW(), NOW())`,
    [finalLockId, String(houseId), houseType, manufacturerCode, afterSaleManufacturerCode || manufacturerCode, prodType],
    ctx
  );

  ctx.ledger.record({
    capability: 'lock',
    system: SYSTEM,
    key: finalLockId,
    kind: 'sql',
    payload: { sql: 'DELETE FROM house_lock WHERE lock_id = ?', params: [finalLockId] },
    description: `门锁 lock_id=${finalLockId} (house ${houseId})`
  });

  return {
    ok: true,
    handle: {
      type: 'lock',
      id: finalLockId,
      key: finalLockId,
      meta: { houseId: String(houseId), houseType, manufacturerCode, afterSaleManufacturerCode: afterSaleManufacturerCode || manufacturerCode, prodType }
    },
    source: 'created',
    cleanup: { reversible: true, kind: 'sql', payload: 'DELETE FROM house_lock WHERE lock_id = ?' },
    reason: null, message: null, missing: [], candidates: []
  };
}

export async function reverse({ lockId }, ctx) {
  await ctx.systems.execute(SYSTEM, 'DELETE FROM house_lock WHERE lock_id = ?', [lockId], ctx);
  return { ok: true };
}
