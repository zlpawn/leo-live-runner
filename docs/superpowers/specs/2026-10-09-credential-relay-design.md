# credential_relay 技术方案（精简版）

日期：2026-10-09

状态：已按精简方案实现（2026-10-10）；模拟接口及本机 HTTP 通路通过自动化验证，真实浏览器只读联调待验证。

## 1. 目标和取舍

重点是让 leo-live-inspector 在凭据缺失或明确失效时，自动从已登录的浏览器获取所需 Token/Cookie，避免人工复制粘贴。

采用：Node 临时 HTTP 服务 + 插件低频探测 + 现有业务脚本和缓存。

- 服务脚本叫 `scripts/credential_relay.js`，随 skill 分发，不常驻、不注册系统服务。
- 无配对文件、无密钥配置、无签名握手，安装/升级插件并重新加载后即可使用。
- 任务只存在内存；凭据获取完成、超时或取消后关闭监听。
- URL 和 Cookie 名称由调用方提供，relay 和插件不写死平台。
- 复用现有 JSON 缓存与保存方法，不引入新缓存体系、缓存迁移或统一业务框架。
- 第一版支持 Cookie 及存储于 Cookie 中的 Token。localStorage、sessionStorage、请求头 Token 不包含在本版，不能宣称任意网页 Token 都可获取。
- 默认只有一个浏览器普通 Profile 启用自动获取。不开发多 Profile 管理、隐身/分区 Cookie 或远程转发。

用户已接受“信任本机程序”的边界：本方案不能鉴别冒充 relay 的本地程序，也不防御本地程序伪造插件请求。请求 ID 只用于关联结果，不是身份认证。

## 2. 实施前基础

代码基线为 `fea2343`，此前的设计提交仅新增文档。

- skill 没有 Bridge 服务端；插件已有 Cookie 读取和任务回传代码，可以复用思路。
- `common/credentials.js` 以及 Cloud MySQL、Dinsight 的现有加载器能读取缓存，但未接入自动获取。
- 插件旧通道使用 `19527` / `8788`，有 1 秒离线重试。新凭据通道使用独立 `19528`，避免误把凭据服务当作 DOM/CDP 网关。
- 通用 `command-queue.mjs` 会缓存完成结果；新凭据通道不经过该队列，避免凭据留存或向多个来源回传。
- 本会话于 2026-10-09 无 Cookie 实测：Paoding 日志查询成功；FAST 首页及两个应用级联接口成功。FAST 完整索引发现流程未全部验证。两者不应预先强制取凭据。

工具记录：Hindsight 工具未出现在当前可调用目录；代码图未返回 skill 子目录的有效结果。依据为此前的源文件检查和只读接口验证，不引用未读取的记忆。

## 3. 最小实现结构

所有路径相对 `skills/leo-live-inspector/`：

| 文件 | 修改 |
| --- | --- |
| `scripts/credential_relay.js`（新增） | 导出异步获取函数；临时启动 Node HTTP 服务、保存一个内存任务、接收结果、关闭监听 |
| `resources/chrome_extension/credential-relay.mjs`（新增） | 低频探测、按 URL 读取 Cookie、回传结果 |
| `resources/chrome_extension/background.js` | 初始化新模块；旧服务离线时也改为低频探测，停止一秒一次空转 |
| `scripts/common/browser_credentials.js`（新增） | 按服务管理一次自动获取、只读验证与刷新 |
| `scripts/common/credentials.js` | 保留同步加载接口，原子写缓存，按 URL 筛选导入 Cookie |
| 各业务脚本及 `common/dinsight.js` | 在缺失/明确失效处分支接入，保留各自鉴权判断 |
| `SKILL.md` 与插件说明 | 自动获取优先，浏览器未登录时引导登录，手工复制作为兜底 |

进一步简化进程：业务脚本直接 import `credential_relay.js`，在自己的 Node 进程里短暂监听 HTTP，不 fork 子进程、不引入 IPC。获取函数返回前关闭监听；业务脚本继续查询或部署。父进程退出时不会遗留独立 relay 进程。

这里“服务停止”指 HTTP 监听停止，不要求整个业务脚本退出。文件仍是独立的 Node 模块，可供各脚本复用。

## 4. 完整流程

```text
业务脚本加载现有凭据
  ├─ 可用 → 正常执行，不启动 relay
  └─ 缺失 / 明确登录失效
       → 调用 getBrowserCookies(url, names)
       → 临时监听 127.0.0.1:19528，保存内存任务
       → 插件下一次探测领取任务
       → 按 URL 和 names 读取 Cookie 并回传
       → 函数接收结果、关闭监听、返回给业务脚本
       → 业务只读验证成功后更新原有缓存并继续
```

