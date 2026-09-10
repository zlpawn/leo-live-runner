import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestHttp } from './http.js';
import { SHRIMP_LIVE_DIR, ensureShrimpLiveDir, loadCookie, saveCookie } from './credentials.js';

export const DINSIGHT_ASSISTANT_TOKEN_KEY = 'prd-assistant-token-prod';
export const DINSIGHT_CSRF_TOKEN_KEY = 'csrf_token';
export const DINSIGHT_COOKIE_FILE = 'dinsight_cookie.json';
export const DINSIGHT_API_BASE = 'https://api-dinsight.ke.com';
export const DINSIGHT_DEFAULT_CLUSTER_ID = 100;
export const DINSIGHT_DEFAULT_SPACE_ID = 0;
export const DINSIGHT_DEFAULT_ASSISTANT_ID = 'odin-data-agent-claude';
export const DINSIGHT_DEFAULT_MODEL = 'GLM-5.2';
export const DINSIGHT_DEFAULT_MODE = 'flash';
export const DINSIGHT_COOKIE_KEYS = [
  DINSIGHT_ASSISTANT_TOKEN_KEY,
  'access_token',
  'login_ucid',
  'security_ticket',
  DINSIGHT_CSRF_TOKEN_KEY
];

const CREDENTIAL_JSON_KEYS = ['token', 'prd-assistant-token-prod', 'prd_assistant_token_prod'];

function readCookieMap(cookieStr) {
  const map = new Map();
  for (const part of String(cookieStr || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

function parseNetscapeCookieMap(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0] || '';
    const name = parts[5].trim();
    const value = parts[6].trim();
    if (!name) continue;
    if (domain.includes('ke.com') || domain.includes('dinsight') || domain === '') {
      map.set(name, value);
    }
  }
  return map;
}

function cookieMapToHeader(map) {
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function slimCookieMap(map) {
  const slim = new Map();
  for (const name of DINSIGHT_COOKIE_KEYS) {
    if (map.has(name) && map.get(name)) slim.set(name, map.get(name));
  }
  return slim;
}

function credentialFromMap(map) {
  const slim = slimCookieMap(map);
  const token = slim.get(DINSIGHT_ASSISTANT_TOKEN_KEY) || '';
  const csrfToken = slim.get(DINSIGHT_CSRF_TOKEN_KEY) || '';
  return { token, csrfToken, cookie: cookieMapToHeader(slim) };
}

export function buildDinsightCookieHeader({ token = '', csrfToken = '', extraCookie = '' } = {}) {
  const map = readCookieMap(extraCookie);
  if (token) map.set(DINSIGHT_ASSISTANT_TOKEN_KEY, token);
  if (csrfToken) map.set(DINSIGHT_CSRF_TOKEN_KEY, csrfToken);
  return cookieMapToHeader(slimCookieMap(map));
}

export function parseDinsightCredentialInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { token: '', csrfToken: '', cookie: '' };

  if (text.includes('\t') && /prd-assistant-token-prod|csrf_token/.test(text)) {
    return credentialFromMap(parseNetscapeCookieMap(text));
  }

  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const token = CREDENTIAL_JSON_KEYS.map(key => data[key]).find(Boolean) || '';
      const csrfToken = data.csrfToken || data.csrf_token || '';
      const cookie = data.cookie || buildDinsightCookieHeader({ token, csrfToken });
      if (token || cookie) {
        const map = readCookieMap(cookie);
        if (token) map.set(DINSIGHT_ASSISTANT_TOKEN_KEY, token);
        if (csrfToken) map.set(DINSIGHT_CSRF_TOKEN_KEY, csrfToken);
        return credentialFromMap(map);
      }
    } catch {}
  }

  if (text.includes('=')) {
    const map = readCookieMap(text);
    if (map.has(DINSIGHT_ASSISTANT_TOKEN_KEY) || map.has(DINSIGHT_CSRF_TOKEN_KEY)) {
      return credentialFromMap(map);
    }
    const match = text.match(new RegExp(`${DINSIGHT_ASSISTANT_TOKEN_KEY}=([^;]+)`));
    if (match) {
      return credentialFromMap(readCookieMap(text));
    }
  }

  return {
    token: text,
    csrfToken: '',
    cookie: buildDinsightCookieHeader({ token: text })
  };
}

