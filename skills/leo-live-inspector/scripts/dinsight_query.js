#!/usr/bin/env node

/**
 * 🧠 Leo Live Inspector - Dinsight 自然语言大数据探查引擎
 *
 * 功能：
 *   1. 复用 Chrome 插件复制的 prd-assistant-token-prod，直连 Dinsight Agent 流式查数；
 *   2. 支持读取本地持久化凭证 (~/.shrimp/skills/live-inspector/dinsight_cookie.json)；
 *   3. 自动创建 thread 并调用 /api/threads/{id}/runs/stream；
 *   4. 从 SSE 中提取最终回答、工具调用与错误，供本地大模型二次分析。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DINSIGHT_ASSISTANT_TOKEN_KEY,
  DINSIGHT_CSRF_TOKEN_KEY,
  DINSIGHT_DEFAULT_ASSISTANT_ID,
  DINSIGHT_DEFAULT_CLUSTER_ID,
  DINSIGHT_DEFAULT_MODEL,
  DINSIGHT_DEFAULT_MODE,
  dinsightCredentialFilePath,
  fetchDinsightMe,
  loadDinsightCredentials,
  parseDinsightCredentialInput,
  saveDinsightCredentials,
  streamDinsightQuestion
} from './common/dinsight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function chromeExtensionPath() {
  const agentsPath = path.join(os.homedir(), '.agents', 'skills', 'leo-live-inspector', 'resources', 'chrome_extension');
  return fs.existsSync(agentsPath) ? agentsPath : path.join(__dirname, '..', 'resources', 'chrome_extension');
}

function printTokenGuide() {
  const extPath = chromeExtensionPath();
  console.log(`
================================================================
🔑 如何获取 Dinsight 凭证？
================================================================

【最推荐】复制 Cookie 标头（一次齐，AI 会自动筛选）
----------------------------------------------------------------
1. 打开已登录页面: https://dinsight.ke.com/
2. 点击 Leo cookie.txt Locally，顶部域名改成 ke.com
3. 点击【复制 Cookie 标头】，把整串 k1=v1; k2=v2 发给 AI
4. AI 后台执行 --set-token 保存。整包会太大，脚本只保留：
   prd-assistant-token-prod / access_token / login_ucid / security_ticket / csrf_token

【次选】只复制主 Token
----------------------------------------------------------------
复制 【prd-assistant-token-prod】 发给 AI。若 401，再改复制 Cookie 标头。

插件目录: ${extPath}
================================================================
`);
}

function printUsage() {
  console.log(`
🧠 Leo Dinsight Query Tool (自然语言大数据探查)
用法:
  node scripts/dinsight_query.js "<自然语言问题>" [options]
  node scripts/dinsight_query.js --set-token <prd-assistant-token-prod>

参数说明:
  <自然语言问题>     直接向 Dinsight Agent 提问，例如: 近7天北京成交量

选项 (Options):
  --set-token <token>  保存复制来的 ${DINSIGHT_ASSISTANT_TOKEN_KEY}
  --set-csrf <token>   仅在需要时追加保存 ${DINSIGHT_CSRF_TOKEN_KEY}
  --token <token>      单次临时覆盖主 Token
  --csrf <token>       单次临时覆盖 CSRF
  --whoami             只验证登录态，不发起提问
  --json               输出原始 SSE / JSON
  --cluster <id>       集群 ID，默认 ${DINSIGHT_DEFAULT_CLUSTER_ID} (公共集群)
  --assistant <id>     Agent ID，默认 ${DINSIGHT_DEFAULT_ASSISTANT_ID}

示例:
  node scripts/dinsight_query.js --set-token prd-xxxx
  node scripts/dinsight_query.js "帮我查近7天北京成交量"
  node scripts/dinsight_query.js --whoami
`);
}

function takeFlag(args, name) {
  const idx = args.findIndex(arg => arg === name);
  if (idx === -1 || !args[idx + 1]) return null;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

function hasFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function mergeCredentials(base, overrides = {}) {
  return {
    token: overrides.token || base.token || '',
    csrfToken: overrides.csrfToken || base.csrfToken || '',
    cookie: overrides.cookie || base.cookie || ''
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const setToken = takeFlag(args, '--set-token');
  if (setToken) {
    const parsed = parseDinsightCredentialInput(setToken);
    const existing = loadDinsightCredentials();
    const saved = saveDinsightCredentials({
      token: parsed.token || setToken.trim(),
      csrfToken: parsed.csrfToken || existing.csrfToken,
      cookie: parsed.cookie
    });
    if (!saved) {
      console.error('❌ 保存 Dinsight Token 失败');
      process.exit(1);
    }
    const kept = (parsed.cookie || '').split('; ').map(part => part.split('=')[0]).filter(Boolean);
    console.log(`✅ Dinsight 凭证已保存至: ${dinsightCredentialFilePath()}`);
    console.log(`🔐 实际保留 Cookie: ${kept.join(', ') || DINSIGHT_ASSISTANT_TOKEN_KEY}`);
    if (kept.length > 1) {
      console.log('ℹ️ 已丢弃无关 Cookie，避免请求头过大。');
    }
    process.exit(0);
  }

  const setCsrf = takeFlag(args, '--set-csrf');
  if (setCsrf) {
    const existing = loadDinsightCredentials();
    if (!existing.token && !existing.cookie) {
      console.error('❌ 还没有主 Token。请先复制 prd-assistant-token-prod 并执行 --set-token');
      printTokenGuide();
      process.exit(1);
    }
    saveDinsightCredentials({
      token: existing.token,
      csrfToken: setCsrf.trim(),
      cookie: existing.cookie
    });
    console.log(`✅ Dinsight CSRF 已追加保存至: ${dinsightCredentialFilePath()}`);
    process.exit(0);
  }

  const tempToken = takeFlag(args, '--token');
  const tempCsrf = takeFlag(args, '--csrf');
  const clusterId = Number(takeFlag(args, '--cluster') || DINSIGHT_DEFAULT_CLUSTER_ID);
  const assistantId = takeFlag(args, '--assistant') || DINSIGHT_DEFAULT_ASSISTANT_ID;
  const outputJson = hasFlag(args, '--json');
  const whoami = hasFlag(args, '--whoami');
  const question = args.filter(arg => !arg.startsWith('-')).join(' ').trim();

  const credentials = mergeCredentials(loadDinsightCredentials(), {
    token: tempToken,
    csrfToken: tempCsrf,
    cookie: tempToken ? parseDinsightCredentialInput(tempToken).cookie : ''
  });

  if (!credentials.token && !credentials.cookie) {
    console.error('❌ 未检测到 Dinsight 凭证 (prd-assistant-token-prod)！');
    printTokenGuide();
    process.exit(1);
  }

  const me = await fetchDinsightMe(credentials);
  if (me.statusCode === 401 || me.statusCode === 302) {
    console.error('❌ Dinsight 登录态已失效，请重新复制 prd-assistant-token-prod');
    printTokenGuide();
    process.exit(1);
  }
  if (me.statusCode >= 400) {
    console.error(`❌ 验证 Dinsight 登录态失败: HTTP ${me.statusCode} ${me.error || me.raw.slice(0, 200)}`);
    process.exit(1);
  }

  if (whoami || !question) {
    if (outputJson) {
      console.log(JSON.stringify(me.json || me.raw, null, 2));
      return;
    }
    const profile = me.json || {};
    console.log(`✅ 已登录 Dinsight: ${profile.email || profile.ucid || 'ok'} (ucid=${profile.ucid || '-'})
`);
    if (!question) {
      printUsage();
    }
    return;
  }

  const result = await streamDinsightQuestion(credentials, question, {
    clusterId,
    assistantId,
    modelName: DINSIGHT_DEFAULT_MODEL,
    mode: DINSIGHT_DEFAULT_MODE,
    timeout: 180000
  });

  if (result.statusCode === 401 || result.statusCode === 302) {
    console.error('❌ Dinsight 登录态已失效，请重新复制 prd-assistant-token-prod');
    printTokenGuide();
    process.exit(1);
  }
  if (result.statusCode === 403 && /csrf|CSRF/i.test(result.raw || '')) {
    console.error('❌ CSRF 校验失败。请再复制插件列表里的 csrf_token，然后执行 --set-csrf');
    printTokenGuide();
    process.exit(1);
  }
  if (result.statusCode >= 400) {
    console.error(`❌ Dinsight 提问失败: HTTP ${result.statusCode} ${(result.raw || result.error || '').slice(0, 300)}`);
    process.exit(1);
  }

  if (outputJson) {
    console.log(JSON.stringify({
      threadId: result.threadId,
      status: result.statusCode,
      summary: result.summary,
      raw: result.raw
    }, null, 2));
    return;
  }

  const summary = result.summary || {};
  console.log(`🧠 Dinsight 查询完成 | thread=${result.threadId || '-'} | run=${summary.runId || '-'}
`);
  if (summary.tools?.length) {
    console.log(`🛠️ 使用工具: ${summary.tools.join(', ')}
`);
  }
  if (summary.errors?.length) {
    console.log(`⚠️ 错误: ${summary.errors.join(' | ')}
`);
  }
  console.log(summary.answer || summary.texts?.slice(-1)[0] || result.raw.slice(0, 2000));
  console.log('');
}

main().catch(err => {
  console.error('执行异常:', err);
  process.exit(1);
});
