import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = 19528;
const MAX_BODY = 256 * 1024;
let queue = Promise.resolve();
const failure = (code, message) => Object.assign(new Error(message), { code });

export function normalizeCredentialRequest({ url, names } = {}) {
  let target;
  try { target = new URL(url); } catch { throw failure('INVALID_REQUEST', '需要完整的 HTTP(S) 目标 URL'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw failure('INVALID_REQUEST', '凭据目标必须是无用户名密码的 HTTP(S) URL');
  if (names !== undefined && (!Array.isArray(names) || !names.length || names.length > 64 ||
      names.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name))))
    throw failure('INVALID_REQUEST', 'Cookie names 必须为非空名称数组');
  target.search = ''; target.hash = '';
  return { url: target.href, ...(names ? { names: [...new Set(names)] } : {}) };
}

// Validate the browser response again at the local process boundary.
export function cookiesToHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.length > 256 || cookies.some(c => !c ||
      typeof c.name !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(c.name) ||
      typeof c.value !== 'string' || /[\x00-\x20\x7f;]/.test(c.value)))
    throw failure('INVALID_RESULT', '浏览器返回了无效 Cookie');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export function getBrowserCookies(options = {}) {
  let request;
  try {
    if (process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS === 'off')
      throw failure('BROWSER_CREDENTIALS_DISABLED', '浏览器自动获取已关闭');
    request = normalizeCredentialRequest(options);
    if (!Number.isFinite(options.timeoutMs ?? 180000) || (options.timeoutMs ?? 180000) <= 0)
      throw failure('INVALID_REQUEST', '无效的超时时间');
  } catch (err) { return Promise.reject(err); }
  const deadline = Date.now() + (options.timeoutMs ?? 180000);
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const stopWaiting = error => { cancelled = true; cleanup(); reject(error); };
    const abort = () => stopWaiting(failure('CANCELLED', '凭据获取已取消'));
    const timer = setTimeout(() => stopWaiting(failure('RELAY_TIMEOUT', '等待浏览器超时，请打开浏览器并启用插件')), deadline - Date.now());
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const work = queue.then(async () => {
      if (cancelled) return;
      cleanup(); // The active listener now owns its timeout and cancellation.
      try { resolve(await receiveCookies(request, deadline, options.signal)); }
      catch (err) { reject(err); }
    });
    queue = work.catch(reject);
  });
}

function receiveCookies(request, deadline, signal) {
  return new Promise((resolve, reject) => {
    const task = { id: randomUUID(), ...request, expiresAt: deadline };
    let claimed = false;
    let finished = false;
    const sockets = new Set();
    const server = http.createServer(async (req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(JSON.stringify(body));
      };
      const origin = req.headers.origin;
      if (req.headers.host !== `127.0.0.1:${PORT}` ||
          (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) ||
          req.headers['x-leo-credential-relay'] !== '1') return reply(403, { error: 'FORBIDDEN' });
      if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
        return reply(400, { error: 'INVALID_REQUEST' });
      if (!['/credential-relay/poll', '/credential-relay/result'].includes(req.url))
        return reply(404, { error: 'NOT_FOUND' });
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_BODY) { reply(413, { error: 'RESULT_TOO_LARGE' }); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'INVALID_REQUEST' });
        if (req.url.endsWith('/poll')) {
          const available = !claimed && !finished;
          if (available) claimed = true;
          return reply(200, { task: available ? task : null });
        }
        if (body.id !== task.id || !claimed) return reply(409, { error: 'UNKNOWN_TASK' });
        if (finished) return reply(200, { ok: true });
        let error;
        let cookies;
        if (body.error) error = failure('BROWSER_READ_FAILED', '浏览器无法读取凭据，请确认已登录目标网站');
        else {
          cookiesToHeader(body.cookies);
          const target = new URL(request.url);
          cookies = body.cookies.filter(c => {
            const domain = String(c.domain || '').replace(/^\./, '');
            const cookiePath = c.path || '/';
            return domain && (c.hostOnly ? target.hostname === domain :
              target.hostname === domain || target.hostname.endsWith(`.${domain}`)) &&
              (target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)) &&
              (!c.secure || target.protocol === 'https:') && !c.partitionKey &&
              (!c.expirationDate || c.expirationDate * 1000 > Date.now()) &&
              (!request.names || request.names.includes(c.name));
          });
          if (!cookies.length) error = failure('COOKIE_NOT_FOUND', '浏览器没有对应 Cookie，请登录目标网站');
        }
        // Close only after the HTTP response has been written.
        res.once('finish', () => finish(error, cookies));
        reply(200, { ok: true });
      } catch {
        if (!res.headersSent) reply(400, { error: 'INVALID_RESULT' });
      }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    const finish = (error, cookies) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const force = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1000);
      server.close(() => {
        clearTimeout(force);
        if (signal?.aborted) reject(failure('CANCELLED', '凭据获取已取消'));
        else if (error) reject(error);
        else resolve(cookies);
      });
      server.closeIdleConnections?.();
    };
    const abort = () => finish(failure('CANCELLED', '凭据获取已取消'));
    const timer = setTimeout(() => finish(failure('RELAY_TIMEOUT', '等待浏览器超时，请打开浏览器并启用插件')), Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    server.once('error', err => finish(failure(err.code === 'EADDRINUSE' ? 'RELAY_BUSY' : 'RELAY_ERROR',
      err.code === 'EADDRINUSE' ? '凭据端口正在使用，请稍后重试' : '无法启动本地凭据服务')));
    server.listen(PORT, '127.0.0.1');
  });
}

