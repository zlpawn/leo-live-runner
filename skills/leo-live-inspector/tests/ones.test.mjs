import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONES_ORIGIN,
  ONES_SUCCESS_CODE,
  isOnesAuthFailure,
  isOnesSuccess,
  describeOnesError,
  normalizeRequirement,
  normalizeBug,
  normalizeIteration,
  normalizeProject,
  normalizeSchedule,
  normalizeEstimate,
  buildRequirementPayload,
  buildBugPayload,
  buildSchedulePayload,
  buildBugHourPayload,
  diffFields,
  onesUrl,
  roleNames,
  roleLabel,
  SCHEDULE_LABELS
} from '../scripts/common/ones.js';
import { parseArgs as parseQueryArgs } from '../scripts/ones_query.js';
import { parseArgs as parseModifyArgs } from '../scripts/ones_modify.js';

const jsonRes = (body, statusCode = 200) => ({ statusCode, headers: {}, json: body, raw: JSON.stringify(body) });

test('ONES - 基础常量', () => {
  assert.equal(ONES_ORIGIN, 'https://ones.ke.com');
  assert.equal(ONES_SUCCESS_CODE, 10000);
});

test('ONES - isOnesSuccess 只认 code === 10000', () => {
  assert.equal(isOnesSuccess(jsonRes({ code: 10000, body: {} })), true);
  assert.equal(isOnesSuccess(jsonRes({ code: 30001, message: '必要参数缺失' })), false);
  assert.equal(isOnesSuccess({ statusCode: 500, json: { code: 10000 } }), false);
  assert.equal(isOnesSuccess({ statusCode: 200, json: null, raw: '' }), false);
  assert.equal(isOnesSuccess(null), false);
});

test('ONES - isOnesAuthFailure 识别 401/403、登录跳转与 SPA 外壳', () => {
  assert.equal(isOnesAuthFailure({ statusCode: 401, headers: {} }), true);
  assert.equal(isOnesAuthFailure({ statusCode: 403, headers: {} }), true);
  assert.equal(isOnesAuthFailure({ statusCode: 302, headers: { location: 'https://login.ke.com/?service=x' } }), true);
  assert.equal(isOnesAuthFailure(jsonRes({ code: 401, message: '用户未登录' })), true);
  assert.equal(isOnesAuthFailure(jsonRes({ code: 31101, message: '您无此页面权限，请按页面提醒进行申请' })), true);
  assert.equal(isOnesAuthFailure({
    statusCode: 200,
    headers: {},
    raw: '<!DOCTYPE html>\n<html lang="zh-cn"><head><title> KeOnes </title></head></html>',
    json: null
  }), true);
  assert.equal(isOnesAuthFailure(jsonRes({ code: 30001, message: '必要参数缺失或为空business_direction_id!' })), false);
  assert.equal(isOnesAuthFailure(null), false);
});

test('ONES - describeOnesError 附加错误码释义', () => {
  assert.match(describeOnesError(30001, '必要参数缺失或为空pm!'), /必要参数缺失或为空pm!.*30001/);
  assert.match(describeOnesError(41003, ''), /41003/);
  assert.match(describeOnesError(undefined, '未知业务异常'), /未知业务异常/);
  assert.match(describeOnesError(99999, ''), /code=99999/);
});

test('ONES - roleNames 兼容字符串与对象数组', () => {
  assert.deepEqual(roleNames(['孙泽浩(sunzehao003)']), ['孙泽浩(sunzehao003)']);
  assert.deepEqual(roleNames([{ value: 'sunzehao003', name: 'sunzehao003', displayName: '孙泽浩', text: '孙泽浩' }]), ['孙泽浩(sunzehao003)']);
  assert.deepEqual(roleNames([{ value: 'x', text: '张三' }]), ['张三']);
  assert.deepEqual(roleNames(undefined), []);
  assert.deepEqual(roleNames(''), []);
});

test('ONES - roleLabel 将角色码翻译为可读名称，未知代码原样兜底', () => {
  const map = { ER0001: 'RD', ER0002: 'FE', ER0003: 'QA', ER0007: 'PM' };
  assert.equal(roleLabel('ER0001', map), 'RD');
  assert.equal(roleLabel('ER0003', map), 'QA');
  assert.equal(roleLabel('ER9999', map), 'ER9999');
  assert.equal(roleLabel('', map), '');
  assert.equal(roleLabel(null, map), '');
});

