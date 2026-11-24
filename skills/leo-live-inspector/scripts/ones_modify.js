#!/usr/bin/env node

/**
 * 🛡️ Leo Live Inspector - ONES 研发管理平台写操作工具（两阶段确认）
 *
 * ⚠️ 安全铁律：
 *   1. 不带 --confirm 时只做 Pre-flight：查现状 → 组装 payload → 打印 Diff 预览，绝不落库；
 *   2. 只有用户明确确认后，才由 AI 追加 --confirm 真正提交，并自动回查验证；
 *   3. 任何日志 / 输出都不打印 Cookie 与 Token；
 *   4. 只操作当前登录人自己账号域内的数据；不提供批量删除。
 *
 * 子命令：
 *   create-req    新建需求
 *   create-bug    新建缺陷（可关联需求）
 *   schedule      调整需求排期（开发/测试/提测/上线时间）
 *   move          把需求移入指定迭代
 *   advance       状态机流转（评审/完成/取消…；删除属于高危，须 --confirm 且二次确认）
 */

import {
  buildRequirementPayload,
  buildBugPayload,
  createRequirement,
  createBug,
  updateSchedule,
  moveRequirementToIteration,
  changeStatus,
  getRequirementDetail,
  getBugDetail,
  getScheduleDetail,
  getIterationDetail,
  resolvePerson,
  resolveIteration,
  resolveProject,
  resolveLevel,
  resolveLevelShallow,
  buildSchedulePayload,
  buildBugHourPayload,
  saveBugHour,
  SCHEDULE_LABELS,
  diffFields,
  onesUrl,
  ONES_ORIGIN
} from './common/ones.js';

const HIGH_RISK_EVENTS = new Set(['删除', '需求取消', '取消']);

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`
};

function printHelp() {
  console.log(`
🛡️  Leo ONES 写操作工具（默认只出 Diff 预览，加 --confirm 才真正提交）

用法:
  node scripts/ones_modify.js <子命令> [参数...] [--confirm] [--json]

子命令 1: 新建需求
  node scripts/ones_modify.js create-req --title "标题" \\
      --level "惠居技术中心/惠居B端/惠居IoT/IoT系统" \\
      --project "惠居IoT项目" --pm 孙泽浩 --sprint IoT-2026-11-24 \\
      [--desc "描述"] [--type 产品需求] [--label 常规需求] [--priority P2] \\
      [--notest 不免测] [--safety-risk "无"] [--with-safety-func]

子命令 2: 新建缺陷
  node scripts/ones_modify.js create-bug --summary "缺陷标题" --resolver 孙泽浩 \\
      [--require-id 50564297] [--priority P0] [--type 测试阶段] \\
      [--find-way 手工测试] [--category 功能逻辑] [--desc "复现步骤"] \\
      [--man-hour 0.2] [--start "2026-11-25 00:00:00"] [--end "2026-11-25 23:59:59"]
      # --man-hour 会在缺陷创建成功后调用 /api/bug/save_hour 写入工时（缺陷的排期就是工时）

子命令 3: 调整排期
  node scripts/ones_modify.js schedule <需求ID> \\
      [--develop-start 2026-12-01 --develop-end 2026-12-05] \\
      [--test-start 2026-12-08 --test-end 2026-12-12] \\
      [--submit-test "2026-12-06 23:59:59"] [--online "2026-12-20 23:59:59"]

子命令 4: 移入迭代
  node scripts/ones_modify.js move <需求ID[,需求ID...]> --sprint <迭代ID|标题>

子命令 5: 状态流转（高危）
  node scripts/ones_modify.js advance <需求ID> --event 评审
  node scripts/ones_modify.js advance <需求ID> --event 删除      # 高危，需 --confirm

通用选项:
      --confirm        真正提交（不加则只展示 Diff 预览）
      --json           以 JSON 输出
      --cookie <str>   单次临时覆盖 Cookie（仅调试）