export function saveDinsightCredentials(input, extraFields = {}) {
  const parsed = typeof input === 'string' ? parseDinsightCredentialInput(input) : {
    token: input.token || '',
    csrfToken: input.csrfToken || '',
    cookie: input.cookie || buildDinsightCookieHeader(input)
  };
  if (!parsed.token && !parsed.cookie) return false;
  return saveCookie({
    jsonFileName: DINSIGHT_COOKIE_FILE,
    cookieStr: parsed.cookie,
    extraFields: {
      token: parsed.token,
      csrfToken: parsed.csrfToken,
      ...extraFields
    }
  });
}

export function loadDinsightCredentials({
  envVar = 'DINSIGHT_TOKEN',
  cookieEnvVar = 'DINSIGHT_COOKIE'
} = {}) {
  if (process.env[cookieEnvVar]) {
    return parseDinsightCredentialInput(process.env[cookieEnvVar]);
  }
  if (process.env[envVar]) {
    return parseDinsightCredentialInput(process.env[envVar]);
  }

  const jsonPath = path.join(SHRIMP_LIVE_DIR, DINSIGHT_COOKIE_FILE);
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const parsed = parseDinsightCredentialInput(JSON.stringify(data));
      if (parsed.token || parsed.cookie) return parsed;
    } catch {}
  }

  const cookieStr = loadCookie({
    jsonFileName: DINSIGHT_COOKIE_FILE,
    domainFilter: 'ke.com',
    downloadCandidates: [
      'cookies-ke.com.txt',
      'cookies-dinsight.ke.com.txt',
      'cookies-api-dinsight.ke.com.txt'
    ]
  });
  if (cookieStr) {
    const parsed = parseDinsightCredentialInput(cookieStr);
    if (parsed.token || parsed.cookie) {
      saveDinsightCredentials(parsed);
      return parsed;
    }
  }

  return { token: '', csrfToken: '', cookie: '' };
}