test('ONES - onesUrl 生成各实体链接', () => {
  assert.equal(onesUrl('requirement', 50564297), 'https://ones.ke.com/project/requirement/50564297');
  assert.equal(onesUrl('bug', 10413977), 'https://ones.ke.com/project/bug/10413977');
  assert.equal(onesUrl('iteration', 10028902), 'https://ones.ke.com/project/iteration/10028902');
});

test('ONES - normalizeRequirement 归一化列表与详情两种形状', () => {
  const fromList = normalizeRequirement({
    id: 50564297,
    require_id: 50564297,
    title: '【钥匙箱二期】房源钥匙上传、退还。修改',
    status: 4,
    status_name: '待测试',
    priority: 'P0',
    require_type: '产品需求',
    require_label: '常规需求',
    sprint_id: 10028902,
    sprint_title: 'IoT-2026-10-27',
    pm: [{ value: 'songqingfang001', name: 'songqingfang001', displayName: '宋青芳', text: '宋青芳' }],
    project_titles: ['惠居IoT项目'],
    business_direction_name: '惠居技术中心',
    business_line_name: '惠居B端'
  });
  assert.equal(fromList.id, 50564297);
  assert.equal(fromList.status, '待测试');
  assert.equal(fromList.sprintTitle, 'IoT-2026-10-27');
  assert.deepEqual(fromList.pm, ['宋青芳(songqingfang001)']);
  assert.deepEqual(fromList.projects, ['惠居IoT项目']);
  assert.equal(fromList.level.businessDirection, '惠居技术中心');
  assert.equal(fromList.url, 'https://ones.ke.com/project/requirement/50564297');

  const fromDetail = normalizeRequirement({ id: 50565445, title: '修改 bug', status: 0, require_status: '待评审', pm: ['孙泽浩(sunzehao003)'] });
  assert.equal(fromDetail.status, '待评审');
  assert.deepEqual(fromDetail.pm, ['孙泽浩(sunzehao003)']);
  assert.equal(fromDetail.sprintTitle, '需求池');
});

test('ONES - normalizeBug 处理 require_id 空字符串', () => {
  const bug = normalizeBug({ id: 10413977, status: 'processed', status_name: '已处理', require_id: '', summary: 'x', resolver: '孙泽浩(sunzehao003)' });
  assert.equal(bug.requireId, 0);
  assert.equal(bug.status, '已处理');
  const linked = normalizeBug({ id: 1, require_id: '50564297', summary: 'y' });
  assert.equal(linked.requireId, 50564297);
});

test('ONES - normalizeIteration 需求池与状态标签', () => {
  assert.equal(normalizeIteration({ id: 0, title: '需求池', status: 0 }).statusLabel, '需求池');
  assert.equal(normalizeIteration({ id: 10028902, title: 'IoT-2026-10-27', status: 1 }).statusLabel, '进行中');
  assert.equal(normalizeIteration({ id: 10029024, title: 'IoT-2026-11-24', status: 0 }).statusLabel, '未开始');
  assert.equal(normalizeIteration({ id: 9, status: 2 }).statusLabel, '已完成');
  assert.equal(normalizeIteration({ id: 10028902, title: 't' }).url, 'https://ones.ke.com/project/iteration/10028902');
});

test('ONES - normalizeProject 使用 m_project_id 作为建需求必填值', () => {
  const p = normalizeProject({ id: 11543, m_project_id: 11950, title: '惠居IoT项目', status_name: '立项通过', admins: ['吕宪清(lvxiangqing)'] });
  assert.equal(p.mProjectId, 11950);
  assert.equal(p.url, 'https://ones.ke.com/project/project/11950');
  assert.deepEqual(p.admins, ['吕宪清(lvxianqing)'.replace('lvxianqing', 'lvxiangqing')]);
});

test('ONES - normalizeSchedule 把 0 哨兵值显示为空', () => {
  const s = normalizeSchedule({
    require_id: 50564297,
    develop_start_time: '2026-11-09 00:00:00',
    develop_end_time: '2026-11-19 00:00:00',
    test_start_time: 0,
    test_end_time: 0,
    submit_test_time: '2026-11-20 23:59:58',
    online_time: 0
  });
  assert.equal(s.developStart, '2026-11-09');
  assert.equal(s.developEnd, '2026-11-19');
  assert.equal(s.testStart, '');
  assert.equal(s.submitTest, '2026-11-20 23:59:58');
  assert.equal(s.online, '');
});

