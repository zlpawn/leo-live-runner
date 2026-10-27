/**
 * 日志查询：断言链路是否生效的核心手段。
 *
 * 支持两种来源：
 * 1. 本地文件（本地起服务时）
 * 2. 测试环境 Loki（未本地起服务时）
 *
 * 用法：
 *   const logs = createLogSource({ file: '/tmp/iot-logs/app.log' }, ctx);
 *   const hit = await logs.search('AutoOrderDispatchNotify: Link Push 发送成功', { since: 5*60*1000 });
 */
import fs from 'node:fs';

export function createLogSource({ file, testApp } = {}) {
  return {
    /**
     * 在最近 since 毫秒内搜索关键词
     */
    async search(keyword, { since = 10 * 60 * 1000 } = {}) {
      if (file) return searchFile(file, keyword, since);
      if (testApp) return searchLoki(testApp, keyword, since);
      return { ok: false, reason: 'no_log_source', message: '未配置日志源（file 或 testApp）' };
    },

    /**
     * 断言「出现」或「不出现」
     */
    async expect(keyword, { since, shouldExist = true } = {}) {
      const r = await this.search(keyword, { since });
      if (!r.ok) {
        // 没有日志源时返回 skipped，不当作断言失败
        return {
          ok: true,
          skipped: true,
          name: `${shouldExist ? '出现' : '不出现'}「${keyword}」`,
          detail: `未配置日志源，跳过断言（用 --log-file 或 --test-app 启用）`
        };
      }
      const found = r.matches.length > 0;
      return {
        ok: shouldExist ? found : !found,
        name: `${shouldExist ? '出现' : '不出现'}「${keyword}」`,
        detail: `命中 ${r.matches.length} 条`
      };
    }
  };
}

function searchFile(file, keyword, since) {
  try {
    if (!fs.existsSync(file)) {
      return { ok: false, reason: 'file_not_found', message: `日志文件不存在: ${file}`, matches: [] };
    }
    const cutoff = Date.now() - since;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const matches = [];

    for (const line of lines) {
      if (!line.includes(keyword)) continue;
      // 尝试解析时间前缀（格式：2026/10/27-10:00:00:000 或 2026-10-27 10:00:00）
      const t = parseLineTime(line);
      if (t && t < cutoff) continue;
      matches.push(line.slice(0, 500));
    }
    return { ok: true, matches };
  } catch (e) {
    return { ok: false, reason: 'read_error', message: e.message, matches: [] };
  }
}

function parseLineTime(line) {
  const m1 = line.match(/(\d{4})\/(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})/);
  if (m1) {
    const [, y, mo, d, h, mi, s] = m1;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
  }
  const m2 = line.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m2) {
    const [, y, mo, d, h, mi, s] = m2;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
  }
  return null;
}

async function searchLoki(app, keyword, since) {
  // 委托给 leo-live-inspector 的 test_log_query（如已安装）
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const script = `${process.env.HOME}/.zcode/skills/leo-live-inspector/scripts/test_log_query.js`;
  if (!fs.existsSync(script)) {
    return {
      ok: false, reason: 'inspector_not_installed',
      message: '未找到 leo-live-inspector，无法查测试环境日志。请改用本地 file 日志源。',
      matches: []
    };
  }

  const minutes = Math.max(1, Math.ceil(since / 60000));
  try {
    const { stdout } = await run('node', [script, app, '-q', keyword, '-t', `${minutes}m`, '-n', '20', '-f', 'json'], { timeout: 60000 });
    const data = JSON.parse(stdout);
    return { ok: true, matches: (data.logs || []).map(l => l.message || '') };
  } catch (e) {
    return { ok: false, reason: 'loki_error', message: e.message.slice(0, 200), matches: [] };
  }
}
