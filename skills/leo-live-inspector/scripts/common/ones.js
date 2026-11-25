/**
 * 🗂️ ONES 研发管理平台 (ones.ke.com) 客户端
 *
 * 鉴权：纯 Cookie（无 CSRF / x-token 头），登录态由 credential_relay + 本地桥接
 *       （Leo cookie.txt Locally 扩展）从真实 Chrome 静默同步。
 * 信封：{ code: 10000, message: 'OK', body: ... }，code === 10000 为成功。
 *
 * ⚠️ 安全约定：
 *   - 任何日志 / 报错都不得输出 Cookie 值；本文件只在请求头里使用它。
 *   - 写操作（新建需求/缺陷、改排期、切迭代、流转状态）一律先由 CLI 输出
 *     Dry-Run Diff，用户明确确认后才带 --confirm 真正提交。
 */

import { requestHttp } from './http.js';
import { loadOnesCookie, saveOnesCookie } from './credentials.js';
import { createCredentialSession } from './browser_credentials.js';

export const ONES_ORIGIN = 'https://ones.ke.com';
export const ONES_SUCCESS_CODE = 10000;

export const ONES_ERROR_CODES = {
  30000: '参数或权限校验未通过',
  30001: '必要参数缺失 / 不符合业务前置条件',
  31001: '必要参数缺失或格式不正确',
  31101: '无该页面权限',
  41001: '服务端处理失败（多为对象不存在或状态不允许）',
  41003: '服务端内部异常（缺字段 / 类型错误）',
  44000: '网关超时或服务不可用'
};

/** 本 Skill 实际使用的接口路径；用于把「SPA 兜底 HTML」判定为登录态失效而不是路径写错 */
const KNOWN_API_PATHS = new Set([
  '/api/uc/fetchUser',
  '/api/uc/fetchUsers',
  '/api/minepage/get_counts',
  '/api/minepage/get_infos',
  '/api/requirements/requirement_list',
  '/api/requirements/fetchReqs',
  '/api/requirements/get_require_detail',
  '/api/requirements/scheduleDetail',
  '/api/requirements/get_estimate_and_schedule_detail',
  '/api/requirements/estimateList',
  '/api/requirements/get_estimate_role',
  '/api/requirements/sprint_list',
  '/api/requirements/get_sprint_detail',
  '/api/requirements/save_requirement',
  '/api/requirements/updateSchedule',
  '/api/requirements/createSchedule',
  '/api/requirements/moveReq',
  '/api/requirements/estimateCreate',
  '/api/iterations/fetchIterations',
  '/api/bug/get_bugs',
  '/api/bug/saveBug',
  '/api/bug/save_hour',
  '/api/project/project_list',
  '/api/ptree/get_business_directions',
  '/api/ptree/get_businesslines',
  '/api/ptree/get_systems',
  '/api/ptree/get_subsystems',
  '/api/enum/get_enum',
  '/api/fsm/change_status',
  '/api/bi/get_person_report_distribution',
  '/api/bi/get_person_report_summary'
]);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const isSpaShell = res => typeof res?.raw === 'string' && /<!doctype html|<html[\s>]/i.test(res.raw) && /KeOnes/i.test(res.raw);

/** 登录态失效判定：401/403、跳登录、或已知接口返回 SPA 外壳 HTML */
export function isOnesAuthFailure(res) {
  if (!res) return false;
  const status = res.statusCode;
  if (status === 401 || status === 403) return true;
  if (status >= 300 && status < 400 && /login|passport|sso/i.test(res.headers?.location || '')) return true;
  const json = res.json;
  if (json && typeof json === 'object') {
    if (json.code === 401 || json.code === 403) return true;
    if (/未登录|请先登录|登录已失效|无此页面权限/i.test(String(json.message || ''))) return true;
  }
  if (isSpaShell(res)) return true;
  return false;
}

export function isOnesSuccess(res) {
  if (!res || res.statusCode !== 200) return false;
  const json = res.json;
  return Boolean(json && typeof json === 'object' && json.code === ONES_SUCCESS_CODE);
}

const credentialSessions = new Map();

function getCredentialSession(explicitCookie) {
  if (explicitCookie) {
    return createCredentialSession({
      load: () => explicitCookie,
      save: () => {},
      explicit: true,
      isAuthFailure: isOnesAuthFailure,
      isSuccess: isOnesSuccess
    });
  }
  const envCookie = Boolean(process.env.ONES_COOKIE);
  let session = credentialSessions.get('default');
  if (!session) {
    session = createCredentialSession({
      load: () => loadOnesCookie(),
      save: cookieStr => saveOnesCookie(cookieStr),
      explicit: envCookie,
      isAuthFailure: isOnesAuthFailure,
      isSuccess: isOnesSuccess,
      names: ['ones_ke_token', 'session_id', 'csrfSecret', 'login_ucid', 'ucid', 'lianjia_ssid', 'lianjia_uuid']
    });
    credentialSessions.set('default', session);
  }
  return session;
}

export class OnesApiError extends Error {
  constructor(message, { code, path, body } = {}) {
    super(message);
    this.name = 'OnesApiError';
    this.code = code;
    this.path = path;
    this.body = body;
  }
}

export function describeOnesError(code, message) {
  const hint = ONES_ERROR_CODES[code];
  const text = String(message || '').trim();
  if (hint && text) return `${text}（错误码 ${code}：${hint}）`;
  if (hint) return `错误码 ${code}：${hint}`;
  return text || `未知错误（code=${code}）`;
}

/**
 * 执行一次 ONES REST 调用，成功返回 json.body。
 * @param {object} opts
 * @param {string} opts.path     /api/... 路径
 * @param {string} [opts.method] 默认 GET
 * @param {object} [opts.params] 查询参数
 * @param {any}    [opts.postBody] POST 体（对象或字符串）
 * @param {string} [opts.cookie] 单次覆盖 Cookie（仅调试用）
 * @param {boolean} [opts.isReadOnly] 默认 true；false 表示本次调用会写数据
 * @param {number} [opts.timeout] 毫秒
 */