test('ONES - normalizeEstimate 保留人天与完成标记', () => {
  const e = normalizeEstimate({ estimate_id: 2922898, require_id: 50564297, action: '开发', role_name: 'RD', member: '孙泽浩(sunzehao003)', man_hour: 7, finished: 0, start_time: '2026-11-09', end_time: '2026-11-17' });
  assert.equal(e.manHours, 7);
  assert.equal(e.finished, false);
  assert.equal(e.role, 'RD');
});

test('ONES - buildRequirementPayload 校验必填项并组装层级', () => {
  const level = { business_direction_id: 35, business_line_id: 109, system_id: 802, sub_system_id: 2516 };
  const payload = buildRequirementPayload({
    title: '标题', level, pm: ['孙泽浩(sunzehao003)'], project: { mProjectId: 11950 }, sprintId: 10029024
  });
  assert.equal(payload.title, '标题');
  assert.equal(payload.m_project_id, 11950);
  assert.equal(payload.sprint_id, 10029024);
  assert.deepEqual(payload.safety_risk, ['无']);
  assert.deepEqual(payload.safety_risk_functions, ['不包含以上业务功能']);
  assert.equal(payload.notest, '不免测');

  // 缺项目
  assert.throws(() => buildRequirementPayload({ title: 't', level, pm: ['x'], safetyRiskFunctions: ['y'] }), /关联项目/);
  // 缺层级
  assert.throws(() => buildRequirementPayload({ title: 't', pm: ['x'], project: { mProjectId: 1 }, safetyRiskFunctions: ['y'] }), /--level/);
  // 缺 PM
  assert.throws(() => buildRequirementPayload({ title: 't', level, project: { mProjectId: 1 }, safetyRiskFunctions: ['y'] }), /--pm/);
  // 缺「涉及业务功能」声明
  assert.throws(() => buildRequirementPayload({ title: 't', level, pm: ['x'], project: { mProjectId: 1 }, safetyRiskFunctions: [] }), /with-safety-func/);
  // 事务型需求不强制关联项目
  const noProject = buildRequirementPayload({ title: 't', level, pm: ['x'], requireType: '事务型需求' });
  assert.equal(noProject.m_project_id, undefined);
});

test('ONES - buildBugPayload 校验 4 个必填项', () => {
  const p = buildBugPayload({ summary: '缺陷', resolver: '孙泽浩(sunzehao003)', requireId: 50564297 });
  assert.equal(p.bug_type, '测试阶段');
  assert.equal(p.find_way, '手工测试');
  assert.equal(p.require_id, 50564297);
  assert.throws(() => buildBugPayload({ resolver: 'x' }), /--summary/);
  assert.throws(() => buildBugPayload({ summary: 's' }), /--resolver/);
  assert.throws(() => buildBugPayload({ summary: 's', resolver: 'x', priority: '' }), /--priority/);
});

test('ONES - buildSchedulePayload 只带变更字段且不含 estimatable', () => {
  const { payload, changes } = buildSchedulePayload(50564297, { developStart: '2026-12-01', online: '2026-12-20 23:59:59' });
  assert.deepEqual(payload, {
    require_id: 50564297,
    develop_start_time: '2026-12-01',
    online_time: '2026-12-20 23:59:59'
  });
  assert.equal('estimatable' in payload, false, 'updateSchedule 不允许带 estimatable');
  assert.deepEqual(Object.keys(changes).sort(), ['developStart', 'online']);
  assert.throws(() => buildSchedulePayload(1, {}), /没有要修改的排期字段/);
  assert.equal(SCHEDULE_LABELS.developStart, '开发开始');
});

test('ONES - diffFields 标记变更行', () => {
  const rows = diffFields(
    { developStart: '2026-11-09', online: '' },
    { developStart: '2026-11-09', online: '2026-12-20' },
    SCHEDULE_LABELS
  );
  const dev = rows.find(r => r.key === 'developStart');
  const online = rows.find(r => r.key === 'online');
  assert.equal(dev.changed, false);
  assert.equal(online.changed, true);
  assert.equal(online.label, '计划上线');
});

