#!/usr/bin/env node

/**
 * 🗂️ Leo Live Inspector - ONES 研发管理平台只读探查引擎
 *
 * 覆盖能力：
 *   1. me                       当前登录人画像（工号 / 邮箱 / 组织 / 岗位 / 职级）
 *   2. schedule                 我的排期（按时间窗筛出迭代内的需求与估时条目）
 *   2b. manhour                 个人工时概览（每天打没打满 / 差值 / 未打满清单）
 *   3. req <id>                 需求详情（状态 / 负责人 / 迭代 / 优先级 / 排期 / 估时 / 关联缺陷）
 *   4. reqs                     需求列表检索（标题 / 迭代 / 产品经理 / 层级 / ID）
 *   5. bugs                     缺陷列表检索（ID / 标题 / 需求 / 处理人 / 迭代）
 *   6. iterations               迭代列表（可按业务层级过滤，或看某迭代详情）
 *   7. projects                 项目列表（新建需求时必须关联项目）
 *   8. enums                    需求 / 缺陷的枚举字典（优先级、类型、免测级别、发现方式等）
 *   9. users                    人员检索（把姓名解析成「姓名(账号)」）
 *  10. tree                     业务层级树（业务方向 → 业务线 → 系统 → 子系统）
 *
 * 只读工具：只发 GET / 只读 POST 查询，不产生任何数据变更。
 */

import {
  executeOnesApi,
  getCurrentUser,
  getMyCounts,
  getMySchedule,
  getMyManHours,
  getMyManHourSummary,
  MANHOUR_TARGET,
  queryRequirements,
  getRequirementDetail,
  getScheduleDetail,
  getEstimateDetail,
  listBugs,
  listIterations,
  getIterationDetail,
  listProjects,
  getEnums,
  searchUsers,
  resolvePerson,
  resolveIteration,
  resolveLevel,
  ONES_ORIGIN
} from './common/ones.js';

const DEFAULT_LIMIT = 20;

function printHelp() {
  console.log(`
🗂️  Leo ONES 研发管理平台探查工具 (只读)

用法:
  node scripts/ones_query.js <子命令> [参数...] [--json]

子命令:
  me                                当前登录人画像
  schedule                          我的排期（可选 --from / --to 时间窗）
  manhour                           个人工时概览（默认本月；每天打没打满）
                                    --from/--to 指定窗口，--all 连未来日期一起显示
  req <id|关键词>                   需求详情（含排期、估时、关联缺陷）
  reqs                              需求列表检索
  bugs                              缺陷列表检索
  iterations [id|标题]              迭代列表 / 迭代详情
  projects                          项目列表（--kw 按关键词）
  enums [requirement|bug]           枚举字典
  users <关键词>                    人员检索
  tree                              业务层级树

常用选项:
      --json                        以 JSON 输出（自动化 / 二次处理）
  -n, --limit <N>                   返回条数（默认 ${DEFAULT_LIMIT}）
      --page <N>                    页码（默认 1）
      --from <YYYY-MM-DD>           排期/工时起始日
      --to <YYYY-MM-DD>             排期/工时截止日
      --all                         manhour 连未来日期一起显示
      --with-bugs                   schedule 时附带我名下的缺陷
      --id <id>                     reqs / bugs 按 ID 精确查
      --require-id <requireId>      bugs 按关联需求 ID 过滤
      --title <关键词>              reqs 按标题关键词查
      --sprint <迭代ID|标题>        reqs / bugs 按迭代过滤
      --pm <姓名|账号|工号>         reqs 按产品经理过滤
      --level <方向/业务线/系统/子系统>
                                    按层级过滤，用 / 分隔（如 惠居技术中心/惠居B端/惠居IoT/IoT系统）
      --summary <关键词>            bugs 按标题关键词查
      --resolver <姓名|账号>        bugs 按处理人过滤
      --kw <关键词>                 projects 按项目名查
      --cookie <cookie>             单次临时覆盖 Cookie（仅调试）

示例:
  node scripts/ones_query.js me
  node scripts/ones_query.js schedule --from 2026-11-01 --to 2026-11-30
  node scripts/ones_query.js schedule --with-bugs --json
  node scripts/ones_query.js manhour
  node scripts/ones_query.js manhour --from 2026-11-01 --to 2026-11-30 --json
  node scripts/ones_query.js req 50564297
  node scripts/ones_query.js req 钥匙箱 --limit 5
  node scripts/ones_query.js reqs --sprint IoT-2026-10-27
  node scripts/ones_query.js reqs --pm sunzehao003 --json
  node scripts/ones_query.js bugs --sprint 10028902
  node scripts/ones_query.js iterations --level 惠居技术中心/惠居B端/惠居IoT/IoT系统
  node scripts/ones_query.js projects --kw 钥匙箱
  node scripts/ones_query.js users 孙泽浩
  node scripts/ones_query.js enums bug
`);
}