export async function executeOnesApi({
  path,
  method = 'GET',
  params = null,
  postBody = null,
  cookie = null,
  isReadOnly = true,
  timeout = 20000
} = {}) {
  if (!path || !path.startsWith('/api/')) throw new Error('ONES 接口路径必须以 /api/ 开头');

  let fullPath = path;
  if (params && Object.keys(params).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) fullPath += (fullPath.includes('?') ? '&' : '?') + s;
  }

  const session = getCredentialSession(cookie);
  const targetUrl = ONES_ORIGIN + fullPath;
  const basePath = fullPath.split('?')[0];

  const res = await session.run(targetUrl, async (activeCookie) => requestHttp({
    protocol: 'https:',
    hostname: 'ones.ke.com',
    port: 443,
    path: fullPath,
    method: method.toUpperCase(),
    timeout,
    headers: {
      Cookie: activeCookie,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': UA,
      Referer: ONES_ORIGIN + '/',
      'X-Requested-With': 'XMLHttpRequest'
    }
  }, postBody && method.toUpperCase() !== 'GET' ? postBody : null), { readOnly: isReadOnly });

  if (isOnesAuthFailure(res) && KNOWN_API_PATHS.has(basePath)) {
    throw new OnesApiError(
      'ONES 登录态已失效：请在 Chrome 中登录 ones.ke.com（或到控制台「凭据」Tab 点 ONES 的「刷新」）后重试。',
      { code: 'CREDENTIAL_REJECTED', path: fullPath }
    );
  }

  if (res.statusCode === 504 || res.error) {
    throw new OnesApiError(`ONES 请求超时或网络不可达：${res.error || 'timeout'}`, { code: 'NETWORK', path: fullPath });
  }

  const json = res.json;
  if (!json || typeof json !== 'object') {
    const looksSpa = isSpaShell(res);
    throw new OnesApiError(
      looksSpa
        ? `${fullPath} 返回了前端页面而不是 JSON（登录态失效，或该接口路径不属于 ONES 现有 API）`
        : `${fullPath} 返回了非 JSON 内容（HTTP ${res.statusCode}）`,
      { code: 'NOT_JSON', path: fullPath }
    );
  }

  if (json.code !== ONES_SUCCESS_CODE) {
    throw new OnesApiError(describeOnesError(json.code, json.message), {
      code: json.code,
      path: fullPath,
      body: json.body
    });
  }
  return json.body;
}

// ------------------------------------------------------------------ 归一化 ----

const asList = v => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]));

export function roleNames(value) {
  return asList(value)
    .map(x => (typeof x === 'string' ? x : (x?.displayName && x?.name ? `${x.displayName}(${x.name})` : (x?.text || x?.value || ''))))
    .filter(Boolean);
}

function levelOf(obj) {
  if (!obj) return null;
  const out = {};
  const map = {
    businessDirection: 'business_direction_name',
    businessLine: 'business_line_name',
    system: 'system_name',
    subSystem: 'sub_system_name'
  };
  for (const [k, src] of Object.entries(map)) if (obj[src]) out[k] = obj[src];
  const ids = {
    businessDirection: obj.business_direction_id,
    businessLine: obj.business_line_id,
    system: obj.system_id,
    subSystem: obj.sub_system_id
  };
  if (Object.values(ids).some(v => v !== undefined && v !== null && v !== 0)) out.ids = ids;
  return Object.keys(out).length ? out : null;
}

export function onesUrl(kind, id) {
  const base = {
    requirement: 'project/requirement',
    bug: 'project/bug',
    iteration: 'project/iteration',
    project: 'project/project'
  }[kind] || kind;
  return `${ONES_ORIGIN}/${base}/${id}`;
}

export function normalizeRequirement(row) {
  if (!row) return null;
  const id = row.id ?? row.require_id;
  return {
    id,
    title: row.title || row.summary || '',
    status: row.status_name || row.require_status || row.status || '',
    statusCode: row.status,
    priority: row.priority || '',
    type: row.require_type || '',
    label: row.require_label || '',
    sprintId: row.sprint_id || 0,
    sprintTitle: row.sprint_title || '需求池',
    pm: roleNames(row.pm),
    rd: roleNames(row.rd_list),
    qa: roleNames(row.qa_list),
    fe: roleNames(row.fe_list),
    level: levelOf(row),
    projects: row.project_titles || [],
    assigneeNames: [row.add_by_display_name, ...roleNames(row.pm)].filter(Boolean),
    addTime: row.add_time || '',
    updateTime: row.update_time || '',
    url: onesUrl('requirement', id)
  };
}

export function normalizeBug(row) {
  if (!row) return null;
  const id = row.id;
  return {
    id,
    summary: row.summary || '',
    status: row.status_name || row.status || '',
    statusCode: row.status,
    priority: row.priority || '',
    category: row.category || '',
    bugType: row.bug_type || '',
    findWay: row.find_way || '',
    resolver: row.resolver || '',
    reporter: row.add_by_display_name ? `${row.add_by_display_name}` : (row.add_by || ''),
    requireId: row.require_id ? Number(row.require_id) || row.require_id : 0,
    requireTitle: row.require_title || '',
    sprintTitle: row.sprint_title || '',
    level: levelOf(row),
    addTime: row.add_time || '',
    url: onesUrl('bug', id)
  };
}

export function normalizeIteration(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || '',
    status: row.status,
    statusLabel: row.status === 1 ? '进行中' : (row.status === 2 ? '已完成' : (row.id === 0 ? '需求池' : '未开始')),
    begin: row.begin_time || '',
    end: row.end_time || '',
    isLocked: row.is_lock === 1,
    level: levelOf(row),
    url: row.id ? onesUrl('iteration', row.id) : ''
  };
}

export function normalizeProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    mProjectId: row.m_project_id || row.id,
    title: row.title || '',
    status: row.status_name || '',
    admins: roleNames(row.admins),
    departments: row.department_names || [],
    url: onesUrl('project', row.m_project_id || row.id)
  };
}

