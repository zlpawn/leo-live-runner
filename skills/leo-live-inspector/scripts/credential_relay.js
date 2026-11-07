import { ensureBridge, executeCommand } from './cli/lib/cli.mjs';

const DEFAULT_TIMEOUT_MS = 180000;
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

// A cookie reaches this URL when its domain, path and scheme all match it.
function cookiesForRequest(cookies, { url, names }) {
  const target = new URL(url);
  return cookies.filter(c => {
    const domain = String(c.domain || '').replace(/^\./, '');
    const cookiePath = c.path || '/';
    return domain && (c.hostOnly ? target.hostname === domain :
      target.hostname === domain || target.hostname.endsWith(`.${domain}`)) &&
      (target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)) &&
      (!c.secure || target.protocol === 'https:') && !c.partitionKey &&
      (!c.expirationDate || c.expirationDate * 1000 > Date.now()) &&
      (!names || names.includes(c.name));
  });
}

async function readThroughBridge(request, timeoutMs) {
  let health;
  try {
    health = await ensureBridge({ startTimeoutMs: timeoutMs });
  } catch {
    throw failure('RELAY_BUSY', '桥接端口被其他程序占用，请稍后重试');
  }
  if (!health.extensionOnline) throw failure('RELAY_TIMEOUT', '等待浏览器超时，请打开浏览器并启用插件');

  let response;
  try {
    response = await executeCommand('cookies', { url: request.url });
  } catch (err) {
    if (['command_timeout', 'bridge_unavailable'].includes(err.code))
      throw failure('RELAY_TIMEOUT', '等待浏览器超时，请打开浏览器并启用插件');
    throw failure('BROWSER_READ_FAILED', '浏览器无法读取凭据，请确认已登录目标网站');
  }

  // Without matchedBy the extension read by hostname and may have missed parent-domain cookies.
  if (response.result?.matchedBy !== 'url')
    throw failure('EXTENSION_OUTDATED', '浏览器扩展版本过旧，请在 chrome://extensions 重新加载 Leo cookie.txt Locally 后重试');
  const browserCookies = response.result.cookies;
  try { cookiesToHeader(browserCookies); } catch { throw failure('INVALID_RESULT', '浏览器返回了无效 Cookie'); }
  const cookies = cookiesForRequest(browserCookies, request);
  if (!cookies.length) throw failure('COOKIE_NOT_FOUND', '浏览器没有对应 Cookie，请登录目标网站');
  return cookies;
}

export async function getBrowserCookies(options = {}) {
  if (process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS === 'off')
    throw failure('BROWSER_CREDENTIALS_DISABLED', '浏览器自动获取已关闭');
  const request = normalizeCredentialRequest(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure('INVALID_REQUEST', '无效的超时时间');
  return readThroughBridge(request, timeoutMs);
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
  --timeout <ms>         等待浏览器的超时时间 (默认: 60000ms)
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

  console.log(`⏳ 正在通过本地桥接从 Chrome 扩展 (Leo cookie.txt Locally) 读取凭据...`);
  console.log(`🎯 目标 URL: ${url}`);
  console.log(`💡 提示: 请确保已在常驻 Chrome 浏览器中登录该目标站点。\n`);

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