/** 解析 CLI 参数（与 apollo_query.js / baige_query.js 同一风格） */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    command: null,
    target: null,
    json: false,
    limit: DEFAULT_LIMIT,
    page: 1,
    from: '',
    to: '',
    withBugs: false,
    all: false,
    id: '',
    requireId: '',
    title: '',
    sprint: '',
    pm: '',
    level: '',
    summary: '',
    resolver: '',
    kw: '',
    cookie: '',
    help: false
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-n' || arg === '--limit') options.limit = parseInt(argv[++i], 10) || DEFAULT_LIMIT;
    else if (arg === '--page') options.page = parseInt(argv[++i], 10) || 1;
    else if (arg === '--from') options.from = argv[++i] || '';
    else if (arg === '--to') options.to = argv[++i] || '';
    else if (arg === '--with-bugs') options.withBugs = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--id') options.id = argv[++i] || '';
    else if (arg === '--require-id') options.requireId = argv[++i] || '';
    else if (arg === '--title') options.title = argv[++i] || '';
    else if (arg === '--sprint' || arg === '--iteration') options.sprint = argv[++i] || '';
    else if (arg === '--pm') options.pm = argv[++i] || '';
    else if (arg === '--level') options.level = argv[++i] || '';
    else if (arg === '--summary') options.summary = argv[++i] || '';
    else if (arg === '--resolver') options.resolver = argv[++i] || '';
    else if (arg === '--kw') options.kw = argv[++i] || '';
    else if (arg === '--cookie') options.cookie = argv[++i] || '';
    else if (!arg.startsWith('-')) positionals.push(arg);
  }

  if (positionals.length) options.command = positionals.shift();
  if (positionals.length) options.target = positionals.shift();
  if (positionals.length) options.target2 = positionals.shift();
  if (options.target && !options.kw && options.command === 'projects') options.kw = options.target;
  return options;
}

// ---------------------------------------------------------------- 输出格式 ----

const pad = (s, n) => {
  const str = String(s ?? '');
  const width = [...str].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
};

function table(headers, rows) {
  if (!rows.length) return '  （无数据）';
  const widths = headers.map((h, i) => Math.max(
    [...h].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0),
    ...rows.map(r => [...String(r[i] ?? '')].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0))
  ));
  const line = arr => '  ' + arr.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(headers), '  ' + widths.map(w => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const fmtList = v => (Array.isArray(v) && v.length ? v.join('、') : '—');

function printSection(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(Math.min(96, [...title].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0) + 8)));
}

// ------------------------------------------------------------------ 子命令 ----