export function normalizeSchedule(detail) {
  if (!detail) return null;
  const t = v => (v && v !== 0 && v !== '0' ? String(v).slice(0, 10) : '');
  const full = v => (v && v !== 0 && v !== '0' ? String(v) : '');
  return {
    requireId: detail.require_id,
    developStart: t(detail.develop_start_time),
    developEnd: t(detail.develop_end_time),
    testStart: t(detail.test_start_time),
    testEnd: t(detail.test_end_time),
    submitTest: full(detail.submit_test_time),
    online: full(detail.online_time),
    review: full(detail.review_time),
    realSubmitTest: full(detail.real_submit_test_time),
    realOnline: full(detail.real_online_time)
  };
}

export function normalizeEstimate(row) {
  if (!row) return null;
  return {
    estimateId: row.estimate_id,
    requireId: row.require_id,
    action: row.action || '',
    role: row.role_name || '',
    member: row.member || '',
    manHours: row.man_hour ?? 0,
    finished: Number(row.finished) === 1,
    start: row.start_time || '',
    end: row.end_time || '',
    description: row.description || ''
  };
}

// ------------------------------------------------------------------- 读取 ----

export async function getCurrentUser({ cookie } = {}) {
  const body = await executeOnesApi({ path: '/api/uc/fetchUser', cookie });
  return {
    displayName: body.display_name,
    nickName: body.nick_name,
    realName: body.realname,
    email: body.email,
    account: body.email_prefix,
    ucid: body.ucid,
    usercode: body.usercode,
    orgCode: body.org_code,
    orgName: body.org_name,
    position: body.position_name,
    level: body.level_name,
    superior: body.superior_name,
    avatar: body.avatar
  };
}

export async function getMyCounts({ cookie } = {}) {
  return executeOnesApi({
    path: '/api/minepage/get_counts',
    params: { quick_check: 'allaboutme' },
    cookie
  });
}

const CATEGORY_ALIAS = {
  estimate: 'estimate',
  schedule: 'estimate',
  bug: 'bug',
  bugs: 'bug',
  require: 'require',
  requirement: 'require',
  requirements: 'require',
  onlinebug: 'onlinebug',
  approval: 'approval'
};

/** 工作台「我的 / 我创建的」聚合列表。quick_check=allaboutme 始终只看当前登录人 */
export async function getWorkbenchList({ category = 'estimate', quickCheck = 'allaboutme', page = 1, limit = 200, cookie } = {}) {
  const cat = CATEGORY_ALIAS[String(category).toLowerCase()];
  if (!cat) throw new Error(`不支持的工作台分类: ${category}（可用 estimate/bug/require）`);
  return executeOnesApi({
    path: '/api/minepage/get_infos',
    params: { quick_check: quickCheck, category: cat, page, limit },
    cookie
  });
}

// get_estimate_role 的代码→名称映射，进程内缓存（一次会话读一次即可）
let ESTIMATE_ROLE_MAP = null;

/** 取角色代码→名称映射（ER0001 → RD）。失败时退化为空表，不阻塞排期查询 */
export async function getEstimateRoleMap({ cookie, refresh = false } = {}) {
  if (ESTIMATE_ROLE_MAP && !refresh) return ESTIMATE_ROLE_MAP;
  try {
    const rows = await executeOnesApi({ path: '/api/requirements/get_estimate_role', cookie });
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => {
      if (r && r.code) map[String(r.code)] = r.value || String(r.code);
    });
    ESTIMATE_ROLE_MAP = map;
    return map;
  } catch {
    ESTIMATE_ROLE_MAP = {};
    return ESTIMATE_ROLE_MAP;
  }
}

/** 把角色代码翻成可读名称；未知代码原样返回 */
export function roleLabel(code, map = {}) {
  const c = String(code || '').trim();
  if (!c) return '';
  return map[c] || c;
}

function overlaps(rowStart, rowEnd, from, to) {
  if (!from && !to) return true;
  const s = rowStart ? String(rowStart).slice(0, 10) : '';
  const e = rowEnd ? String(rowEnd).slice(0, 10) : s;
  if (!s) return false;
  const rs = s;
  const re = e || s;
  if (from && re < from) return false;
  if (to && rs > to) return false;
  return true;
}

/**
 * 我的排期（按月/任意时间窗）。
 * ONES 工作台的 estimate 列表固定按「当前登录人」返回，person 只用于校验/标注。
 */
export async function getMySchedule({ from, to, person, includeBugs = false, cookie } = {}) {
  const [data, roleMap] = await Promise.all([
    getWorkbenchList({ category: 'estimate', limit: 1000, cookie }),
    getEstimateRoleMap({ cookie })
  ]);
  const rows = (data?.datalist || []).map(row => ({
    requireId: row.require_id,
    estimateId: row.estimate_id,
    title: row.title || '',
    action: row.action || '',
    roleCode: row.role_code || '',
    role: roleLabel(row.role_code, roleMap),
    member: row.member || '',
    manHours: row.man_hour ?? 0,
    finished: Number(row.finished) === 1,
    start: row.start_time || '',
    end: row.end_time || '',
    sprintId: row.sprint_id || 0,
    sprintTitle: row.sprint_title || '',
    description: row.description || '',
    url: onesUrl('requirement', row.require_id)
  }));
  const filtered = rows.filter(r => overlaps(r.start, r.end, from, to));

  const out = { range: { from: from || data?.start_date || '', to: to || data?.end_date || '' }, items: filtered };
  if (person) {
    const me = await getCurrentUser({ cookie });
    const wanted = String(person).toLowerCase();
    const mine = [me.displayName, me.account, me.realName, me.nickName]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(wanted) || wanted.includes(String(v).toLowerCase()));
    out.person = { input: person, currentUser: me.displayName, isCurrentUser: mine };
    if (!mine) {
      out.warning = `ONES 工作台的「我的排期」只能取当前登录人（${me.displayName}）的数据；`
        + `要查他人排期请用 ones_query.js reqs --pm ${person} 看其参与的需求，再对单需求用 req <id> 查估时。`;
    }
  }
  if (includeBugs) {
    const bugs = await getWorkbenchList({ category: 'bug', limit: 200, cookie });
    out.bugs = (bugs?.datalist || []).map(normalizeBug);
  }
  return out;
}