// ---------------- CLI Entrypoint ----------------
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    console.log(`
🔌 Leo Live Inspector - 凭据中继直连同步工具 (Credential Relay CLI)

无需借助任何外部浏览器自动化工具（如 opencli / ego-browser），通过随附 Chrome 扩展自动同步 Cookie！

用法:
  node scripts/credential_relay.js <targetUrl> [options]

参数:
  <targetUrl>            目标系统 URL (例如: https://luke.ke.com 或 https://cloud.intra.ke.com)

选项:
  --names <k1,k2...>     仅提取指定的 Cookie 名称 (逗号分隔)
  --timeout <ms>         等待扩展轮询超时时间 (默认: 60000ms)
  --json                 以 JSON 格式输出抓取到的 Cookies
  -h, --help             查看帮助

示例:
  node scripts/credential_relay.js https://luke.ke.com
  node scripts/credential_relay.js https://cloud.intra.ke.com --json
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const url = args[0];
  let names = undefined;
  let timeoutMs = 60000;
  let isJson = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--names' && args[i + 1]) {
      names = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeoutMs = parseInt(args[++i], 10) || 60000;
    } else if (args[i] === '--json') {
      isJson = true;
    }
  }

  console.log(`⏳ 正在通过本地端口 ${PORT} 等待 Chrome 扩展 (Leo cookie.txt Locally) 静默同步凭据...`);
  console.log(`🎯 目标 URL: ${url}`);
  console.log(`💡 提示: 请确保已在常驻 Chrome 浏览器中登录该目标站点，扩展将在 1 分钟内自动回传。\n`);

  getBrowserCookies({ url, names, timeoutMs })
    .then(cookies => {
      const header = cookiesToHeader(cookies);
      if (isJson) {
        console.log(JSON.stringify({ ok: true, count: cookies.length, cookies, header }, null, 2));
      } else {
        console.log(`✅ 凭据同步成功！共获取 ${cookies.length} 个 Cookie:`);
        console.table(cookies.map(c => ({
          名称: c.name,
          域名: c.domain,
          路径: c.path,
          安全: c.secure,
          到期时间: c.expirationDate ? new Date(c.expirationDate * 1000).toLocaleString() : 'Session'
        })));
        console.log(`📋 Cookie 标头长度: ${header.length} 字符\n`);
      }
    })
    .catch(err => {
      console.error(`❌ 凭据同步失败:`, err.message);
      process.exit(1);
    });
}