async function cmdMe(opts) {
  const [user, counts] = await Promise.all([getCurrentUser({ cookie: opts.cookie }), getMyCounts({ cookie: opts.cookie })]);
  if (opts.json) return { user, counts };
  console.log(`\n👤 ONES 当前登录人`);
  console.log(`   姓名: ${user.displayName}  (昵称 ${user.nickName || '—'})`);
  console.log(`   账号: ${user.account}   工号: ${user.usercode}   UCID: ${user.ucid}`);
  console.log(`   邮箱: ${user.email}`);
  console.log(`   组织: ${user.orgName} (${user.orgCode})   岗位: ${user.position}   职级: ${user.level}`);
  console.log(`   汇报对象: ${user.superior || '—'}`);
  printSection('📊 工作台待办计数');
  console.log(table(['分类', '数量'], [
    ['缺陷 (bug)', counts?.bugcount ?? 0],
    ['需求 (require)', counts?.requirecount ?? 0],
    ['估时条目 (estimate)', counts?.estimatecount ?? 0],
    ['线上缺陷', counts?.onlinebugcount ?? 0],
    ['工单', counts?.workordercount ?? 0],
    ['线上检查', counts?.onlinecheckcount ?? 0],
    ['总计', counts?.totalcount ?? 0]
  ]));
  return null;
}

async function cmdSchedule(opts) {
  const data = await getMySchedule({
    from: opts.from,
    to: opts.to,
    person: opts.target,
    includeBugs: opts.withBugs,
    cookie: opts.cookie
  });
  if (opts.json) return data;
  const range = `${data.range.from || '—'} ~ ${data.range.to || '—'}`;
  printSection(`📅 我的排期（${range}，共 ${data.items.length} 条估时）`);
  if (data.warning) console.log(`   ⚠️ ${data.warning}`);
  console.log(table(
    ['需求 ID', '迭代', '角色', '动作', '工期', '人天', '完成', '需求标题'],
    data.items.map(i => [
      i.requireId, i.sprintTitle || '需求池', i.role, i.action,
      `${i.start} ~ ${i.end}`, i.manHours, i.finished ? '✅' : '—',
      String(i.title).slice(0, 30)
    ])
  ));
  // 按需求聚合，便于看「我这个月要交付什么」
  const byReq = new Map();
  for (const i of data.items) {
    const cur = byReq.get(i.requireId) || { title: i.title, sprint: i.sprintTitle, hours: 0, actions: new Set(), start: i.start, end: i.end, url: i.url };
    cur.hours += Number(i.manHours) || 0;
    cur.actions.add(i.action);
    if (i.start && (!cur.start || i.start < cur.start)) cur.start = i.start;
    if (i.end && (!cur.end || i.end > cur.end)) cur.end = i.end;
    byReq.set(i.requireId, cur);
  }
  printSection(`🎯 按需求汇总（${byReq.size} 个需求）`);
  console.log(table(
    ['需求 ID', '迭代', '窗口', '总人天', '涉及动作', '需求标题'],
    [...byReq.entries()].map(([id, v]) => [
      id, v.sprint || '需求池', `${v.start} ~ ${v.end}`, v.hours, [...v.actions].join('/'), String(v.title).slice(0, 34)
    ])
  ));
  if (data.bugs) {
    printSection(`🐞 我名下的缺陷（${data.bugs.length} 条）`);
    console.log(table(['缺陷 ID', '状态', '优先级', '处理人', '标题'],
      data.bugs.map(b => [b.id, b.status, b.priority, b.resolver, String(b.summary).slice(0, 44)])));
  }
  return null;
}

/** 默认看本月：工时是按天打的，月度视图最容易发现哪天漏了 */
function defaultMonthRange() {
  const now = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const f = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { from: f(first), to: f(last) };
}

const STATUS_ICON = {
  full: '✅', short: '🟡', over: '🔴', missing: '⛔', off: '·', overtime: '🌙', pending: '⏳'
};

const round1 = n => Math.round((Number(n) || 0) * 10) / 10;

