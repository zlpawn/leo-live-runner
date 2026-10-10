import { getBrowserCookies, cookiesToHeader } from '../credential_relay.js';

export function isLoginFailure(response) {
  const status = response?.statusCode;
  if (status === 401) return true;
  if (status >= 300 && status < 400) {
    try { return /^(?:test-login|login)\.ke\.com$/.test(new URL(response.headers?.location).hostname) ||
      /^\/(?:login|signin)(?:[/?]|$)/i.test(response.headers?.location || ''); } catch {
      return /^\/(?:login|signin)(?:[/?]|$)/i.test(response.headers?.location || '');
    }
  }
  const body = response?.json || response?.data;
  return body && typeof body === 'object' && (body.code === 401 || body.status === 401);
}

export function isCredentialSuccess(response) {
  if (!response || !Number.isFinite(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300 || response.error) return false;
  const body = response.json || response.data;
  if (typeof body === 'string' && /<html|<!doctype/i.test(body)) return false;
  if (body && typeof body === 'object') {
    if (body.success === false || body.error) return false;
    if (body.code !== undefined && ![0, 200, 20000, 200000, '0', '200', '20000', '200000'].includes(body.code)) return false;
    if (body.status !== undefined && typeof body.status === 'number' && body.status >= 400) return false;
  }
  return true;
}

// A small per-service session: lazy load, at most one browser fetch, no write replay.
export function createCredentialSession({ load = () => '', save = () => {}, explicit = false,
  anonymous = false, fallbackLoad, names, fromCookies = cookiesToHeader, isAuthFailure = isLoginFailure,
  isSuccess = isCredentialSuccess, getCookies = getBrowserCookies } = {}) {
  let value;
  let fetched = false;
  let pendingSave = false;
  let validated = false;
  const current = () => { if (value === undefined) value = load(); return value; };
  const acquire = async url => {
    fetched = true;
    const candidate = fromCookies(await getCookies({ url, names }));
    if (!candidate) throw Object.assign(new Error('浏览器没有需要的凭据，请登录目标网站'), {code:'COOKIE_NOT_FOUND'});
    if (value && JSON.stringify(candidate) === JSON.stringify(value))
      throw Object.assign(new Error('浏览器登录态同样已失效，请重新登录目标网站'), {code:'CREDENTIAL_REJECTED'});
    value = candidate; pendingSave = true; validated = false;
  };
  async function run(url, send, { readOnly = false } = {}) {
    current();
    if (!readOnly && !validated) throw Object.assign(new Error('写操作前需要成功的只读凭据检查'), {code:'CREDENTIAL_PREFLIGHT_REQUIRED'});
    if (!value && !anonymous && !explicit && !fetched) await acquire(url);
    let result = await send(value);
    if (readOnly && isAuthFailure(result) && !value && fallbackLoad && !explicit) {
      const cached = fallbackLoad();
      if (cached) { value = cached; result = await send(value); }
    }
    if (readOnly && isAuthFailure(result) && !explicit && !fetched) {
      await acquire(url);
      result = await send(value);
    }
    if (isAuthFailure(result)) validated = false;
    if (readOnly && isSuccess(result) && !isAuthFailure(result)) {
      validated = true;
      if (pendingSave) { try { await save(value); } catch { /* Keep usable in-memory credentials. */ } pendingSave = false; }
    }
    return result;
  }
  return { run, current };
}