// ------------------------------------------------------------ 个人工时概览 ----

/** ONES 个人工时页（https://ones.ke.com/profile/manhour）背后的日历接口 */
export const ONES_MANHOUR_PAGE = ONES_ORIGIN + '/profile/manhour';

/**
 * 一天的工时判定。
 *
 * 判据来自 ONES 自己：`is_workday` 已经算好法定节假日与调休（国庆 10/1~10/7
 * 是 0，10/10 周六调休上班是 1），不需要我们内置节假日表。
 *
 * - 非工作日：有工时记为「加班」，没有记为「假」
 * - 工作日：等于 1 天记「满」，小于 1 记「不足」，大于 1 记「超量」，0 记「缺」
 */
export const MANHOUR_STATUS = {
  full: { key: 'full', label: '已打满', tone: 'ok' },
  short: { key: 'short', label: '不足', tone: 'warn' },
  over: { key: 'over', label: '超出', tone: 'err' },
  missing: { key: 'missing', label: '未打', tone: 'err' },
  off: { key: 'off', label: '假', tone: 'muted' },
  overtime: { key: 'overtime', label: '加班', tone: 'info' },
  // 未来工作日：还没到，不是「漏打」，不能报成红色告警
  pending: { key: 'pending', label: '待打', tone: 'muted' }
};

/** 一天应为多少工时；ONES 默认 1 人天，作为判满基准 */
export const MANHOUR_TARGET = 1;

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function classifyDay(manHour, isWorkday) {
  const h = round2(manHour);
  if (!isWorkday) return h > 0 ? MANHOUR_STATUS.overtime : MANHOUR_STATUS.off;
  if (h <= 0) return MANHOUR_STATUS.missing;
  if (Math.abs(h - MANHOUR_TARGET) < 0.005) return MANHOUR_STATUS.full;
  return h < MANHOUR_TARGET ? MANHOUR_STATUS.short : MANHOUR_STATUS.over;
}

/**
 * 把 distribution 接口的原始行归一化成「每天一条」，并补上判定与汇总。
 *
 * 返回的 days 按日期升序，未来日期也会出现（ONES 会返回整段时间窗），
 * 由上层决定是否隐藏。
 */
export function normalizeManhourDays(rows, { today = null } = {}) {
  const t = today || new Date().toISOString().slice(0, 10);
  const days = (rows || []).map(r => {
    const date = String(r.day || '').slice(0, 10);
    const isWorkday = Number(r.is_workday) === 1;
    const manHour = round2(r.man_hour);
    const isFuture = Boolean(date && date > t);
    const status = isFuture && isWorkday && manHour <= 0 ? MANHOUR_STATUS.pending : classifyDay(manHour, isWorkday);
    return {
      date,
      weekDay: r.week_day || '',
      isWorkday,
      manHour,
      status: status.key,
      statusLabel: status.label,
      tone: status.tone,
      isFuture,
      isToday: date === t
    };
  }).sort((a, b) => a.date.localeCompare(b.date));

  const workdays = days.filter(d => d.isWorkday && !d.isFuture);
  const summary = {
    totalDays: days.length,
    workdays: workdays.length,
    manHours: round2(days.reduce((a, d) => a + d.manHour, 0)),
    full: workdays.filter(d => d.status === 'full').length,
    short: workdays.filter(d => d.status === 'short').length,
    missing: workdays.filter(d => d.status === 'missing').length,
    over: workdays.filter(d => d.status === 'over').length,
    off: days.filter(d => d.status === 'off').length,
    overtime: days.filter(d => d.status === 'overtime').length,
    expected: round2(workdays.length * MANHOUR_TARGET),
    gap: round2(workdays.reduce((a, d) => a + (MANHOUR_TARGET - d.manHour), 0))
  };
  summary.unfilled = workdays.filter(d => d.status !== 'full')
    .map(d => ({ date: d.date, weekDay: d.weekDay, manHour: d.manHour, status: d.status, statusLabel: d.statusLabel }));
  return { days, summary };
}

/**
 * 个人工时概览（`/api/bi/get_person_report_distribution`）。
 */
export async function getMyManHours({ from, to, displayName = null, today = null, all = false, cookie } = {}) {
  let name = displayName;
  if (!name) {
    const me = await getCurrentUser({ cookie });
    name = me.displayName;
    if (me.account && !String(name).includes('(')) name = `${name}(${me.account})`;
  }
  const body = await executeOnesApi({
    path: '/api/bi/get_person_report_distribution',
    params: { display_name: name, start_time: from, end_time: to },
    cookie
  });
  const { days, summary } = normalizeManhourDays(body?.datalist, { today });
  const visible = all ? days : days.filter(d => !d.isFuture);
  return {
    person: body?.display_name || name,
    range: { from: body?.start_time || from, to: body?.end_time || to },
    totalManHour: round2(body?.total_man_hour),
    days: visible,
    summary,
    pageUrl: ONES_MANHOUR_PAGE
  };
}

/** 同一时间窗的工时汇总（总人天 / 需求 / 缺陷 / 工作性质占比），与日历互补 */
export async function getMyManHourSummary({ from, to, displayName = null, cookie } = {}) {
  let name = displayName;
  if (!name) {
    const me = await getCurrentUser({ cookie });
    name = me.displayName;
    if (me.account && !String(name).includes('(')) name = `${name}(${me.account})`;
  }
  const body = await executeOnesApi({
    path: '/api/bi/get_person_report_summary',
    params: { display_name: name, start_time: from, end_time: to },
    cookie
  });
  return {
    person: body?.display_name || name,
    range: { from: String(body?.start_time || from).slice(0, 10), to: String(body?.end_time || to).slice(0, 10) },
    totalManHour: round2(body?.total_man_hour),
    requirementManHour: round2(body?.total_requirement_man_hour),
    bugManHour: round2(body?.total_bug_man_hour),
    workOrderManHour: round2(body?.total_work_order_man_hour),
    pmShare: body?.pm_req_hour || '',
    devShare: body?.dev_req_hour || '',
    otherShare: body?.other_req_hour || '',
    requirementCount: body?.partice_req_num ?? 0,
    bugAddCount: body?.bug_add_num ?? 0,
    bugResolveCount: body?.bug_resolve_num ?? 0,
    commitTimes: body?.code_commit_times ?? 0,
    commitLines: body?.code_commit_lines ?? 0
  };
}