async function cmdManhour(opts) {
  const range = opts.from && opts.to ? { from: opts.from, to: opts.to } : defaultMonthRange();
  const [data, summary] = await Promise.all([
    getMyManHours({ from: range.from, to: range.to, all: Boolean(opts.all), cookie: opts.cookie }),
    getMyManHourSummary({ from: range.from, to: range.to, cookie: opts.cookie }).catch(() => null)
  ]);
  if (opts.json) return { ...data, summaryBlock: summary };

  const s = data.summary;
  printSection(`⏱️ 个人工时概览 · ${data.person}（${data.range.from} ~ ${data.range.to}）`);
  console.log(`   时间窗内已记录 ${data.totalManHour} 人天  |  已过工作日 ${s.workdays} 天，应打 ${s.expected} 人天`);
  console.log(`   打满 ${s.full} 天 · 不足 ${s.short} 天 · 未打 ${s.missing} 天 · 超出 ${s.over} 天 · 加班 ${s.overtime} 天`);
  if (s.gap > 0) console.log(`   ⚠️ 还差 ${s.gap} 人天没打（${s.unfilled.length} 个工作日未打满）`);
  else if (s.gap < 0) console.log(`   ⚠️ 已超打 ${Math.abs(s.gap)} 人天，注意别超出`);
  else console.log('   ✅ 已过工作日全部正好打满');

  const rows = data.days.map(d => {
    const mark = d.isToday ? ' ← 今天' : '';
    const label = d.isWorkday ? `${d.manHour} 人天` : (d.manHour > 0 ? `${d.manHour} 人天（加班）` : '假');
    return [d.date, d.weekDay, STATUS_ICON[d.status] + ' ' + d.statusLabel, label + mark];
  });
  printSection(opts.all ? '📅 逐日明细（含未来日期）' : '📅 逐日明细（截至今天）');
  console.log(table(['日期', '星期', '状态', '工时'], rows));

  if (s.unfilled.length) {
    printSection(`🩹 未打满的工作日（${s.unfilled.length} 天）`);
    console.log(table(['日期', '星期', '已打', '差额', '状态'],
      s.unfilled.map(d => [d.date, d.weekDay, d.manHour, round1(MANHOUR_TARGET - d.manHour), d.statusLabel])));
  }
  if (summary) {
    printSection('📊 同期汇总');
    console.log(table(['指标', '值'], [
      ['总人天', summary.totalManHour],
      ['需求人天', summary.requirementManHour],
      ['缺陷人天', summary.bugManHour],
      ['工单人天', summary.workOrderManHour],
      ['工作性质占比', `PM ${summary.pmShare || '—'} / 开发 ${summary.devShare || '—'} / 其他 ${summary.otherShare || '—'}`],
      ['参与需求 / 新增缺陷', `${summary.requirementCount} 个 / ${summary.bugAddCount} 个`],
      ['提交次数 / 行数', `${summary.commitTimes} 次 / ${summary.commitLines} 行`]
    ]));
  }
  console.log(`\n   🔗 ${data.pageUrl}`);
  return null;
}

