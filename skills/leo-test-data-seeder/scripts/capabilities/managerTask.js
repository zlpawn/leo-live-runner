/**
 * managerTask 任务处理人 —— 可造
 * 载体：manager_workbench 库（manager_task + task_relation）
 *
 * 致命陷阱：manager_task.upstream_code 必须是【收房合同号】(biz_type=1)，
 * 用出房合同号查不到。查询还需 task_type=4（门锁）、biz_type=1（签约）。
 */
const SYSTEM = 'manager-workbench';

export async function resolve({ contractCode, taskType = 4, bizType = 1 }, ctx) {
  const tasks = await ctx.systems.query(
    SYSTEM,
    `SELECT id, task_id, contract_code, contract_type, biz_type, task_type,
            upstream_code, house_code, city_code, status
       FROM manager_task
      WHERE upstream_code = ? AND task_type = ? AND biz_type = ?
      ORDER BY ctime DESC LIMIT 1`,
    [contractCode, taskType, bizType]
  );

  if (!tasks.length) {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'manager_task_not_found',
      message: `合同 ${contractCode} 无门锁签约任务（task_type=4, biz_type=1）。注意 upstream_code 必须是收房合同号`,
      missing: ['managerTask'],
      candidates: []
    };
  }
  const task = tasks[0];

  const relations = await ctx.systems.query(
    SYSTEM,
    'SELECT id, task_id, deal_user_id, deal_user_name, role FROM task_relation WHERE task_id = ? AND is_delete = 0',
    [task.task_id]
  );

  if (!relations.length) {
    return {
      ok: false,
      handle: {
        type: 'managerTask',
        id: task.task_id,
        key: task.task_id,
        meta: { contractCode: task.contract_code, houseId: String(task.house_code), cityCode: String(task.city_code) }
      },
      source: null,
      cleanup: null,
      reason: 'task_relation_empty',
      message: `任务 ${task.task_id} 存在但没有处理人（task_relation 为空）`,
      missing: ['managerTaskRelation'],
      candidates: []
    };
  }

  return {
    ok: true,
    handle: {
      type: 'managerTask',
      id: task.task_id,
      key: task.task_id,
      meta: {
        contractCode: task.contract_code,
        houseId: String(task.house_code),
        cityCode: String(task.city_code),
        dealUsers: relations.map(r => ({
          dealUserId: r.deal_user_id,
          dealUserName: r.deal_user_name,
          role: r.role
        }))
      }
    },
    source: 'reused',
    cleanup: null,
    reason: null, message: null, missing: [], candidates: []
  };
}

export async function ensure({ contractCode, taskType = 4, bizType = 1, houseCode, cityCode, dealUsers }, ctx) {
  const existing = await resolve({ contractCode, taskType, bizType }, ctx);
  if (existing.ok) return existing;

  if (ctx.mode !== 'execute') {
    return {
      ok: false, handle: null, source: null, cleanup: null,
      reason: 'manager_task_missing_readonly',
      message: `合同 ${contractCode} 无门锁签约任务或处理人，只读模式不创建`,
      missing: ['managerTask'],
      candidates: []
    };
  }

  const taskId = existing.handle?.id || `AI${Date.now()}`;
  const createdTask = !existing.handle;

  if (createdTask) {
    await ctx.systems.execute(
      SYSTEM,
      `INSERT INTO manager_task
         (task_id, contract_code, contract_type, biz_type, task_type,
          upstream_code, house_code, city_code, status, ctime, mtime)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 2, NOW(), NOW())`,
      [taskId, contractCode, bizType, taskType, contractCode, String(houseCode), String(cityCode)],
      ctx
    );
    ctx.ledger.record({
      capability: 'managerTask',
      system: SYSTEM,
      key: taskId,
      kind: 'sql',
      payload: { sql: 'DELETE FROM manager_task WHERE task_id = ?', params: [taskId] },
      description: `管家任务 task_id=${taskId}`
    });
  }

  const relationIds = [];
  for (const u of dealUsers || []) {
    const r = await ctx.systems.execute(
      SYSTEM,
      `INSERT INTO task_relation (task_id, deal_user_id, deal_user_name, role, is_reassign, is_delete, ctime, mtime)
       VALUES (?, ?, ?, ?, 0, 0, NOW(), NOW())`,
      [taskId, u.dealUserId, u.dealUserName, u.role],
      ctx
    );
    relationIds.push(r.insertId);
  }

  if (relationIds.length) {
    ctx.ledger.record({
      capability: 'managerTask',
      system: SYSTEM,
      key: `${taskId}:relations`,
      kind: 'sql',
      payload: {
        sql: `DELETE FROM task_relation WHERE id IN (${relationIds.map(() => '?').join(',')})`,
        params: relationIds
      },
      description: `任务处理人 ${relationIds.length} 条`
    });
  }

  return resolve({ contractCode, taskType, bizType }, ctx);
}

export async function reverse({ taskId, relationIds = [] }, ctx) {
  if (relationIds.length) {
    await ctx.systems.execute(
      SYSTEM,
      `DELETE FROM task_relation WHERE id IN (${relationIds.map(() => '?').join(',')})`,
      relationIds,
      ctx
    );
  }
  await ctx.systems.execute(SYSTEM, 'DELETE FROM manager_task WHERE task_id = ?', [taskId], ctx);
  return { ok: true };
}
