/**
 * house 房源 —— 可造
 * 载体：iot_plat.house_info
 */
const SYSTEM = 'iot-platform';

export async function resolve({ houseId, houseType = 2 }, ctx) {
  const rows = await ctx.systems.query(
    SYSTEM,
    'SELECT house_id, house_type, city_code, city_name, house_address, resblock FROM house_info WHERE house_id = ? AND house_type = ? LIMIT 1',
    [String(houseId), houseType]
  );
  if (!rows.length) {
    return {
      ok: false,
      handle: null,
      source: null,
      cleanup: null,
      reason: 'house_not_found',
      message: `未找到房源 houseId=${houseId}, houseType=${houseType}`,
      missing: ['house'],
      candidates: []
    };
  }
  const r = rows[0];
  return {
    ok: true,
    handle: {
      type: 'house',
      id: r.house_id,
      key: r.house_id,
      meta: { houseType: r.house_type, cityCode: String(r.city_code), cityName: r.city_name, address: r.house_address }
    },
    source: 'reused',
    cleanup: null,
    reason: null,
    message: null,
    missing: [],
    candidates: []
  };
}

export async function ensure({ houseId, cityCode, cityName, houseType = 2, address }, ctx) {
  const existing = await resolve({ houseId, houseType }, ctx);
  if (existing.ok) return existing;

  if (ctx.mode !== 'execute') {
    return {
      ok: false,
      handle: null,
      source: null,
      cleanup: null,
      reason: 'house_missing_readonly',
      message: `房源缺失，只读模式不创建。需要插入 house_info: house_id=${houseId}, city_code=${cityCode}`,
      missing: ['house'],
      candidates: []
    };
  }

  await ctx.systems.execute(
    SYSTEM,
    `INSERT INTO house_info
      (house_id, house_type, standard_house_id, source_code, source_type,
       city_code, city_name, district_code, district_name, apartment_code,
       resblock_id, resblock, layout_code, building_id, building_name, floor,
       whole_house_code, room_name, flat_name, house_address, mtime, ctime)
     VALUES (?, ?, '', 'light', 3, ?, ?, 0, '', '', 0, ?, '', 0, '', 0, ?, '101', '', ?, NOW(), NOW())`,
    [String(houseId), houseType, cityCode, cityName || '', 'AI验证楼盘', String(houseId), address || `AI验证房源${houseId}`],
    ctx
  );

  ctx.ledger.record({
    capability: 'house',
    system: SYSTEM,
    key: String(houseId),
    kind: 'sql',
    payload: { sql: 'DELETE FROM house_info WHERE house_id = ? AND house_type = ?', params: [String(houseId), houseType] },
    description: `房源 house_id=${houseId}`
  });

  return {
    ok: true,
    handle: {
      type: 'house',
      id: String(houseId),
      key: String(houseId),
      meta: { houseType, cityCode: String(cityCode), cityName, address }
    },
    source: 'created',
    cleanup: { reversible: true, kind: 'sql', payload: 'DELETE FROM house_info WHERE house_id = ?' },
    reason: null,
    message: null,
    missing: [],
    candidates: []
  };
}

export async function reverse({ houseId, houseType = 2 }, ctx) {
  await ctx.systems.execute(
    SYSTEM,
    'DELETE FROM house_info WHERE house_id = ? AND house_type = ?',
    [String(houseId), houseType],
    ctx
  );
  return { ok: true };
}