async function cmdReq(opts) {
  const raw = opts.target;
  if (!raw) throw new Error('req 需要一个需求 ID 或标题关键词');
  let requireId = null;
  let candidates = null;
  if (/^\d+$/.test(raw)) requireId = Number(raw);
  else {
    const { items, total } = await queryRequirements({ title: raw, limit: opts.limit, page: opts.page, cookie: opts.cookie });
    if (!items.length) throw new Error(`没找到标题含「${raw}」的需求`);
    if (items.length === 1) requireId = items[0].id;
    else {
      candidates = { total, items };
      requireId = items[0].id;
    }
  }

  const [detail, schedule, estimate, bugs] = await Promise.all([
    getRequirementDetail(requireId, { cookie: opts.cookie }),
    getScheduleDetail(requireId, { cookie: opts.cookie }),
    getEstimateDetail(requireId, { cookie: opts.cookie }),
    listBugs({ requireId, limit: 50, cookie: opts.cookie }).catch(() => ({ items: [], total: 0 }))
  ]);
  const result = { requirement: detail, schedule, estimates: estimate, bugs: bugs.items, ...(candidates ? { candidates } : {}) };
  if (opts.json) return result;

  if (candidates) {
    printSection(`🔎 「${raw}」命中 ${candidates.total} 个需求，展示最相关的一条（其余见下表）`);
    console.log(table(['需求 ID', '状态', '迭代', '标题'],
      candidates.items.map(i => [i.id, i.status, i.sprintTitle, String(i.title).slice(0, 40)])));
  }

  printSection(`📋 需求 ${detail.id}`);
  console.log(`   标题:   ${detail.title}`);
  console.log(`   状态:   ${detail.status}     优先级: ${detail.priority || '—'}`);
  console.log(`   类型:   ${detail.type || '—'} / ${detail.label || '—'}     免测: ${detail.notest || '—'}`);
  console.log(`   迭代:   ${detail.sprintTitle} (${detail.sprintId || 0})`);
  if (detail.level) console.log(`   层级:   ${detail.level.businessDirection || '—'} / ${detail.level.businessLine || '—'} / ${detail.level.system || '—'} / ${detail.level.subSystem || '—'}`);
  console.log(`   关联项目: ${fmtList(detail.projects)}`);
  console.log(`   产品经理: ${fmtList(detail.pm)}`);
  console.log(`   RD / QA / FE: ${fmtList(detail.rd)} / ${fmtList(detail.qa)} / ${fmtList(detail.fe)}`);
  console.log(`   安全风险: ${fmtList(detail.safetyRisk)}    涉及功能: ${fmtList(detail.safetyRiskFunctions)}`);
  if (detail.requirementUrl) console.log(`   文档:   ${detail.requirementUrl}`);
  console.log(`   链接:   ${detail.url}`);
  console.log(`   创建:   ${detail.addTime}   更新: ${detail.updateTime}`);

  printSection('🗓️ 排期');
  console.log(table(['阶段', '时间'], [
    ['开发', schedule?.developStart || schedule?.developEnd ? `${schedule.developStart || '—'} ~ ${schedule.developEnd || '—'}` : '—'],
    ['测试', schedule?.testStart || schedule?.testEnd ? `${schedule.testStart || '—'} ~ ${schedule.testEnd || '—'}` : '—'],
    ['计划提测', schedule?.submitTest || '—'],
    ['计划上线', schedule?.online || '—'],
    ['实际提测', schedule?.realSubmitTest || '—'],
    ['实际上线', schedule?.realOnline || '—']
  ]));

  printSection(`⏱️ 估时明细（开发合计 ${estimate.totalDevelopManHours} 人天 / 测试合计 ${estimate.totalTestManHours} 人天）`);
  console.log(table(['角色', '成员', '动作', '人天', '起止', '完成'],
    estimate.estimates.map(e => [e.role, e.member, e.action, e.manHours, `${e.start} ~ ${e.end}`, e.finished ? '✅' : '—'])));

  if (detail.transitions?.length) {
    printSection('🔀 当前状态可流转事件');
    console.log(table(['事件', '目标状态'], detail.transitions.map(t => [t.event, t.target || '—'])));
  }

  printSection(`🐞 关联缺陷（${bugs.items.length} 条）`);
  if (bugs.items.length) {
    console.log(table(['缺陷 ID', '状态', '优先级', '处理人', '标题'],
      bugs.items.map(b => [b.id, b.status, b.priority, b.resolver, String(b.summary).slice(0, 44)])));
  } else {
    console.log('   （该需求下没有关联缺陷）');
  }
  return null;
}

