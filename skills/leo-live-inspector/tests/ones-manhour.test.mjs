import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONES_MANHOUR_PAGE,
  MANHOUR_STATUS,
  MANHOUR_TARGET,
  normalizeManhourDays
} from '../scripts/common/ones.js';
import { parseArgs as parseQueryArgs } from '../scripts/ones_query.js';

test('manhour: 基础常量与页面地址', () => {
  assert.equal(MANHOUR_TARGET, 1);
  assert.equal(ONES_MANHOUR_PAGE, 'https://ones.ke.com/profile/manhour');
  assert.equal(MANHOUR_STATUS.full.label, '已打满');
  assert.equal(MANHOUR_STATUS.pending.label, '待打');
});

test('manhour: 工作日按 1 人天判满 / 不足 / 未打 / 超出', () => {
  const { days } = normalizeManhourDays([
    { day: '2026-11-02', week_day: '一', is_workday: 1, man_hour: 1 },
    { day: '2026-11-03', week_day: '二', is_workday: 1, man_hour: 0.5 },
    { day: '2026-11-04', week_day: '三', is_workday: 1, man_hour: 0 },
    { day: '2026-11-05', week_day: '四', is_workday: 1, man_hour: 1.4 }
  ], { today: '2026-11-10' });

  assert.equal(days[0].status, 'full');
  assert.equal(days[1].status, 'short');
  assert.equal(days[2].status, 'missing');
  assert.equal(days[3].status, 'over');
});

test('manhour: 非工作日（周末 / 法定节假日）区分假与加班', () => {
  const { days, summary } = normalizeManhourDays([
    { day: '2026-10-01', week_day: '四', is_workday: 0, man_hour: 0 },
    { day: '2026-10-02', week_day: '五', is_workday: 0, man_hour: 0.5 },
    { day: '2026-10-10', week_day: '六', is_workday: 1, man_hour: 1 } // 周六调休上班
  ], { today: '2026-10-15' });

  assert.equal(days[0].status, 'off');
  assert.equal(days[1].status, 'overtime');
  assert.equal(days[2].status, 'full');
  assert.equal(summary.workdays, 1);
  assert.equal(summary.off, 1);
  assert.equal(summary.overtime, 1);
});

test('manhour: 未来工作日标记为 pending，不计入未打告警', () => {
  const { days, summary } = normalizeManhourDays([
    { day: '2026-11-24', week_day: '二', is_workday: 1, man_hour: 1 },
    { day: '2026-11-25', week_day: '三', is_workday: 1, man_hour: 0 },
    { day: '2026-11-26', week_day: '四', is_workday: 1, man_hour: 0 },
    { day: '2026-11-28', week_day: '六', is_workday: 0, man_hour: 0 }
  ], { today: '2026-11-25' });

  const todayRow = days.find(d => d.date === '2026-11-25');
  const futureWork = days.find(d => d.date === '2026-11-26');
  const futureWeekend = days.find(d => d.date === '2026-11-28');

  assert.equal(todayRow.isToday, true);
  assert.equal(todayRow.status, 'missing');
  assert.equal(futureWork.isFuture, true);
  assert.equal(futureWork.status, 'pending');
  assert.equal(futureWeekend.status, 'off');

  assert.equal(summary.workdays, 2); // 只统计截至今天的 2 个工作日
  assert.equal(summary.full, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.expected, 2);
  assert.equal(summary.gap, 1);
  assert.equal(summary.unfilled.length, 1);
  assert.equal(summary.unfilled[0].date, '2026-11-25');
});

test('manhour: 超打时 gap 为负数并列入 unfilled', () => {
  const { summary } = normalizeManhourDays([
    { day: '2026-11-02', week_day: '一', is_workday: 1, man_hour: 1 },
    { day: '2026-11-03', week_day: '二', is_workday: 1, man_hour: 1.5 }
  ], { today: '2026-11-05' });

  assert.equal(summary.expected, 2);
  assert.equal(summary.manHours, 2.5);
  assert.equal(summary.gap, -0.5);
  assert.equal(summary.over, 1);
  assert.equal(summary.unfilled.length, 1);
  assert.equal(summary.unfilled[0].status, 'over');
});

test('manhour: 乱序输入自动按日期升序排列，空输入安全返回', () => {
  const { days } = normalizeManhourDays([
    { day: '2026-11-05', week_day: '四', is_workday: 1, man_hour: 1 },
    { day: '2026-11-02', week_day: '一', is_workday: 1, man_hour: 1 }
  ], { today: '2026-11-10' });
  assert.deepEqual(days.map(d => d.date), ['2026-11-02', '2026-11-05']);

  const empty = normalizeManhourDays(null, { today: '2026-11-10' });
  assert.equal(empty.days.length, 0);
  assert.equal(empty.summary.workdays, 0);
  assert.equal(empty.summary.gap, 0);
});

test('manhour: ones_query parseArgs 支持 manhour --all 与 bugs --require-id', () => {
  const mh = parseQueryArgs(['manhour', '--from', '2026-11-01', '--to', '2026-11-30', '--all', '--json']);
  assert.equal(mh.command, 'manhour');
  assert.equal(mh.from, '2026-11-01');
  assert.equal(mh.to, '2026-11-30');
  assert.equal(mh.all, true);
  assert.equal(mh.json, true);

  const bugs = parseQueryArgs(['bugs', '--require-id', '50564297', '--summary', '钥匙']);
  assert.equal(bugs.command, 'bugs');
  assert.equal(bugs.requireId, '50564297');
  assert.equal(bugs.summary, '钥匙');
});