export async function queryRequirements({
  id, title, sprintId, pm, level, limit = 20, page = 1, cookie
} = {}) {
  const body = {};
  if (id) body.id = Number(id);
  if (title) body.title = title;
  if (sprintId !== undefined && sprintId !== null && sprintId !== '') body.sprint_id = Number(sprintId);
  if (pm) body.pm = pm;
  if (level) {
    Object.assign(body, level);
  }
  body.page = page;
  body.limit = limit;
  const data = await executeOnesApi({ path: '/api/requirements/requirement_list', method: 'POST', postBody: body, cookie });
  return {
    total: data?.totalcount ?? 0,
    items: (data?.datalist || []).map(normalizeRequirement)
  };
}

export async function getRequirementDetail(requireId, { cookie } = {}) {
  const body = await executeOnesApi({
    path: '/api/requirements/get_require_detail',
    params: { require_id: requireId },
    cookie
  });
  const base = normalizeRequirement(body);
  return {
    ...base,
    desc: body.desc || '',
    requirementUrl: body.requirement_url || '',
    notest: body.notest || '',
    safetyRisk: asList(body.safety_risk),
    safetyRiskFunctions: asList(body.safety_risk_functions),
    estimatable: body.estimatable,
    isSupportEstimate: body.is_support_estimate,
    transitions: summarizeTransitions(body.transitions)
  };
}

function summarizeTransitions(transitions) {
  if (!transitions || typeof transitions !== 'object') return [];
  const current = transitions.init || '';
  const node = transitions[current];
  const ets = node?.master?.ets || node?.master?.events || [];
  return ets.map(e => ({ event: e.event, target: e.target, type: e.type }));
}

export async function getScheduleDetail(requireId, { cookie } = {}) {
  const body = await executeOnesApi({
    path: '/api/requirements/scheduleDetail',
    params: { require_id: requireId },
    cookie
  });
  return normalizeSchedule(body);
}

export async function getEstimateDetail(requireId, { cookie } = {}) {
  const body = await executeOnesApi({
    path: '/api/requirements/get_estimate_and_schedule_detail',
    params: { require_id: requireId },
    cookie
  });
  return {
    schedule: normalizeSchedule(body?.schedule ? { require_id: requireId, ...body.schedule } : null),
    estimates: (body?.estimates || []).map(normalizeEstimate),
    totalDevelopManHours: body?.total_develop_manhour ?? 0,
    totalTestManHours: body?.total_test_manhour ?? 0,
    range: { start: body?.start_date || '', end: body?.end_date || '' }
  };
}

export async function listBugs({ id, requireId, requireIds, summary, resolver, sprintId, limit = 20, page = 1, cookie, scan = 600 } = {}) {
  const body = { page, limit };
  if (id) body.id = Number(id);
  if (requireId) body.require_ids = [Number(requireId)];
  if (requireIds?.length) body.require_ids = requireIds.map(Number);
  // get_bugs 服务端只认 id / resolver / require_ids / sprint_id 等精确字段；
  // summary / kw / title / search 等模糊字段全部被静默忽略，并返回全库 3.5 万条。
  // 所以标题过滤只能本地做：从最新往旧翻页扫描 scan 条，再按关键词筛。
  if (resolver) body.resolver = resolver;
  if (sprintId !== undefined && sprintId !== null && sprintId !== '') body.sprint_id = Number(sprintId);

  const wantSummary = String(summary || '').trim();
  const want = Math.max(Number(limit) || 20, 1);
  const scanCount = Math.max(Number(scan) || 600, want);

  if (!wantSummary) {
    const data = await executeOnesApi({ path: '/api/bug/get_bugs', method: 'POST', postBody: body, cookie });
    return { total: data?.totalcount ?? 0, items: (data?.datalist || []).map(normalizeBug) };
  }

  // 分页扫描：服务端每页固定返回 10 条，不受 limit 控制，只能靠翻页累积
  const kw = wantSummary.toLowerCase();
  const matched = [];
  const maxPages = Math.ceil(scanCount / 10) + 5;
  let scanned = 0;

  for (let p = 1; p <= maxPages; p++) {
    const data = await executeOnesApi({
      path: '/api/bug/get_bugs',
      method: 'POST',
      postBody: { ...body, page: p, limit: 10 },
      cookie
    });
    const rows = data?.datalist || [];
    if (!rows.length) break;
    scanned += rows.length;
    for (const r of rows) {
      if (String(r.summary || '').toLowerCase().includes(kw)) matched.push(r);
    }
    if (matched.length >= want) break;
  }

  return {
    total: matched.length,
    scanned,
    items: matched.slice(0, want).map(normalizeBug)
  };
}

export async function listIterations({ level = null, keyword = '', limit = 200, cookie } = {}) {
  // fetchIterations 必须走 GET + 查询参数；POST 会忽略 limit/keyword 并固定返回前 1001 条。
  const params = { page: 1, limit: Math.min(Math.max(Number(limit) || 200, 1), 1000) };
  if (level) Object.assign(params, level);
  if (keyword) params.critical_key = keyword;
  const data = await executeOnesApi({ path: '/api/iterations/fetchIterations', params, cookie });
  let items = (data?.datalist || []).map(normalizeIteration);
  if (keyword) items = items.filter(i => i.title.toLowerCase().includes(String(keyword).toLowerCase()));
  return { total: data?.totalcount ?? items.length, items };
}

export async function getIterationDetail(sprintId, { cookie } = {}) {
  const body = await executeOnesApi({
    path: '/api/requirements/get_sprint_detail',
    params: { sprint_id: sprintId },
    cookie
  });
  return normalizeIteration(body);
}