async function cmdReqs(opts) {
  let level = null;
  if (opts.level) {
    const parts = opts.level.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 4) throw new Error('--level 需要 4 段：业务方向/业务线/系统/子系统');
    level = await resolveLevel({
      direction: parts[0], line: parts[1], system: parts[2], subSystem: parts[3], cookie: opts.cookie
    });
  }
  let sprintId = opts.sprint || '';
  if (sprintId && !/^\d+$/.test(String(sprintId))) {
    const iter = await resolveIteration(sprintId, { cookie: opts.cookie });
    sprintId = iter.id;
  }
  let pm = opts.pm;
  if (pm && !/^[^()]+\([^()]+\)$/.test(pm)) {
    const resolved = await resolvePerson(pm, { cookie: opts.cookie });
    pm = resolved.replace(/^.*\((.+)\)$/, '$1');
  }
  const data = await queryRequirements({
    id: opts.id || undefined,
    title: opts.title || undefined,
    sprintId: sprintId || undefined,
    pm: pm || undefined,
    level,
    limit: opts.limit,
    page: opts.page,
    cookie: opts.cookie
  });
  if (opts.json) return data;
  printSection(`📚 需求列表（命中 ${data.total} 条，展示 ${data.items.length} 条）`);
  console.log(table(['需求 ID', '状态', '优先级', '迭代', '产品经理', '标题'],
    data.items.map(i => [
      i.id, i.status, i.priority, i.sprintTitle, fmtList(i.pm).slice(0, 20), String(i.title).slice(0, 38)
    ])));
  return null;
}

async function cmdBugs(opts) {
  let requireId = opts.requireId || (!opts.id ? opts.target : '') || '';
  let sprintId = opts.sprint || '';
  if (sprintId && !/^\d+$/.test(String(sprintId))) {
    const iter = await resolveIteration(sprintId, { cookie: opts.cookie });
    sprintId = iter.id;
  }
  let resolver = opts.resolver;
  if (resolver && !/^[^()]+\([^()]+\)$/.test(resolver)) {
    resolver = await resolvePerson(resolver, { cookie: opts.cookie });
  }
  const data = await listBugs({
    id: opts.id && /^\d+$/.test(String(opts.id)) ? opts.id : undefined,
    requireId: requireId && /^\d+$/.test(String(requireId)) ? requireId : undefined,
    summary: opts.summary || opts.title || undefined,
    resolver: resolver || undefined,
    sprintId: sprintId || undefined,
    limit: opts.limit,
    page: opts.page,
    cookie: opts.cookie
  });
  if (opts.json) return data;
  printSection(`🐞 缺陷列表（命中 ${data.total} 条，展示 ${data.items.length} 条）`);
  console.log(table(['缺陷 ID', '状态', '优先级', '类型', '处理人', '关联需求', '标题'],
    data.items.map(b => [
      b.id, b.status, b.priority, b.category, b.resolver,
      b.requireId || '—', String(b.summary).slice(0, 34)
    ])));
  return null;
}

async function cmdIterations(opts) {
  if (opts.target && /^\d+$/.test(String(opts.target))) {
    const detail = await getIterationDetail(Number(opts.target), { cookie: opts.cookie });
    if (opts.json) return detail;
    printSection(`🔁 迭代 ${detail.id}`);
    console.log(`   标题: ${detail.title}    状态: ${detail.statusLabel}`);
    console.log(`   周期: ${detail.begin || '—'} ~ ${detail.end || '—'}`);
    if (detail.level) console.log(`   层级: ${detail.level.businessDirection || '—'} / ${detail.level.businessLine || '—'} / ${detail.level.system || '—'} / ${detail.level.subSystem || '—'}`);
    console.log(`   链接: ${detail.url}`);
    return null;
  }
  let level = null;
  if (opts.level) {
    const parts = opts.level.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 4) throw new Error('--level 需要 4 段：业务方向/业务线/系统/子系统');
    level = await resolveLevel({ direction: parts[0], line: parts[1], system: parts[2], subSystem: parts[3], cookie: opts.cookie });
  }
  const data = await listIterations({ level, keyword: opts.target || opts.kw || '', limit: opts.limit, cookie: opts.cookie });
  const items = data.items;
  if (opts.json) return { total: data.total, items };
  printSection(`🔁 迭代列表（共 ${data.total} 个，展示 ${items.length} 个${opts.target ? `，关键词「${opts.target}」` : ''}）`);
  console.log(table(['迭代 ID', '标题', '状态', '周期'], items.map(i => [i.id, i.title, i.statusLabel, `${i.begin || '—'} ~ ${i.end || '—'}`])));
  return null;
}

