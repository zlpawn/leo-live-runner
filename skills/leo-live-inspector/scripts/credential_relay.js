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
