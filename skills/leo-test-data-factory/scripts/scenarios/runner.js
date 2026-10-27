/**
 * 场景运行器：统一编排 precheck → seed → trigger → assert → cleanup
 *
 * 设计原则：
 * - readonly 模式只跑到 precheck，输出体检报告
 * - execute 模式跑完整流程，任一环节失败即停止并输出断点
 * - cleanup 默认 dry-run，需显式 --cleanup 才真正执行
 */
import { createContext } from '../common/systems.js';

const STAGES = ['precheck', 'seed', 'trigger', 'assert', 'cleanup'];

export async function runScenario(scenario, options = {}) {
  const { mode = 'readonly', cleanup = false, logger = console } = options;
  const stageOpts = { ...options };
  delete stageOpts.mode; delete stageOpts.cleanup; delete stageOpts.logger;
  const ctx = createContext({ mode, logger });
  const report = { scenario: scenario.name, mode, stages: [], startedAt: new Date().toISOString() };

  const log = (msg) => logger.log(msg);

  try {
    log(`\n=== 场景: ${scenario.name} ===`);
    log(`模式: ${mode}${cleanup ? ' + cleanup' : ''}\n`);

    let carry = null;   // 阶段间传递的上下文

    for (const stage of STAGES) {
      if (typeof scenario[stage] !== 'function') continue;

      // readonly 模式下，trigger/assert/cleanup 不执行
      if (mode === 'readonly' && (stage === 'trigger' || stage === 'assert' || stage === 'cleanup')) {
        report.stages.push({ stage, status: 'skipped', reason: 'readonly 模式' });
        log(`[${stage}] ⏭  跳过（readonly 模式）`);
        continue;
      }
      // cleanup 默认 dry-run
      if (stage === 'cleanup' && !cleanup) {
        report.stages.push({ stage, status: 'skipped', reason: '未指定 --cleanup' });
        log(`[${stage}] ⏭  跳过（未指定 --cleanup）`);
        continue;
      }

      log(`[${stage}] 执行中...`);
      const result = await scenario[stage](ctx, carry, stageOpts);
      report.stages.push({ stage, status: 'ok', result });
      log(formatStageResult(stage, result));

      // precheck 的 context 传给后续阶段
      if (stage === 'precheck' && result?.context) carry = result;
      // seed 产出的 handle 合并进 context（如 orderCode）
      if (stage === 'seed' && result?.handle) {
        carry = {
          ...(carry || {}),
          context: { ...(carry?.context || {}), ...result.handle, order: result.handle }
        };
      }
      if (stage === 'trigger' && result?.handle) carry = { ...carry, context: result.handle };

      // precheck / seed / trigger 失败则中断
      // 只读模式：precheck 失败只警告，不中断（体检报告本身就是这个目的）
      if (mode === 'readonly' && stage === 'precheck' && result?.ok === false) {
        log(`  ℹ️  体检完成：${result.missing?.length || 0} 项待补齐（execute 模式会自动创建）`);
        report.status = 'ok';
        return report;
      }
      // precheck 失败但缺失项可补齐时，继续进 seed
      if (stage === 'precheck' && result?.ok === false && result?.canProceed === false) {
        const fixable = new Set(['house', 'lock', 'installOrder', 'managerTask', 'managerTaskRelation']);
        const blocking = (result.missing || []).filter(m => !fixable.has(m));
        if (blocking.length === 0) {
          log(`  ℹ️  缺失项可在 seed 阶段补齐，继续`);
        } else {
          report.status = 'failed';
          report.failedAt = stage;
          log(`\n❌ 缺少无法自动补齐的前置: ${blocking.join(', ')}`);
          return report;
        }
      }
      if ((stage === 'precheck' || stage === 'seed' || stage === 'trigger')
          && result && result.ok === false && result.reason !== 'readonly'
          && !(stage === 'precheck' && (result.missing || []).every(m => ['house','lock','installOrder','managerTask','managerTaskRelation'].includes(m)))) {
        report.status = 'failed';
        report.failedAt = stage;
        log(`\n❌ 在 ${stage} 阶段失败，流程中断`);
        return report;
      }
    }

    report.status = 'ok';
    log(`\n✅ 场景完成`);
    return report;
  } finally {
    await ctx.systems.closeAll();
    report.finishedAt = new Date().toISOString();
    report.ledger = ctx.ledger.summary();
  }
}

function formatStageResult(stage, r) {
  if (!r) return '';
  // precheck 有自己的格式化（即使 ok=false 也要列出检查项）
  if (stage === 'precheck') return formatPrecheck(r);
  if (r.ok === false) {
    return `  ❌ [${r.reason || 'failed'}] ${r.message || ''}`;
  }
  switch (stage) {
    case 'seed':
      return `  ✅ ${r.source === 'created' ? '已创建' : '已复用'}${r.handle?.key ? ': ' + r.handle.key : ''}`;
    case 'trigger':
      return `  ✅ 已触发${r.detail ? ': ' + r.detail : ''}`;
    case 'assert':
      return formatAssert(r);
    case 'cleanup':
      return formatCleanup(r);
    default:
      return `  ✅`;
  }
}

function formatPrecheck(r) {
  const lines = [];
  if (r.checks) {
    for (const c of r.checks) {
      lines.push(`  ${c.ok ? '✅' : '⚠️ '} ${c.name}: ${c.detail || ''}`);
    }
  }
  if (r.missing?.length) {
    lines.push(`  待补齐: ${r.missing.join(', ')}（execute 模式会自动创建）`);
  }
  if (r.canProceed === false) {
    lines.push(`  ⚠️  前置未齐备`);
  } else {
    lines.push(`  ✅ 前置检查通过`);
  }
  return lines.join('\n');
}

function formatAssert(r) {
  const lines = [];
  if (r.evidence) {
    for (const e of r.evidence) {
      const icon = e.skipped ? '⏭ ' : (e.ok ? '✅' : '❌');
      lines.push(`  ${icon} ${e.name}: ${e.detail || ''}`);
    }
  }
  lines.push(`  ${r.ok ? '✅ 断言通过' : '❌ 断言未通过'}`);
  return lines.join('\n');
}

function formatCleanup(r) {
  const lines = [];
  if (r.planned?.length) {
    lines.push(`  计划清理 ${r.planned.length} 项（dry-run）`);
  }
  if (r.done?.length) {
    lines.push(`  已清理 ${r.done.length} 项`);
  }
  return lines.join('\n');
}