插件空闲时每 60 秒探测一次；启动/重新加载插件时也探测一次。连接失败正常结束，等待下次 alarm，不写持续报错日志。每次请求超时 2 秒；整个获取操作默认最多等待 180 秒。

扩展 worker 启动时检查 alarm 是否存在，不依赖永久运行的 while/setInterval。实际 alarm 可以延迟，180 秒超时不等于用户没有登录。

一次 relay 只处理一个任务。同一进程内的多个获取调用简单串行执行；180 秒从调用时计算，排队也计入。不同 CLI 争用端口时立即返回 `RELAY_BUSY`，不杀进程、不连接不明服务、不构建跨进程调度器。正常业务获取按顺序执行即可。

## 5. 通用函数与两个端点

调用示例：

```js
const cookies = await getBrowserCookies({
  url: 'https://example.com/api/query',
  names: ['session_id', 'csrf_token'], // 省略时取适用于该 URL 的 Cookie
  timeoutMs: 180000,
  signal
});
```

- URL 必须是 HTTP(S)，禁止空目标和 userinfo；去掉 query/hash，保留实际接口路径。
- names 可省略；提供时必须是非空字符串数组，精确匹配，禁止自动扩大到父域。
- 插件通过 `chrome.cookies.getAll({url})` 获取，再过滤 names，保留 API 返回顺序。
- 返回 Cookie 对象数组，包含 name/value/domain/path 等现有字段。单 Token 业务取所需 Key；Cookie 标头业务构造 `name=value; ...`。
- 同名不同 path 保留浏览器 API 顺序，不简单压成 Map；Dinsight 等业务已有取值规则保持在业务代码中。

| HTTP 端点 | 行为 |
| --- | --- |
| `POST /credential-relay/poll` | 插件领取 `{id, url, names, expiresAt}`；无可领取任务返回空 |
| `POST /credential-relay/result` | 插件上报 `{id, cookies}` 或 `{id, error}`；relay 匹配当前任务 ID，回 `{ok:true}` |

任务 ID 每次随机生成。任务交给插件后不再发给其他轮询；同一页面服务重载或 worker 中断导致任务丢失时，本次获取超时结束，不做租约重领系统。插件回传结果失败最多立即重试一次；服务仍在线时重复结果只交付一次。收到结果并写出响应后关闭服务器，再向调用者返回。允许最多 1 秒关闭宽限，强制释放空闲连接，避免 keep-alive 延长生命周期。响应丢失但 relay 已关闭时，插件丢弃本次结果，不等待服务重启；业务已经收到的结果不受影响。

所有超时、异常、AbortSignal 都走 finally 清理计时器、监听与结果引用。端口被占用不读取 Cookie；取消在收到结果后发生也不得继续写缓存。

## 6. 保留的简单约束

- 只绑定 `127.0.0.1`，固定端口 `19528`；不增加设置界面和端口发现。
- 只提供上述两个端点；任务由同进程函数创建，没有网页可调用的任务提交或凭据下载接口。
- 要求 POST、JSON、自定义请求头 `X-Leo-Credential-Relay: 1`，检查准确 Host；拒绝普通网页的 HTTP(S)/null Origin，不开放通配 CORS。实际扩展请求若不带 Origin 可接受；该标头不是秘密或身份认证。
- 限制请求体 256 KiB；禁止 Cookie 名称/值中的 CR/LF 等控制字符。返回体 `Cache-Control: no-store`。
- 凭据不写日志、stdout、插件 storage 或通用完成任务缓存；函数内部传递，业务验证后才按现有方式落盘。修正现有 Token 前缀日志。
- 插件只对当前任务读 Cookie，不在低频探测时主动同步全部 Cookie。
- 新通道不复用旧外部消息入口。旧入口不参与自动获取，不为本次功能扩张网页导出权限；原手动复制/下载保留。
- 第一版按单浏览器/Profile 使用；多个 Profile 同时启用时可能由最先领取任务者提供凭据，说明文档要求只在目标 Profile 启用。没有账号绑定或自动挑选正确账号的保证。

这些限制降低误调用与泄露风险，但不等价于配对鉴权；用户已选择优先保持本机使用简单。

## 7. 接入范围与凭据规则