export function summarizeDinsightSse(raw) {
  const events = [];
  const texts = [];
  const answerParts = [];
  const tools = new Set();
  const errors = [];
  let runId = '';
  let threadId = '';

  const blocks = String(raw || '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split(/\n/);
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const dataText = dataLines.join('\n');
    let data = dataText;
    try { data = JSON.parse(dataText); } catch {}
    events.push({ event, data });

    if (event === 'metadata' && data && typeof data === 'object') {
      runId = data.run_id || runId;
      threadId = data.thread_id || threadId;
    }

    const stack = [data];
    while (stack.length) {
      const cur = stack.pop();
      if (Array.isArray(cur)) {
        stack.push(...cur);
        continue;
      }
      if (!cur || typeof cur !== 'object') continue;
      if (cur.type === 'AIMessageChunk' || cur.type === 'ai' || cur.type === 'assistant') {
        if (typeof cur.content === 'string' && cur.content) answerParts.push(cur.content);
        else if (Array.isArray(cur.content)) {
          for (const part of cur.content) {
            if (typeof part === 'string' && part) answerParts.push(part);
            else if (part && typeof part.text === 'string' && part.text) answerParts.push(part.text);
          }
        }
      } else if (cur.type !== 'human' && cur.type !== 'text' && typeof cur.text === 'string' && cur.text.trim()) {
        texts.push(cur.text.trim());
      }
      if (typeof cur.name === 'string' && /mcp__|execute_sql|query_sql|metric_|dinsight_/.test(cur.name)) tools.add(cur.name);
      if (Array.isArray(cur.tools)) {
        for (const tool of cur.tools) {
          if (typeof tool === 'string') tools.add(tool);
        }
      }
      if (typeof cur.error === 'string') errors.push(cur.error);
      for (const value of Object.values(cur)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  const uniqueTexts = [...new Set(texts)];
  return {
    runId,
    threadId,
    tools: [...tools],
    errors,
    texts: uniqueTexts,
    answer: answerParts.join('').trim() || uniqueTexts.filter(text => !/^只回复/.test(text) && !text.startsWith('查表 ')).slice(-1)[0] || '',
    eventCount: events.length
  };
}

function dinsightHeaders(credentials, extra = {}) {
  const headers = {
    Origin: 'https://dinsight.ke.com',
    Referer: 'https://dinsight.ke.com/',
    Accept: 'application/json, text/event-stream',
    Cookie: credentials.cookie || buildDinsightCookieHeader(credentials),
    ...extra
  };
  if (credentials.csrfToken) headers['X-CSRF-Token'] = credentials.csrfToken;
  return headers;
}

async function dinsightRequest(pathname, { method = 'GET', credentials, body = null, timeout = 20000 } = {}) {
  const url = new URL(pathname, `${DINSIGHT_API_BASE}/`);
  const res = await requestHttp({
    protocol: 'https:',
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method,
    timeout,
    headers: dinsightHeaders(credentials, body ? { 'Content-Type': 'application/json' } : {})
  }, body);
  return res;
}

export async function fetchDinsightMe(credentials) {
  return dinsightRequest('/api/v1/auth/me', { credentials });
}

export function buildDinsightRunPayload(question, {
  threadId = randomUUID(),
  assistantId = DINSIGHT_DEFAULT_ASSISTANT_ID,
  modelName = DINSIGHT_DEFAULT_MODEL,
  mode = DINSIGHT_DEFAULT_MODE
} = {}) {
  return {
    threadId,
    payload: {
      input: {
        messages: [
          {
            type: 'human',
            content: [{ type: 'text', text: question }]
          }
        ]
      },
      config: { recursion_limit: 1000 },
      context: {
        model_name: modelName,
        mode,
        agent_name: assistantId,
        thinking_enabled: false,
        is_plan_mode: false,
        subagent_enabled: false,
        thread_id: threadId
      },
      stream_mode: ['messages-tuple', 'values', 'updates', 'custom', 'events'],
      stream_subgraphs: true,
      stream_resumable: true,
      assistant_id: assistantId,
      multitask_strategy: 'rollback',
      on_disconnect: 'continue'
    }
  };
}

export async function createDinsightThread(credentials, {
  threadId = randomUUID(),
  clusterId = DINSIGHT_DEFAULT_CLUSTER_ID,
  spaceId = DINSIGHT_DEFAULT_SPACE_ID
} = {}) {
  const res = await dinsightRequest('/api/threads', {
    method: 'POST',
    credentials,
    body: {
      metadata: {},
      thread_id: threadId,
      cluster_id: clusterId,
      space_id: spaceId
    }
  });
  return { ...res, threadId: res.json?.thread_id || threadId };
}

export async function streamDinsightQuestion(credentials, question, options = {}) {
  const created = await createDinsightThread(credentials, options);
  if ((created.statusCode || 0) >= 400) return created;
  const { threadId, payload } = buildDinsightRunPayload(question, {
    threadId: created.threadId,
    assistantId: options.assistantId,
    modelName: options.modelName,
    mode: options.mode
  });
  const res = await dinsightRequest(`/api/threads/${threadId}/runs/stream`, {
    method: 'POST',
    credentials,
    body: payload,
    timeout: options.timeout || 180000
  });
  return {
    ...res,
    threadId,
    summary: summarizeDinsightSse(res.raw)
  };
}

export function dinsightCredentialFilePath() {
  ensureShrimpLiveDir();
  return path.join(SHRIMP_LIVE_DIR, DINSIGHT_COOKIE_FILE);
}

export function dinsightDownloadsHint() {
  return path.join(os.homedir(), 'Downloads', 'cookies-ke.com.txt');
}