说明:
  * 新增需求时，ONES 强制「产研需求必须关联项目」，--project 必填（事务型需求除外）；
  * 排期接口只接受开发 / 测试 / 提测 / 上线时间，写库时不能带 estimatable 字段；
  * 缺陷的「排期」是它自身的工时（man_hour / start_time / end_time），走 /api/bug/save_hour；
  * 需求的人天估时（estimateCreate）未开放为独立命令，请用 create-req/schedule 或在 ONES 页面调整。
`);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    command: null,
    target: null,
    confirm: false,
    json: false,
    cookie: '',
    title: '',
    desc: '',
    level: '',
    project: '',
    pm: [],
    sprint: '',
    type: '',
    label: '',
    priority: '',
    notest: '',
    safetyRisk: '',
    withSafetyFunc: false,
    requirementUrl: '',
    summary: '',
    resolver: '',
    findWay: '',
    category: '',
    requireId: '',
    developStart: '',
    developEnd: '',
    testStart: '',
    testEnd: '',
    submitTest: '',
    online: '',
    event: '',
    help: false
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--cookie') options.cookie = next();
    else if (arg === '--title') options.title = next();
    else if (arg === '--desc' || arg === '--description') options.desc = next();
    else if (arg === '--level') options.level = next();
    else if (arg === '--project') options.project = next();
    else if (arg === '--pm') options.pm.push(next());
    else if (arg === '--sprint' || arg === '--iteration') options.sprint = next();
    else if (arg === '--type') options.type = next();
    else if (arg === '--label') options.label = next();
    else if (arg === '--priority') options.priority = next();
    else if (arg === '--notest') options.notest = next();
    else if (arg === '--safety-risk') options.safetyRisk = next();
    else if (arg === '--with-safety-func') options.withSafetyFunc = true;
    else if (arg === '--requirement-url' || arg === '--req-url') options.requirementUrl = next();
    else if (arg === '--summary') options.summary = next();
    else if (arg === '--resolver') options.resolver = next();
    else if (arg === '--find-way') options.findWay = next();
    else if (arg === '--category') options.category = next();
    else if (arg === '--require-id') options.requireId = next();
    else if (arg === '--man-hour' || arg === '--hours') options.manHour = next();
    else if (arg === '--start') options.start = next();
    else if (arg === '--end') options.end = next();
    else if (arg === '--develop-start') options.developStart = next();
    else if (arg === '--develop-end') options.developEnd = next();
    else if (arg === '--test-start') options.testStart = next();
    else if (arg === '--test-end') options.testEnd = next();
    else if (arg === '--submit-test') options.submitTest = next();
    else if (arg === '--online') options.online = next();
    else if (arg === '--event') options.event = next();
    else if (arg === '--kind') options.kind = next();
    else if (!arg.startsWith('-')) positionals.push(arg);
  }
  if (positionals.length) options.command = positionals.shift();
  if (positionals.length) options.target = positionals.shift();
  return options;
}

// ------------------------------------------------------------------ Diff 渲染

function renderDiffTable(rows, { beforeTitle = '变更前', afterTitle = '变更后' } = {}) {
  const pad = (s, n) => {
    const str = String(s ?? '');
    const w = [...str].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    return str + ' '.repeat(Math.max(0, n - w));
  };
  const headers = ['字段', beforeTitle, afterTitle];
  const data = rows.map(r => [r.label, r.before || '（空）', r.after || '（空）']);
  const widths = headers.map((h, i) => Math.max(
    [...h].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0),
    ...data.map(r => [...String(r[i] ?? '')].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0))
  ));
  const line = arr => '  ' + arr.map((c, i) => pad(c, widths[i])).join('  ');
  const out = [line(headers), '  ' + widths.map(w => '-'.repeat(w)).join('  ')];
  for (let i = 0; i < rows.length; i++) {
    out.push((rows[i].changed ? C.yellow('● ') : '  ') + line(data[i]).trimStart());
  }
  return out.join('\n');
}

function renderPayload(payload) {
  return Object.entries(payload)
    .map(([k, v]) => `   ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