async function cmdProjects(opts) {
  let level = null;
  if (opts.level) {
    const parts = opts.level.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 4) throw new Error('--level 需要 4 段：业务方向/业务线/系统/子系统');
    level = await resolveLevel({ direction: parts[0], line: parts[1], system: parts[2], subSystem: parts[3], cookie: opts.cookie });
  }
  const data = await listProjects({ kw: opts.kw || opts.target || undefined, level, limit: opts.limit, page: opts.page, cookie: opts.cookie });
  if (opts.json) return data;
  printSection(`🏗️ 项目列表（命中 ${data.total} 个，展示 ${data.items.length} 个）`);
  console.log(table(['项目 ID', 'ONES 项目 ID', '状态', '标题', '管理员'],
    data.items.map(p => [p.id, p.mProjectId, p.status, String(p.title).slice(0, 40), fmtList(p.admins).slice(0, 20)])));
  return null;
}

async function cmdEnums(opts) {
  const category = opts.target || 'requirement';
  const data = await getEnums(category, { cookie: opts.cookie });
  if (opts.json) return { category, enums: data };
  printSection(`📖 ONES 枚举字典：${category}`);
  for (const [k, v] of Object.entries(data)) {
    if (!v.length) continue;
    console.log(`   ${k}: ${v.join('、')}`);
  }
  return null;
}

async function cmdUsers(opts) {
  const kw = opts.target || opts.kw;
  if (!kw) throw new Error('users 需要一个姓名 / 账号 / 工号关键词');
  const data = await searchUsers(kw, { cookie: opts.cookie });
  if (opts.json) return { keyword: kw, items: data };
  printSection(`👥 人员检索「${kw}」（${data.length} 人）`);
  console.log(table(['姓名', '账号', '工号', '组织', '岗位', '在职'],
    data.map(u => [u.displayName || u.userName, u.account, u.usercode, u.orgName, u.position, u.active ? '是' : '否'])));
  return null;
}

async function cmdTree(opts) {
  const dirs = await executeOnesApi({ path: '/api/ptree/get_business_directions', cookie: opts.cookie });
  const dirList = dirs?.datalist || [];
  if (opts.json) return { businessDirections: dirList };
  printSection(`🌳 ONES 业务层级（业务方向共 ${dirList.length} 个）`);
  console.log(table(['业务方向 ID', '名称'], dirList.map(d => [d.id, d.name])));
  console.log('\n   提示: 查下级用 --level 传完整 4 段，例如');
  console.log('     node scripts/ones_query.js iterations --level 惠居技术中心/惠居B端/惠居IoT/IoT系统');
  return null;
}

const COMMANDS = {
  me: cmdMe,
  schedule: cmdSchedule,
  manhour: cmdManhour,
  req: cmdReq,
  reqs: cmdReqs,
  bugs: cmdBugs,
  iterations: cmdIterations,
  iteration: cmdIterations,
  projects: cmdProjects,
  enums: cmdEnums,
  users: cmdUsers,
  user: cmdUsers,
  tree: cmdTree
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
  const result = await handler(opts);
  if (opts.json && result !== null && result !== undefined) {
    console.log(JSON.stringify({ ok: true, command: opts.command, target: opts.target || null, site: ONES_ORIGIN, data: result }, null, 2));
  }
}

if (process.argv[1] && process.argv[1].endsWith('ones_query.js')) {
  main().catch(err => {
    const payload = { ok: false, command: parseArgs().command, error: err.message, code: err.code ?? null };
    if (process.argv.includes('--json')) console.error(JSON.stringify(payload, null, 2));
    else console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  });
}
