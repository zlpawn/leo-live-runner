#!/usr/bin/env node
/**
 * 场景运行入口
 *
 * 用法：
 *   node scripts/run.js --list
 *   node scripts/run.js sms-task1-auto-install                    # 只读体检
 *   node scripts/run.js sms-task1-auto-install --execute          # 完整执行
 *   node scripts/run.js sms-task1-auto-install --execute --cleanup
 *   node scripts/run.js sms-task1-auto-install --log-file /tmp/app.log
 *
 * 选项：
 *   --execute        执行写操作（默认只读）
 *   --cleanup        执行清理（默认 dry-run）
 *   --log-file <p>   本地日志文件路径（断言用）
 *   --test-app <n>   测试环境应用名（断言用，需 leo-live-inspector）
 *   --city <code>    限定城市
 *   --order-type <t> Task 3: INS | REPAIR
 *   --push-enabled   期望 Push 分支（默认 true）
 *   --push-disabled  期望短信兜底分支
 *   --expect <mode>  Task 4: normal | rotate | failopen | skip
 *   --city-open      Task 5: 期望城市已开城
 */
import { runScenario } from './scenarios/runner.js';
import { getScenario, listScenarios } from './scenarios/index.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--execute') args.execute = true;
    else if (a === '--cleanup') args.cleanup = true;
    else if (a === '--push-enabled') args.pushEnabled = true;
    else if (a === '--push-disabled') args.pushEnabled = false;
    else if (a === '--city-open') args.cityOpen = true;
    else if (a === '--log-file') args.logFile = argv[++i];
    else if (a === '--test-app') args.testApp = argv[++i];
    else if (a === '--city') args.cityCode = argv[++i];
    else if (a === '--order-type') args.orderType = argv[++i];
    else if (a === '--expect') args.expect = argv[++i];
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a.startsWith('--')) { /* ignore unknown */ }
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list || args._.length === 0) {
    console.log('可用场景：\n');
    for (const s of listScenarios()) {
      console.log(`  ${s.name}`);
      console.log(`    ${s.description}`);
      if (s.switchKey) console.log(`    开关: ${s.switchKey}`);
      console.log();
    }
    console.log('用法: node scripts/run.js <场景名> [--execute] [--cleanup] [--log-file <path>]');
    return;
  }

  const name = args._[0];
  const scenario = getScenario(name);
  const report = await runScenario(scenario, {
    mode: args.execute ? 'execute' : 'readonly',
    cleanup: args.cleanup,
    logger: console,
    // 传给各阶段
    pushEnabled: args.pushEnabled,
    cityCode: args.cityCode,
    orderType: args.orderType,
    expect: args.expect,
    cityOpen: args.cityOpen,
    logFile: args.logFile,
    testApp: args.testApp,
    waitMs: args.waitMs
  });

  process.exitCode = report.status === 'ok' ? 0 : 1;
}

main().catch(e => { console.error('\n运行失败:', e.message); process.exitCode = 1; });