function confirmHint() {
  console.log(`\n${C.yellow('🔒 以上为 Dry-Run 预览，数据尚未写入。')}`);
  console.log(`   ${C.bold('确认无误后，在命令末尾追加 --confirm 才会真正提交。')}`);
}

function successBanner(text) {
  console.log(`\n${C.green('✅ ' + text)}`);
}

// ---------------------------------------------------------------- 子命令实现

async function cmdCreateReq(opts) {
  const level = opts.level
    ? await resolveLevel(Object.assign(
      { cookie: opts.cookie },
      (() => {
        const p = opts.level.split('/').map(s => s.trim()).filter(Boolean);
        if (p.length !== 4) throw new Error('--level 需要 4 段：业务方向/业务线/系统/子系统');
        return { direction: p[0], line: p[1], system: p[2], subSystem: p[3] };
      })()
    ))
    : {};

  const pm = [];
  for (const raw of opts.pm.length ? opts.pm : ['']) {
    if (!raw) continue;
    pm.push(await resolvePerson(raw, { cookie: opts.cookie }));
  }

  let sprintId = '';
  let sprintTitle = '';
  if (opts.sprint) {
    const iter = await resolveIteration(opts.sprint, { cookie: opts.cookie });
    sprintId = iter.id;
    sprintTitle = iter.title;
  }

  let project = null;
  if (opts.project) project = await resolveProject(opts.project, { level, cookie: opts.cookie });

  const payload = await buildRequirementPayload({
    title: opts.title,
    desc: opts.desc,
    requireType: opts.type || '产品需求',
    requireLabel: opts.label || '常规需求',
    priority: opts.priority || 'P2',
    level,
    pm,
    project,
    sprintId,
    notest: opts.notest || '不免测',
    safetyRisk: opts.safetyRisk ? opts.safetyRisk.split(',').map(s => s.trim()).filter(Boolean) : ['无'],
    safetyRiskFunctions: opts.withSafetyFunc ? ['不包含以上业务功能'] : [],
    requirementUrl: opts.requirementUrl
  });

  const preview = {
    title: payload.title,
    level: level.business_direction_id ? `${opts.level.split('/').map(s => s.trim()).join(' / ')}` : '（未指定）',
    project: project ? `${project.title} (${project.mProjectId})` : '（未指定）',
    iteration: sprintId ? `${sprintTitle} (${sprintId})` : '需求池',
    pm: pm.join('、'),
    type: `${payload.require_type} / ${payload.require_label}`,
    priority: payload.priority,
    notest: payload.notest,
    safetyRisk: payload.safety_risk.join('、'),
    safetyRiskFunctions: payload.safety_risk_functions.join('、') || '（未设置）',
    desc: payload.desc === '<p></p>' ? '（空）' : String(opts.desc).slice(0, 80)
  };

  if (opts.json && !opts.confirm) {
    console.log(JSON.stringify({ ok: true, dryRun: true, command: 'create-req', payload, preview }, null, 2));
    return;
  }

  console.log(`\n${C.bold('📝 新建需求 · 预审单')}`);
  console.log(`────────────────────────────────────────────────────────────`);
  for (const [k, v] of Object.entries(preview)) console.log(`   ${k}: ${v}`);
  console.log(`\n${C.dim('   提交 payload:')}`);
  console.log(renderPayload(payload));

  if (!opts.confirm) {
    confirmHint();
    return;
  }

  const created = await createRequirement(payload, { cookie: opts.cookie });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: false, command: 'create-req', created }, null, 2));
    return;
  }
  successBanner(`需求已创建: ${created.url || created.id}`);

  // 回查验证
  try {
    const check = await getRequirementDetail(created.id, { cookie: opts.cookie });
    console.log(`\n${C.bold('🔎 回查验证')}`);
    console.log(`   ID: ${check.id}`);
    console.log(`   标题: ${check.title}`);
    console.log(`   状态: ${check.status}   迭代: ${check.sprintTitle}   优先级: ${check.priority}`);
    console.log(`   链接: ${check.url}`);
  } catch (err) {
    console.log(`\n${C.yellow('⚠️ 创建成功但回查失败：' + err.message)}`);
  }
}