export async function listProjects({ kw, level, limit = 20, page = 1, cookie } = {}) {
  const body = { page, limit };
  if (kw) {
    body.kw = kw;
    body.source = 'sug';
    body.from = 'req_create';
  }
  if (level) Object.assign(body, level);
  const data = await executeOnesApi({ path: '/api/project/project_list', method: 'POST', postBody: body, cookie });
  const rows = (data?.pageList || data?.datalist || []).filter(r => Number(r.m_project_id ?? r.id) > 0);
  return {
    total: data?.totalCount ?? data?.totalcount ?? rows.length,
    items: rows.map(normalizeProject)
  };
}

export async function getEnums(category = 'requirement', { cookie } = {}) {
  const body = await executeOnesApi({ path: '/api/enum/get_enum', params: { category }, cookie });
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    out[k] = asList(v).map(x => (typeof x === 'string' ? x : (x?.key ?? x?.value ?? x)));
  }
  return out;
}

export async function searchUsers(keyword, { cookie } = {}) {
  const rows = await executeOnesApi({ path: '/api/uc/fetchUsers', method: 'POST', postBody: { kw: keyword }, cookie });
  const kw = String(keyword || '').toLowerCase();
  const list = asList(rows).map(u => ({
    displayName: u.display_name,
    account: u.account,
    userName: u.user_name,
    nickName: u.nick_name,
    email: u.email,
    usercode: u.user_code,
    ucid: u.ucid,
    orgName: u.org_name,
    position: u.position_name,
    active: Number(u.pos_active) === 1
  }));
  const scored = list.filter(u => !kw
    || [u.displayName, u.account, u.userName, u.nickName, u.email, u.usercode]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(kw)));
  return scored.length ? scored : list;
}

/** 把 "姓名(username)" / username / 工号 / 邮箱 统一解析成 ONES 的人员标识串 */
export async function resolvePerson(input, { cookie } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('人员不能为空');
  if (/^[^()]+\([^()]+\)$/.test(raw)) return raw; // 已是 姓名(username)
  const candidates = await searchUsers(raw, { cookie });
  const exact = candidates.find(u => u.account === raw || u.displayName === raw
    || String(u.usercode) === raw || u.email === raw || u.userName === raw);
  if (exact) return exact.displayName || `${exact.userName}(${exact.account})`;
  const lowered = raw.toLowerCase();
  const fuzzy = candidates.find(u => String(u.account).toLowerCase() === lowered
    || String(u.userName || '').toLowerCase() === lowered);
  if (fuzzy) return fuzzy.displayName || `${fuzzy.userName}(${fuzzy.account})`;
  if (candidates.length === 1) return candidates[0].displayName || `${candidates[0].userName}(${candidates[0].account})`;
  const preview = candidates.slice(0, 6).map(u => `${u.displayName || u.userName}（账号 ${u.account}）`).join('、');
  throw new Error(`没能在 ONES 里唯一定位「${raw}」，候选：${preview || '无'}。请改用「姓名(账号)」格式，如 孙泽浩(sunzehao003)`);
}

export async function resolveIteration(input, { cookie } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('迭代不能为空');
  if (/^\d+$/.test(raw)) {
    const detail = await getIterationDetail(Number(raw), { cookie });
    if (!detail) throw new Error(`没找到迭代 ID ${raw}`);
    return detail;
  }
  // 服务端支持 critical_key 关键词检索，比拉全量再本地过滤可靠（全量只返回前 1001 条）
  const { items } = await listIterations({ keyword: raw, limit: 100, cookie });
  const exact = items.filter(i => i.title === raw);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const sorted = exact.sort((a, b) => (b.begin || '').localeCompare(a.begin || ''));
    return { ...sorted[0], ambiguous: exact.map(i => i.id) };
  }
  if (items.length === 1) return items[0];
  if (items.length > 1) {
    const preview = items.slice(0, 8).map(i => `${i.title}(${i.id})`).join('、');
    throw new Error(`「${raw}」匹配到多个迭代：${preview}。请传完整标题或直接传迭代 ID。`);
  }
  throw new Error(`没找到标题含「${raw}」的迭代（确认标题是否正确；迭代 ID 可直接查）`);
}

export async function resolveProject(input, { level, cookie } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('项目不能为空');
  if (/^\d+$/.test(raw)) {
    const { items } = await listProjects({ level, limit: 50, cookie });
    const hit = items.find(p => String(p.mProjectId) === raw || String(p.id) === raw);
    if (hit) return hit;
    return { id: Number(raw), mProjectId: Number(raw), title: `项目 ${raw}`, status: '', admins: [], departments: [], url: onesUrl('project', raw) };
  }
  const { items } = await listProjects({ kw: raw, level, limit: 20, cookie });
  if (!items.length) throw new Error(`没找到标题含「${raw}」的项目；可先用 ones_query.js projects --kw ${raw} 确认`);
  const exact = items.find(p => p.title.includes(raw));
  const picked = exact || items[0];
  return { ...picked, ambiguous: items.length > 1 ? items.slice(0, 8).map(p => `${p.title}(${p.mProjectId})`) : undefined };
}

/**
 * 只解析业务方向 + 业务线（缺陷 saveBug 的最低层级要求）。
 * 系统/子系统能解析就带上（视图更好找），解析不到不报错。
 */
export async function resolveLevelShallow({ direction, line, system, subSystem, cookie } = {}) {
  const dirs = await executeOnesApi({ path: '/api/ptree/get_business_directions', cookie });
  const dirList = asList(dirs?.datalist);
  const dir = dirList.find(x => x.name === direction) || dirList.find(x => x.name.includes(direction));
  if (!dir) throw new Error(`没找到业务方向「${direction}」`);

  const lines = await executeOnesApi({ path: '/api/ptree/get_businesslines', params: { business_direction_id: dir.id }, cookie });
  const lineList = asList(lines?.datalist);
  const ln = lineList.find(x => x.name === line) || lineList.find(x => x.name.includes(line));
  if (!ln) throw new Error(`业务方向「${direction}」下没找到业务线「${line}」`);

  const out = { business_direction_id: dir.id, business_line_id: ln.id };

  if (system || subSystem) {
    try {
      const systems = await executeOnesApi({ path: '/api/ptree/get_systems', params: { business_line_id: ln.id }, cookie });
      const sysList = asList(systems?.datalist);
      const sys = sysList.find(x => x.name === system) || sysList.find(x => x.name.includes(system || ''));
      if (sys) {
        out.system_id = sys.id;
        if (subSystem) {
          const subs = await executeOnesApi({ path: '/api/ptree/get_subsystems', params: { system_id: sys.id }, cookie });
          const subList = asList(subs?.datalist);
          const sub = subList.find(x => x.name === subSystem) || subList.find(x => x.name.includes(subSystem));
          if (sub) out.sub_system_id = sub.id;
        }
      }
    } catch {
      // 系统和子系统只是锦上添花，解析失败不影响创建
    }
  }
  return out;
}

