/**
 * 造数账本：记录每条 created 数据的反向操作，供 cleanup 使用。
 * reused 的数据绝不记账——那是别人的数据，不能删。
 */
export class Ledger {
  constructor() {
    this.entries = [];
  }

  record({ capability, system, key, kind = 'sql', payload, description }) {
    this.entries.push({
      capability,
      system,
      key,
      kind,
      payload,
      description,
      createdAt: new Date().toISOString()
    });
  }

  list() {
    return [...this.entries];
  }

  /**
   * 按依赖逆序返回（先创建的后清理）
   */
  reverseOrder() {
    return [...this.entries].reverse();
  }

  /**
   * 执行清理
   */
  async cleanup(ctx, { dryRun = true } = {}) {
    const results = [];
    for (const entry of this.reverseOrder()) {
      if (entry.kind === 'none') {
        results.push({ ...entry, status: 'skipped', reason: '不可逆操作，需人工处理' });
        continue;
      }
      if (dryRun) {
        results.push({ ...entry, status: 'planned' });
        continue;
      }
      try {
        if (entry.kind === 'sql') {
          await ctx.systems.execute(entry.system, entry.payload.sql, entry.payload.params, ctx);
        }
        results.push({ ...entry, status: 'done' });
      } catch (e) {
        results.push({ ...entry, status: 'failed', error: e.message });
      }
    }
    return results;
  }

  summary() {
    const byCapability = {};
    for (const e of this.entries) {
      byCapability[e.capability] = (byCapability[e.capability] || 0) + 1;
    }
    return { total: this.entries.length, byCapability };
  }
}