async function cmdCreateBug(opts) {
  const resolver = opts.resolver ? await resolvePerson(opts.resolver, { cookie: opts.cookie }) : '';

  const requireId = opts.requireId || (opts.target && /^\d+$/.test(opts.target) ? opts.target : '');
  let requireTitle = '';
  let reqLevel = null;
  let reqLevelLabel = '';
  if (requireId) {
    try {
      const req = await getRequirementDetail(requireId, { cookie: opts.cookie });
      requireTitle = req.title;
      const ids = req?.level?.ids;
      if (ids?.businessDirection && ids?.businessLine) {
        reqLevel = {
          business_direction_id: ids.businessDirection,
          business_line_id: ids.businessLine,
          ...(ids.system ? { system_id: ids.system } : {}),
          ...(ids.subSystem ? { sub_system_id: ids.subSystem } : {})
        };
        reqLevelLabel = [req.level.businessDirection, req.level.businessLine, req.level.system, req.level.subSystem]
          .filter(Boolean).join(' / ');
      }
    } catch (err) {
      throw new Error(`关联需求 ${requireId} 读取失败：${err.message}`);
    }
  }

  // 缺陷同样强制业务层级（saveBug 缺 business_direction_id/business_line_id 会报 30001）
  let level = null;
  let levelLabel = '';
  if (opts.level) {
    const p = opts.level.split('/').map(s => s.trim()).filter(Boolean);
    if (p.length < 2) throw new Error('--level 至少 2 段：业务方向/业务线（可写全 4 段：业务方向/业务线/系统/子系统）');
    const parts = { direction: p[0], line: p[1], system: p[2] || '', subSystem: p[3] || '' };
    level = p.length >= 4
      ? await resolveLevel({ ...parts, cookie: opts.cookie })
      : await resolveLevelShallow(parts, { cookie: opts.cookie });
    levelLabel = opts.level;
  } else if (reqLevel) {
    level = reqLevel;
    levelLabel = `${reqLevelLabel || '关联需求层级'}（继承自需求 ${requireId}）`;
  } else {
    // 未指定且未从关联需求继承时取默认层级（惠居技术中心/惠居B端/惠居IoT/IoT系统）
    level = await resolveLevel({
      direction: '惠居技术中心', line: '惠居B端', system: '惠居IoT', subSystem: 'IoT系统', cookie: opts.cookie
    });
    levelLabel = '惠居技术中心 / 惠居B端 / 惠居IoT / IoT系统（默认）';
  }
  const payload = await buildBugPayload({
    summary: opts.summary || (opts.target && !/^\d+$/.test(opts.target) ? opts.target : ''),
    priority: opts.priority || 'P2',
    bugType: opts.type || '测试阶段',
    findWay: opts.findWay || '手工测试',
    resolver,
    requireId,
    category: opts.category || '功能逻辑',
    level,
    desc: opts.desc
  });

  const preview = {
    summary: payload.summary,
    priority: payload.priority,
    type: `${payload.bug_type} / ${payload.category || '—'}`,
    findWay: payload.find_way,
    resolver: payload.resolver,
    level: levelLabel,
    require: requireId ? `${requireTitle} (${requireId})` : '（不关联需求）',
    desc: payload.desc ? String(payload.desc).slice(0, 80) : '（空）'
  };

  // 工时（排期）：缺陷的工时是独立接口 save_hour，创建成功后才能写
  let hourPayload = null;
  if (opts.manHour !== undefined && opts.manHour !== '') {
    const end = opts.end || todayEnd();
    const built = buildBugHourPayload(0, { manHours: opts.manHour, start: opts.start, end });
    hourPayload = built.payload;
    preview['工时(天)'] = `${built.changes.manHour}  起止 ${built.changes.start || '（沿用缺陷当前）'} ~ ${built.changes.end}`;
  }

  if (opts.json && !opts.confirm) {
    console.log(JSON.stringify({ ok: true, dryRun: true, command: 'create-bug', payload, hourPayload, preview }, null, 2));
    return;
  }

  console.log(`\n${C.bold('🐞 新建缺陷 · 预审单')}`);
  console.log(`────────────────────────────────────────────────────────────`);
  for (const [k, v] of Object.entries(preview)) console.log(`   ${k}: ${v}`);
  console.log(`\n${C.dim('   提交 payload:')}`);
  console.log(renderPayload(payload));
  if (hourPayload) {
    console.log(`\n${C.dim('   创建后追加写入工时（/api/bug/save_hour）:')}`);
    console.log(renderPayload({ ...hourPayload, id: '<新建缺陷ID>' }));
  }

  if (!opts.confirm) {
    confirmHint();
    return;
  }

  const created = await createBug(payload, { cookie: opts.cookie });
  let hourResult = null;
  if (hourPayload && created.id) {
    try {
      const r = await saveBugHour({ ...hourPayload, id: created.id }, { cookie: opts.cookie });
      hourResult = { ok: r.ok, manHour: hourPayload.man_hour, start: hourPayload.start_time || '', end: hourPayload.end_time };
    } catch (err) {
      hourResult = { ok: false, error: err.message };
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: false, command: 'create-bug', created, hour: hourResult }, null, 2));
    return;
  }
  successBanner(`缺陷已创建: ${created.url || created.id}`);
  if (hourResult) {
    if (hourResult.ok) {
      console.log(`\n${C.green(`⏱️  已写入工时 ${hourResult.manHour} 天（${hourResult.start || '沿用当前'} ~ ${hourResult.end}）`)}`);
    } else {
      console.log(`\n${C.yellow(`⚠️  缺陷已创建，但工时写入失败：${hourResult.error || '服务端返回 false'}`)}`);
      console.log(C.dim(`   可通过 ${onesUrl('bug', created.id)} 在页面手工补工时。`));
    }
  }
}