export async function resolveLevel({ direction, line, system, subSystem, cookie } = {}) {
  const tree = {
    businessDirections: [],
    businessLines: [],
    systems: [],
    subSystems: []
  };
  const pick = async (list, name, label) => {
    if (!list.length) throw new Error(`没能解析${label}「${name}」`);
    const exact = list.find(x => x.name === name);
    if (exact) return exact.id;
    const fuzzy = list.filter(x => x.name.includes(name));
    if (fuzzy.length === 1) return fuzzy[0].id;
    if (fuzzy.length > 1) throw new Error(`${label}「${name}」匹配到多个：${fuzzy.slice(0, 6).map(x => x.name).join('、')}`);
    throw new Error(`没找到${label}「${name}」`);
  };
  const dirs = await executeOnesApi({ path: '/api/ptree/get_business_directions', cookie });
  tree.businessDirections = asList(dirs?.datalist);
  const directionId = await pick(tree.businessDirections, direction, '业务方向');
  const lines = await executeOnesApi({ path: '/api/ptree/get_businesslines', params: { business_direction_id: directionId }, cookie });
  tree.businessLines = asList(lines?.datalist);
  const lineId = await pick(tree.businessLines, line, '业务线');
  const sys = await executeOnesApi({ path: '/api/ptree/get_systems', params: { business_line_id: lineId }, cookie });
  tree.systems = asList(sys?.datalist);
  const systemId = await pick(tree.systems, system, '系统');
  const subs = await executeOnesApi({ path: '/api/ptree/get_subsystems', params: { system_id: systemId }, cookie });
  tree.subSystems = asList(subs?.datalist);
  const subId = await pick(tree.subSystems, subSystem, '子系统');
  return { business_direction_id: directionId, business_line_id: lineId, system_id: systemId, sub_system_id: subId };
}

// ------------------------------------------------------------------- 写入 ----

/** 新建需求：不落库，只组装并校验必填项 */
export function buildRequirementPayload(opts = {}) {
  const {
    title, desc, requireType = '产品需求', requireLabel = '常规需求', priority = 'P2',
    level, pm = [], project, sprintId, notest = '不免测',
    safetyRisk = ['无'], safetyRiskFunctions = ['不包含以上业务功能'], requirementUrl, followers = []  } = opts;

  const missing = [];
  if (!String(title || '').trim()) missing.push('--title 需求标题');
  if (!level?.business_direction_id) missing.push('--level 业务方向/业务线/系统/子系统');
  if (!pm.length) missing.push('--pm 产品经理');
  if (!priority) missing.push('--priority');
  if (!safetyRisk.length) missing.push('--safety-risk');
  // ONES 要求「涉及的业务功能」二选一：要么列出具体功能，要么显式声明「不包含以上业务功能」
  if (!safetyRiskFunctions.length) missing.push('--with-safety-func（声明不涉及上述业务功能）');
  const needsProject = !['事务型需求'].includes(requireType);
  if (needsProject && !project?.mProjectId) missing.push('--project 关联项目（产研需求必须关联项目）');
  if (missing.length) throw new Error(`新建需求缺少必填项：${missing.join('；')}`);

  const payload = {
    title: String(title).trim(),
    desc: desc ? `<p>${String(desc)}</p>` : '<p></p>',
    require_type: requireType,
    require_label: requireLabel,
    priority,
    ...level,
    pm,
    safety_risk: safetyRisk,
    safety_risk_functions: safetyRiskFunctions,
    notest,
    followers
  };
  if (project?.mProjectId) payload.m_project_id = project.mProjectId;
  if (sprintId !== undefined && sprintId !== null && sprintId !== '') payload.sprint_id = Number(sprintId);
  if (requirementUrl) payload.requirement_url = requirementUrl;
  return payload;
}

/** 新建缺陷：不落库，只组装并校验必填项 */
export function buildBugPayload(opts = {}) {
  const {
    summary, priority = 'P2', bugType = '测试阶段', findWay = '手工测试',
    resolver, requireId, category = '功能逻辑', level, desc, attachments = []
  } = opts;
  const missing = [];
  if (!String(summary || '').trim()) missing.push('--summary 缺陷标题');
  if (!priority) missing.push('--priority');
  if (!bugType) missing.push('--type 缺陷类型');
  if (!findWay) missing.push('--find-way 发现方式');
  if (!resolver) missing.push('--resolver 处理人');
  if (missing.length) throw new Error(`新建缺陷缺少必填项：${missing.join('；')}`);

  const payload = {
    summary: String(summary).trim(),
    priority,
    bug_type: bugType,
    find_way: findWay,
    resolver
  };
  if (category) payload.category = category;
  if (requireId) payload.require_id = Number(requireId);
  if (level) Object.assign(payload, level);
  if (desc) payload.desc = String(desc);
  if (attachments.length) payload.attachments = attachments;
  return payload;
}

export async function createRequirement(payload, { cookie } = {}) {
  const body = await executeOnesApi({
    path: '/api/requirements/save_requirement',
    method: 'POST',
    postBody: payload,
    cookie,
    isReadOnly: false
  });
  const id = Number(body);
  return { id: Number.isFinite(id) ? id : null, url: Number.isFinite(id) ? onesUrl('requirement', id) : '' };
}