| 业务 | 自动获取规则 |
| --- | --- |
| 服务云 MySQL | 服务云实际 API URL，提取 `cloud_console_token_egg`，复用 `cloud_token.json` |
| Apollo 测试配置修改 | Portal API URL 的 Cookie，核心 Key 为 `jt_apollo_login_token`；修改前已有只读检查用于验证 |
| Dinsight | API URL 的 Cookie，保留 `prd-assistant-token-prod`、`access_token`、`login_ucid`、`security_ticket`、`csrf_token`；复用 whoami 和缓存 |
| Shipwright 构建 | 按 Shipwright API URL 获取 Cookie；新增简单 `shipwright_cookie.json`，避免与服务云完整 Cookie 混用 |
| 服务云部署/交付 | 按服务云 API URL 获取，复用服务云缓存 |
| FeCI | 按 FeCI API URL 获取，复用 `feci_cookie.json`，服务云交付仍单独获取 |
| Paoding 测试日志 | 去掉缺 Cookie 就退出；先无凭据查询，只有明确鉴权失败才取对应 Cookie |
| FAST | 保持直接查询及页面会话探测，不强制 `_secondx`，本版不重写索引发现流程 |
| Apollo 读取、Kafka、测试 MySQL | 不接入浏览器凭据 |

保留现有 `--set-token`/`--set-cookie`、环境变量、下载文件与 JSON 读取兼容。显式单次参数或环境变量失败时不静默换账号；自动获取主要作用于默认缓存缺失/失效。

仅凭据缺失或明确失效触发获取：401、明确的登录跳转或业务登录错误。Dinsight 明确的 CSRF 校验失败可重新获取包含 csrf_token 的 Cookie 集合。普通 403、500、网络错误、SQL 错误不能直接视为 Token 过期。业务每次执行最多自动获取一次，浏览器返回空值或再次无效时提示到网站登录，不循环。

只读接口重试一次，成功后用原保存函数更新缓存；保存失败不丢弃本次内存凭据。写接口在写之前通过已有只读接口验证登录态；写请求响应不明确时不自动重放。Dinsight 流已经开始后不自动重新提问。

缓存继续使用现有结构；受影响的保存入口采用同目录临时文件再 rename，避免写到一半；不增加锁服务或合并框架。不同 CLI 并发更新同一缓存采用最后一次完整写入生效，不承诺跨进程事务。服务云单 Token 更新应保留原 JSON 其他字段，避免抹掉 CI 仍需的 Cookie。

Cookie 按目标网站分别传递，不把 Shipwright、服务云、FeCI Cookie 拼接互发。业务重定向不携带凭据跨 origin 自动跟随。

## 8. 插件改动量

只新增凭据模块，并在 background 初始化：

1. 注册/检查 60 秒 alarm，执行探测与回传。
2. 用 URL 和可选 names 读取 Cookie，复用现有 Cookie 处理思路。
3. 凭据结果短暂保存在函数内，取完释放，不经过通用命令缓存。
4. 旧网关离线后也等待低频探测；在线时原 DOM/CDP 任务逻辑保留，不因新 relay 出现而启用旧网关。

不新增配对弹窗、设置页、密钥管理或多 Profile UI。用户升级后重新加载插件即可；浏览器没开、插件未加载、目标网站未登录时给出对应提示。

## 9. 最小验收

使用现有 `node --test`，模拟 Cookie 值，重点验证：

- 缓存有效不监听；缓存缺失/明确失效后自动获取，最多一次。
- 从插件 poll → Cookie 筛选 → result → 业务缓存的完整通路。
- 结果、异常、取消、浏览器无响应、端口占用均能结束；结果返回后端口释放。
- Cookie 范围、同名 path、空目标与普通网页请求正确处理；日志不包含虚构凭据标记。
- Paoding 匿名成功不获取 Cookie；500/普通403 不刷新；写操作不盲目重试。
- Shipwright 与服务云缓存、标头独立，旧手工入口仍可使用。

随后做真实浏览器只读联调：重新加载扩展、让 worker 休眠后发起请求，分别验证缺失、过期及未登录。真实测试不触发构建/部署。

## 10. 落地顺序

1. 打通 relay + 插件自动读取和退出。
2. 接入 Cloud MySQL、Dinsight、Apollo，再接 CI/FeCI；修正 Paoding 匿名优先。
3. 补充上述关键测试与使用说明。

提供 `LEO_INSPECTOR_BROWSER_CREDENTIALS=off` 关闭自动获取，继续使用现有手工凭据方式。实现和验证记录见 `docs/superpowers/plans/2026-10-09-credential-relay.md`。

## 11. API 依据

此前于 2026-10-09 核对的官方资料：

- Cookie URL 匹配、返回顺序与 HttpOnly 元数据：`https://developer.chrome.com/docs/extensions/reference/api/cookies`
- alarm 调度可能延迟及启动时检查：`https://developer.chrome.com/docs/extensions/reference/api/alarms`
- service worker 可休眠/终止：`https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`

本次是对既有方案的简化，不增加浏览器 API 能力假设。