test('ONES - ones_query parseArgs 解析子命令与选项', () => {
  const o = parseQueryArgs([
    'reqs', '--sprint', 'IoT-2026-10-27', '--level', '惠居技术中心/惠居B端/惠居IoT/IoT系统',
    '-n', '5', '--pm', 'sunzehao003', '--json'
  ]);
  assert.equal(o.command, 'reqs');
  assert.equal(o.sprint, 'IoT-2026-10-27');
  assert.equal(o.level, '惠居技术中心/惠居B端/惠居IoT/IoT系统');
  assert.equal(o.limit, 5);
  assert.equal(o.pm, 'sunzehao003');
  assert.equal(o.json, true);

  const s = parseQueryArgs(['schedule', '--from', '2026-11-01', '--to', '2026-11-30', '--with-bugs']);
  assert.equal(s.command, 'schedule');
  assert.equal(s.from, '2026-11-01');
  assert.equal(s.to, '2026-11-30');
  assert.equal(s.withBugs, true);

  const projects = parseQueryArgs(['projects', '惠居']);
  assert.equal(projects.command, 'projects');
  assert.equal(projects.kw, '惠居');

  assert.equal(parseQueryArgs(['me']).command, 'me');
  assert.equal(parseQueryArgs(['--help']).help, true);
});

test('ONES - ones_modify parseArgs 解析写操作参数与 --confirm', () => {
  const req = parseModifyArgs([
    'create-req', '--title', 'T', '--level', 'a/b/c/d', '--project', 'P',
    '--pm', '孙泽浩', '--pm', '宋青芳', '--sprint', 'S', '--with-safety-func'
  ]);
  assert.equal(req.command, 'create-req');
  assert.equal(req.title, 'T');
  assert.deepEqual(req.pm, ['孙泽浩', '宋青芳']);
  assert.equal(req.withSafetyFunc, true);
  assert.equal(req.confirm, false);

  const sched = parseModifyArgs(['schedule', '50564297', '--online', '2026-12-20 23:59:59', '--confirm']);
  assert.equal(sched.command, 'schedule');
  assert.equal(sched.target, '50564297');
  assert.equal(sched.online, '2026-12-20 23:59:59');
  assert.equal(sched.confirm, true);

  const adv = parseModifyArgs(['advance', '50565445', '--event', '评审']);
  assert.equal(adv.command, 'advance');
  assert.equal(adv.event, '评审');

  const move = parseModifyArgs(['move', '1,2', '--sprint', '10029024']);
  assert.equal(move.command, 'move');
  assert.equal(move.sprint, '10029024');

  const bugHours = parseModifyArgs([
    'create-bug', '--summary', 'S', '--resolver', '孙泽浩',
    '--man-hour', '0.2', '--start', '2026-11-25 00:00:00', '--end', '2026-11-25 23:59:59'
  ]);
  assert.equal(bugHours.command, 'create-bug');
  assert.equal(bugHours.manHour, '0.2');
  assert.equal(bugHours.start, '2026-11-25 00:00:00');
  assert.equal(bugHours.end, '2026-11-25 23:59:59');
});

test('ONES - buildBugHourPayload 强制 man_hour + end_time', () => {
  const { payload, changes } = buildBugHourPayload(0, { manHours: '0.2', end: '2026-11-25 23:59:59' });
  assert.deepEqual(payload, { man_hour: 0.2, end_time: '2026-11-25 23:59:59' });
  assert.equal('id' in payload, false, '未拿到缺陷 ID 时不应带 id');
  assert.equal(changes.manHour, 0.2);

  const withId = buildBugHourPayload(10413977, {
    manHours: 0.2, start: '2026-11-25 00:00:00', end: '2026-11-25 23:59:59'
  });
  assert.equal(withId.payload.id, 10413977);
  assert.equal(withId.payload.start_time, '2026-11-25 00:00:00');

  assert.throws(() => buildBugHourPayload(0, { manHours: 0.2 }), /--end/);
  assert.throws(() => buildBugHourPayload(0, { manHours: 'abc', end: 'x' }), /--man-hour/);
  assert.throws(() => buildBugHourPayload(0, { manHours: -1, end: 'x' }), /--man-hour/);
});