export async function createBug(payload, { cookie } = {}) {
  const body = await executeOnesApi({
    path: '/api/bug/saveBug',
    method: 'POST',
    postBody: payload,
    cookie,
    isReadOnly: false
  });
  const id = Number(body);
  return { id: Number.isFinite(id) ? id : null, url: Number.isFinite(id) ? onesUrl('bug', id) : '' };
}

/**
 * 缺陷工时（排期）payload。
 * 后端 save_hour 强制 man_hour + end_time；start_time 可选（不传则沿用缺陷当前时间）。
 * 注意：缺陷没有独立的「阶段排期」概念，工时就是它自己的排期。
 */
export function buildBugHourPayload(bugId, { manHours, start, end } = {}) {
  const id = Number(bugId);
  // id 允许为 0：新建缺陷尚未拿到 ID 时先出预审单，提交前再填
  if (!Number.isFinite(id) || id < 0) throw new Error('缺陷工时需要有效的缺陷 ID');
  const hours = Number(manHours);
  if (!Number.isFinite(hours) || hours < 0) throw new Error('--man-hour 必须是 ≥ 0 的数字，例如 --man-hour 0.2');
  if (!end) throw new Error('缺陷工时需要 --end 完成时间（服务端强制 end_time）');

  const payload = { man_hour: hours, end_time: String(end) };
  if (id > 0) payload.id = id;
  if (start) payload.start_time = String(start);
  const changes = { manHour: hours, end: String(end) };
  if (start) changes.start = String(start);
  return { payload, changes };
}

export async function saveBugHour(payload, { cookie } = {}) {
  const id = Number(payload?.id);
  if (!Number.isFinite(id) || id <= 0) throw new Error('保存缺陷工时需要有效的缺陷 ID');
  const body = await executeOnesApi({
    path: '/api/bug/save_hour',
    method: 'POST',
    postBody: payload,
    cookie,
    isReadOnly: false
  });
  return { ok: body !== false, raw: body };
}


const SCHEDULE_FIELDS = {
  developStart: 'develop_start_time',
  developEnd: 'develop_end_time',
  testStart: 'test_start_time',
  testEnd: 'test_end_time',
  submitTest: 'submit_test_time',
  online: 'online_time'
};

/** 排期字段的中文名，供 Diff 展示 */
export const SCHEDULE_LABELS = {
  developStart: '开发开始',
  developEnd: '开发结束',
  testStart: '测试开始',
  testEnd: '测试结束',
  submitTest: '计划提测',
  online: '计划上线'
};

export function buildSchedulePayload(requireId, changes = {}) {
  const payload = { require_id: Number(requireId) };
  const filled = {};
  for (const [key, field] of Object.entries(SCHEDULE_FIELDS)) {
    const v = changes[key];
    if (v === undefined || v === null || v === '') continue;
    payload[field] = String(v);
    filled[key] = String(v);
  }
  if (!Object.keys(filled).length) {
    throw new Error(`没有要修改的排期字段（可用：${Object.keys(SCHEDULE_FIELDS).join(' / ')}）`);
  }
  return { payload, changes: filled };
}

export async function updateSchedule(requireId, changes, { cookie } = {}) {
  const { payload, changes: filled } = buildSchedulePayload(requireId, changes);
  // 注意：body 里不能带 estimatable（服务端报 Unknown column）
  const body = await executeOnesApi({
    path: '/api/requirements/updateSchedule',
    method: 'POST',
    postBody: payload,
    cookie,
    isReadOnly: false
  });
  return { requireId: Number(requireId), applied: filled, response: body };
}

export async function moveRequirementToIteration(requireIds, sprintId, { cookie } = {}) {
  const ids = asList(requireIds).map(Number).filter(n => Number.isFinite(n));
  if (!ids.length) throw new Error('至少需要一个需求 ID');
  const body = await executeOnesApi({
    path: '/api/requirements/moveReq',
    method: 'POST',
    postBody: { sprint_id: Number(sprintId), require_ids: ids },
    cookie,
    isReadOnly: false
  });
  return { sprintId: Number(sprintId), requireIds: ids, response: body };
}

/** 通用状态机流转（删除 / 评审 / 完成 / 需求取消 等）。高危，调用方必须二次确认 */
/** 缺陷详情：get_bugs 按 id 精确查，返回归一化结果 + 状态机事件 */
export async function getBugDetail(bugId, { cookie } = {}) {
  const data = await executeOnesApi({
    path: '/api/bug/get_bugs',
    method: 'POST',
    postBody: { id: Number(bugId), page: 1, limit: 1 },
    cookie
  });
  const row = (data?.datalist || [])[0];
  if (!row) throw new Error(`缺陷 ${bugId} 不存在或已被删除`);
  const fsmEvents = row.fsm?.events || (row.fsm?.ets || []).map(e => e.event) || [];
  const eventTargets = row.fsm?.et || {};
  return {
    ...normalizeBug(row),
    statusCode: row.status,
    manHour: row.man_hour,
    startTime: row.start_time,
    endTime: row.end_time,
    operateList: row.operate_list || {},
    events: fsmEvents,
    transitions: fsmEvents.map(ev => ({ event: ev, target: eventTargets[ev] ?? '' }))
  };
}

export async function changeStatus({ type, id, ids, event, extParam = null, cookie } = {}) {  if (!type || !event) throw new Error('changeStatus 需要 type 与 event');
  const postBody = { type, event };
  if (ids?.length) postBody.ids = ids.map(Number);
  else if (id) postBody.id = Number(id);
  else throw new Error('changeStatus 需要 id 或 ids');
  if (extParam) postBody.ext_param = extParam;
  const body = await executeOnesApi({
    path: '/api/fsm/change_status',
    method: 'POST',
    postBody,
    cookie,
    isReadOnly: false
  });
  return body;
}

// ------------------------------------------------------------------- 差异 ----

/** 生成 [字段, 变更前, 变更后] 三元组，用于 Dry-Run Diff 表 */
export function diffFields(before = {}, after = {}, labels = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const rows = [];
  for (const key of keys) {
    const a = before?.[key] ?? '';
    const b = after?.[key] ?? '';
    rows.push({ key, label: labels[key] || key, before: a, after: b, changed: String(a) !== String(b) });
  }
  return rows;
}