/** 默认完成时间：今天 23:59:59（与 ONES 页面「提测」默认一致） */
function todayEnd() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 23:59:59`;
}

async function cmdSchedule(opts) {
  const requireId = opts.target;
  if (!requireId || !/^\d+$/.test(String(requireId))) throw new Error('schedule 需要需求 ID，例如 schedule 50564297 --online "2026-12-20 23:59:59"');

  const before = await getScheduleDetail(requireId, { cookie: opts.cookie });
  const detail = await getRequirementDetail(requireId, { cookie: opts.cookie });
  const changes = {};
  const map = {
    developStart: opts.developStart,
    developEnd: opts.developEnd,
    testStart: opts.testStart,
    testEnd: opts.testEnd,
    submitTest: opts.submitTest,
    online: opts.online
  };
  for (const [k, v] of Object.entries(map)) if (v) changes[k] = v;
  const { payload, changes: filled } = buildSchedulePayload(requireId, changes);

  // 变更前快照
  const beforeByKey = {
    developStart: before?.developStart || '',
    developEnd: before?.developEnd || '',
    testStart: before?.testStart || '',
    testEnd: before?.testEnd || '',
    submitTest: before?.submitTest || '',
    online: before?.online || ''
  };
  const rows = diffFields(beforeByKey, { ...beforeByKey, ...filled }, SCHEDULE_LABELS);

  if (opts.json && !opts.confirm) {
    console.log(JSON.stringify({
      ok: true, dryRun: true, command: 'schedule',
      requirement: { id: detail.id, title: detail.title, status: detail.status, iteration: detail.sprintTitle },
      diff: rows.filter(r => r.changed),
      payload
    }, null, 2));
    return;
  }

  console.log(`\n${C.bold('🗓️ 调整排期 · 预审单')}`);
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`   需求: ${detail.id}  ${detail.title}`);
  console.log(`   状态: ${detail.status}   迭代: ${detail.sprintTitle}   链接: ${detail.url}`);
  if (['已上线', '已完成'].includes(detail.status)) {
    console.log(`${C.red('   ⚠️ 该需求已上线/已完成，ONES 会拒绝排期变更（「已上线需求不可排期」）。')}`);
  }
  if (detail.estimatable !== 1) {
    console.log(`${C.yellow('   ⚠️ 该需求当前不可估时（estimatable=' + detail.estimatable + '），排期接口可能拒绝。')}`);
  }
  console.log(`\n${C.bold('   字段 Diff：')}`);
  console.log(renderDiffTable(rows));
  console.log(`\n${C.dim('   提交 payload:')}`);
  console.log(renderPayload(payload));

  if (!opts.confirm) {
    confirmHint();
    return;
  }

  const result = await updateSchedule(requireId, changes, { cookie: opts.cookie });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: false, command: 'schedule', result }, null, 2));
    return;
  }
  successBanner('排期已提交');

  try {
    const after = await getScheduleDetail(requireId, { cookie: opts.cookie });
    const afterMap = {
      developStart: after?.developStart || '',
      developEnd: after?.developEnd || '',
      testStart: after?.testStart || '',
      testEnd: after?.testEnd || '',
      submitTest: after?.submitTest || '',
      online: after?.online || ''
    };
    console.log(`\n${C.bold('🔎 回查验证')}`);
    console.log(renderDiffTable(diffFields(beforeByKey, afterMap, SCHEDULE_LABELS), { beforeTitle: '改前', afterTitle: '改后' }));
  } catch (err) {
    console.log(`\n${C.yellow('⚠️ 提交成功但回查失败：' + err.message)}`);
  }
}

async function cmdMove(opts) {
  const ids = String(opts.target || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('move 需要需求 ID（多个用逗号分隔）');
  if (!opts.sprint) throw new Error('move 需要 --sprint <迭代ID|标题>');
  ids.forEach(id => {
    if (!/^\d+$/.test(id)) throw new Error(`需求 ID 必须为数字：${id}`);
  });

  const iter = await resolveIteration(opts.sprint, { cookie: opts.cookie });
  const details = [];
  for (const id of ids) {
    try {
      const d = await getRequirementDetail(id, { cookie: opts.cookie });
      details.push(d);
    } catch (err) {
      throw new Error(`需求 ${id} 读取失败：${err.message}`);
    }
  }

  if (opts.json && !opts.confirm) {
    console.log(JSON.stringify({
      ok: true, dryRun: true, command: 'move',
      target: { sprintId: iter.id, sprintTitle: iter.title, begin: iter.begin, end: iter.end },
      requirements: details.map(d => ({ id: d.id, title: d.title, status: d.status, currentIteration: d.sprintTitle }))
    }, null, 2));
    return;
  }

  console.log(`\n${C.bold('🔁 移入迭代 · 预审单')}`);
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`   目标迭代: ${iter.title} (${iter.id})  ${iter.begin || ''} ~ ${iter.end || ''}`);
  console.log(`\n   需求与当前迭代：`);
  details.forEach(d => console.log(`   ${d.id}  ${d.sprintTitle} → ${iter.title}   ${d.status}  ${String(d.title).slice(0, 40)}`));

  if (!opts.confirm) {
    confirmHint();
    return;
  }

  const result = await moveRequirementToIteration(ids, iter.id, { cookie: opts.cookie });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: false, command: 'move', result }, null, 2));
    return;
  }
  successBanner(`已把 ${ids.length} 个需求移入 ${iter.title}`);

  console.log(`\n${C.bold('🔎 回查验证')}`);
  for (const id of ids) {
    try {
      const d = await getRequirementDetail(id, { cookie: opts.cookie });
      console.log(`   ${d.id} → ${d.sprintTitle}   ${d.status}`);
    } catch (err) {
      console.log(`   ${id} 回查失败：${err.message}`);
    }
  }
}

async function cmdAdvance(opts) {
  const id = opts.target;
  if (!id || !/^\d+$/.test(String(id))) throw new Error('advance 需要需求/缺陷 ID');
  if (!opts.event) throw new Error('advance 需要 --event（如 评审 / 完成 / 需求取消 / 删除）');

  const isBug = opts.kind === 'bug';
  const detail = isBug
    ? await getBugDetail(id, { cookie: opts.cookie })
    : await getRequirementDetail(id, { cookie: opts.cookie });
  const transition = (detail.transitions || []).find(t => t.event === opts.event);
  if (!transition) {
    const avail = (detail.transitions || []).map(t => t.event).join('、') || '（当前无可用事件）';
    throw new Error(`${isBug ? '缺陷' : '需求'} ${id}（状态 ${detail.status}）不支持事件「${opts.event}」。当前可用：${avail}`);
  }

  const highRisk = HIGH_RISK_EVENTS.has(opts.event);
  const kindLabel = isBug ? '缺陷' : '需求';

  if (opts.json && !opts.confirm) {
    console.log(JSON.stringify({
      ok: true, dryRun: true, command: 'advance', type: isBug ? 'bug' : 'requirement',
      entity: { id: detail.id, title: detail.summary || detail.title, status: detail.status },
      transition: { event: opts.event, from: detail.status, to: transition.target },
      highRisk
    }, null, 2));
    return;
  }

  console.log(`\n${highRisk ? C.red(C.bold('🚨 高危操作预审（删除 / 取消）')) : C.bold('🔀 状态流转 · 预审单')}`);
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`   ${kindLabel}: ${detail.id}  ${detail.summary || detail.title}`);
  console.log(`   状态: ${detail.status}  →  ${transition.target}（事件「${opts.event}」）`);
  if (isBug && detail.manHour !== undefined) console.log(`   工时: ${detail.manHour} 天`);
  console.log(`   链接: ${detail.url}`);

  if (!opts.confirm) {
    confirmHint();
    return;
  }

  const result = await changeStatus({
    type: isBug ? 'bug' : 'requirement', id, event: opts.event, cookie: opts.cookie
  });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: false, command: 'advance', result }, null, 2));
    return;
  }
  successBanner(`${kindLabel}状态已流转：${detail.status} → ${transition.target}`);

  try {
    const after = isBug
      ? await getBugDetail(id, { cookie: opts.cookie }).catch(() => null)
      : await getRequirementDetail(id, { cookie: opts.cookie }).catch(() => null);
    if (after) console.log(`\n   回查状态: ${after.status}`);
    else if (opts.event === '删除') console.log(`\n   ${C.dim('回查：对象已不可见（删除生效）')}`);
  } catch { /* 删除后查不到属正常 */ }
}

const COMMANDS = {
  'create-req': cmdCreateReq,
  'create-requirement': cmdCreateReq,
  'create-bug': cmdCreateBug,
  schedule: cmdSchedule,
  move: cmdMove,
  advance: cmdAdvance
};

async function main() {
  const opts = parseArgs();
  if (opts.help || !opts.command) {
    printHelp();
    if (!opts.command && !opts.help) process.exitCode = 1;
    return;
  }
  const handler = COMMANDS[opts.command];
  if (!handler) {
    console.error(`未知子命令: ${opts.command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  await handler(opts);
}

if (process.argv[1] && process.argv[1].endsWith('ones_modify.js')) {
  main().catch(err => {
    if (process.argv.includes('--json')) {
      console.error(JSON.stringify({ ok: false, error: err.message, code: err.code ?? null }, null, 2));
    } else {
      console.error(`\n❌ ${err.message}\n`);
    }
    process.exit(1);
  });
}
