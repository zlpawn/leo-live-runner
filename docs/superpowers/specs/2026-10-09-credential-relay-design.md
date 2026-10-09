# credential_relay 技术方案

日期：2026-10-09

状态：待审阅；本文定义目标行为，不代表功能已经实现。

范围：leo-live-inspector skill、随 skill 分发的 Chrome 扩展及现有凭据调用入口。

## 1. 目标与已确认约束

用户希望使用 skill 时，不再反复手工复制网站 Token 或 Cookie。已有凭据可用时继续直接调用业务接口；凭据缺失或服务明确报告登录失效时，skill 按需启动本地凭据中转器，从已登录的浏览器获取所需 Cookie，完成后退出。

已确认：

- 名称为 `credential_relay`，使用 Node.js 实现，作为 skill 自带脚本分发。
- 中转器不常驻、不注册开机服务，任务仅保存在进程内存中。
- 插件低频探测；没有取凭据任务时，不因探测读取或发送 Cookie。
- 请求协议支持不同网站，插件与中转器不内置业务域名、Cookie Key。
- Paoding、FAST 默认沿用无凭据路径，不能因为本地没有 Cookie 就强制获取。

本文新增的设计选择包括：专用端口、首次配对流程、单 Profile 绑定、并发串行化及超时参数。它们是待本次审阅确认的建议，不是此前用户逐项指定的要求。

成功标准：一次配对后，日常已登录浏览器中的 Cookie 能按需交给业务脚本；缓存有效不启动进程；失败可解释；无任务和凭据结果长期留存在中转器中。

## 2. 当前实现与证据

以当前仓库 `fea2343` 为代码基线。路径均相对仓库根目录。

| 位置 | 当前情况 | 本次影响 |
| --- | --- | --- |
| `skills/leo-live-inspector/scripts/common/credentials.js` | 环境变量、本地 JSON、下载文件的同步加载；没有插件请求入口 | 保留兼容读取，新增异步凭据获取层 |
| `scripts/cloud_mysql_query.js`（skill 内） | 还有独立 Token 加载、保存逻辑 | 统一接入；移除 Token 前缀日志 |
| `scripts/common/dinsight.js`（skill 内） | 筛选 5 个 Cookie，并构造 CSRF 请求头 | 保留业务规则，接入通用获取层 |
| `resources/chrome_extension/background.js`（skill 内） | 连接旧 `19527` / `8788`，支持 `cookies.get` / `cookies.export` | 可借鉴任务通信，新增独立凭据协议 |
| 同上 | `chrome.cookies.getAll({domain})`，缺省范围为空 | 新通道强制 URL；限制旧自动导出入口 |
| `resources/chrome_extension/poll-loop.mjs`（skill 内） | 离线退避 1 秒；background 有 interval 与 alarm | 新模式以 alarm 低频探测，移除默认旧轮询 |
| `resources/chrome_extension/command-queue.mjs`（skill 内） | 通用完成结果最多缓存 5 分钟，并可向多个来源回传 | 凭据结果不进入该缓存或跨来源分发 |
| skill 目录 | 未发现真实监听端口的 Bridge 服务端 | 需要新增 Node 服务端 |

2026-10-09 本机会话中，以无 Cookie、无自动重定向的只读请求验证：

- Paoding `/api/ds/query?ds_type=loki` 返回 HTTP 200、结果 A 状态 200、1 个 frame、无查询错误。因此当前 `test_log_query.js` 缺 Cookie 即退出的检查过严。
- FAST 首页及 `/app/cascader`、`/app/cascader/appCode` 返回成功；完整集群/索引发现链尚未逐步验证，不能把这解释为所有 FAST 接口永久免鉴权。
- `fast_query.js` 当前直接查询 Kibana 时不发送 Cookie；页面探测使用浏览器会话，Cookie 导出并非其必要前置步骤。

知识来源说明：本会话可调用工具目录未暴露 Hindsight 工具，无法完成知识页检索/记录。代码图对 skill 子目录查询没有返回结果，以上结论由源文件与上述只读验证补充确认。

## 3. 方案选择与范围

| 方案 | 优点 | 代价 | 决定 |
| --- | --- | --- | --- |
| 临时 Node relay + 插件低频探测 | 随 skill 分发；无需常驻进程；符合现有使用方式 | 获取可能等待一次探测周期 | 采用 |
| 常驻网关 | 任务可随时送达 | 需要长期维护进程 | 不采用 |
| 浏览器 Native Messaging | 浏览器可启动本地主机程序 | 跨平台安装注册；仍需设计 CLI 如何触发浏览器端 | 暂不引入 |

第一版只处理普通浏览器 Profile 的未分区 Cookie，包括 HttpOnly Cookie。浏览器必须已打开、插件已启用并已配对。登录、验证码、MFA 仍由用户在网站完成。

不包含：localStorage/sessionStorage Token、网络请求头捕获、远程主机转发、隐身/分区 Cookie、后台自动登录，以及通用 DOM/CDP 自动化。遇到不支持的来源显式报错，不猜测或扩大获取范围。

## 4. 组件与职责

```text
业务脚本（判断鉴权、验证与重试）
    │
    ├── 本地凭据缓存
    │
    └── browser_credentials.js（异步请求、进程管理）
              │ Node IPC，凭据不走 stdout/命令行
              ▼
        credential_relay.js（短生命周期 HTTP 服务、内存任务）
              ▲ 已配对的 loopback HTTP 请求
              │
        插件 service worker（低频探测、读取匹配 Cookie）
              │
              ▼
        chrome.cookies API
```

拟新增/调整文件，以下路径均位于 `skills/leo-live-inspector/`：

| 文件 | 职责 |
| --- | --- |
| `scripts/credential_relay.js` | 启动监听、会话认证、任务租约、结果回传、退出 |
| `scripts/common/browser_credentials.js` | 调用 API、fork 子进程、并发合并、超时/取消处理 |
| `scripts/common/credential_protocol.js` | URL/请求校验、协议封装、认证消息处理 |
| `scripts/common/credential_profiles.js` | 服务描述、鉴权错误识别、缓存适配；业务规则集中于此 |
| `scripts/common/credentials.js` | 保留旧入口，增加有作用域的缓存读写 |
| `resources/chrome_extension/credential-relay.mjs` | alarm、认证握手、任务执行，不复用通用结果缓存 |
| `resources/chrome_extension/credential-protocol.mjs` | 浏览器侧协议校验与 Web Crypto 验签 |
| `resources/chrome_extension/popup.*` | 首次导入配对配置、状态、断开配对；不展示凭据值 |
| `scripts/credential_pair.js` | 生成/轮换一次性配对配置文件；输出只含文件路径 |

共享协议以固定测试向量约束 Node 与浏览器实现，不引入打包工具。Node 使用内置 `http`、`crypto`、`child_process`；新增功能建议要求 Node 20+，实施时增加运行时检查。

## 5. 进程生命周期与并发

### 5.1 默认参数

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 监听地址 | `127.0.0.1` | 不绑定 `0.0.0.0` |
| 端口 | `19528` | 与旧 DOM/CDP Bridge `19527` 分离；配对时可改 |
| 空闲插件探测 | 60 秒 | alarm，不承诺精确唤醒时刻 |
| 单次探测 HTTP 超时 | 2 秒 | 服务未启动属于正常状态 |
| 业务总等待时间 | 180 秒 | 包含端口排队、等待插件、返回结果，不重复扩展截止时间 |
| 单任务租约 | 15 秒 | worker 中断后可重新领取；最多领取 2 次 |
| 结果确认宽限 | 2 秒 | 已交付结果后完成 ACK，再退出 |
| 单次 relay 最长存活 | 180 秒 | 到期使剩余任务失败并退出 |

Chrome alarm 可延迟、设备睡眠时不会唤醒设备；超时应说明“浏览器未及时响应”，不能认定“用户未登录”。扩展启动时检查 alarm 存在再创建，不在每次事件中重建并推迟它。

### 5.2 所有权与状态

`browser_credentials.js` 通过 `fork()` 启动子进程，使用 IPC 交付配对信息、任务、结果与 ACK。正常流程无需用户执行启动命令。子进程监听成功后报告 READY；在 READY 前不发任务。

状态：`STARTING → WAITING_FOR_EXTENSION → RUNNING → DRAINING → CLOSED`。错误/取消均进入清理分支，销毁 socket、计时器和结果引用。父进程 IPC 断开时子进程立即关闭；正常退出超时后由父进程终止其自己创建的子进程。不能按端口杀陌生进程。

凭据任务状态：`QUEUED → LEASED → RESULT_READY → ACKED`；终态还包括 `FAILED/CANCELLED/EXPIRED`。租约与任务 ID 均绑定本次 relay 实例和配对 Profile，迟到结果不能投递给新实例。

第一版选择简单的跨进程串行化：

- 同一父进程：合并相同 Profile、URL、名称集合的并发请求；不同请求复用自己启动的同一 relay，最多 16 个任务。
- 不同父进程：通过绑定端口竞争临时 relay 所有权；竞争失败者等待端口释放，在原 180 秒截止时间内以 0.5～1.5 秒抖动重试。
- 不向未知已占端口的服务提交凭据请求，不跨进程共享 Cookie 结果；超时返回 `RELAY_PORT_BUSY`。原监听器退出后，新实例使用新的会话随机数。
- 所有任务结果已被父进程通过 IPC 确认接收，且最终 HTTP ACK 已写出后进入 2 秒 DRAINING；此期间只处理重复结果并返回 ACK，随后关闭。服务端无法证明对端已收到 ACK，不能无限等待该条件。不能因为任务刚被领取、队列暂时为空就关闭。
- DRAINING 期间父进程到来的新请求排到下一轮 relay；不重新开启当前实例，且仍沿用各自原截止时间。

这比跨进程共享常驻队列更小，也避免全局锁、发现文件、外部客户端鉴权等第一版不需要的复杂度。代价是多个 CLI 同时首次取凭据可能多等一轮探测。

## 6. 通用 API 与 Cookie 语义

调用示意（非已实现代码）：

```js
await getBrowserCredentials({
  url: 'https://example.com/api/query',
  source: 'cookies',
  names: ['session_id', 'csrf_token'],
  browserProfileId: 'paired-profile-id',
  timeoutMs: 180000,
  signal
});
```

请求字段：

- `url` 必填：只允许 HTTP(S) 完整 URL；禁止 userinfo，去除 query/hash，只保留 scheme/host/port/path。业务必须传实际接口路径，不能用首页代替有 path 限制的 Cookie 请求。
- `names` 可省略，表示该 URL 的全部适用 Cookie；非空数组最多 64 项，空数组拒绝。业务可另声明 `requiredNames`，以区分可选 CSRF 与必需主 Token。
- `browserProfileId` 默认使用已明确绑定的默认 Profile。没有默认且存在多个配对配置则返回选择错误，绝不取最先响应者。
- `source` 第一版只接受 `cookies`；分区、隐身或 storage 来源返回不支持错误。

插件调用 `chrome.cookies.getAll({url})`，再按 names 精确筛选；不使用 `.includes(domain)`，不默认导出整个父域。每次只读当前 Profile 的默认普通 Cookie store。

返回 `{requestId, browserProfileId, url, obtainedAt, cookies}`。Cookie 对象保留 name/value/domain/path/secure/httpOnly/hostOnly/session/expirationDate/storeId，保持 API 排序。凭据值只通过认证响应和 IPC 交付。

标头构造与保存规则：

- 同名不同 path 的 Cookie 不压成普通 Map；按 API 的 path 优先顺序构造标头。仅需单 Token 的业务按相同优先顺序取首个匹配项，并由业务验证。
- 拒绝名称/值中的 CR/LF 及不符合 Cookie 标头语义的控制字符；限制响应体为 256 KiB、最多 256 条 Cookie，超限报错，不截断出一个看似有效的凭据。
- 返回空集合为 `COOKIE_NOT_FOUND`，不扩大到父域重试。
- 每个目标 URL 单独匹配，禁止把 FeCI、服务云、Shipwright 的完整 Cookie 合并后互发。
- 如果目标 API 返回重定向，不自动携带 Cookie 跨 origin 跟随；登录跳转交由鉴权识别处理。

## 7. 首次配对与通信协议

### 7.1 一次配置，后续自动

不能把“监听在本机”当作身份认证。第一版采用一次性文件导入配对，避免每次取凭据让用户确认。

1. skill 后台运行配对脚本，生成随机 256 位共享密钥、`pairId` 和 `browserProfileId`。同一 Profile 使用一套配置，不同 Profile 单独生成。
2. 本机永久配置保存在 `~/.shrimp/skills/live-inspector/credential-relay/`，目录 0700、文件 0600；Windows 使用当前用户私有目录，并验证 ACL 限制，不能把 chmod 当作 Windows ACL 的替代。
3. 用户在插件弹窗内选择导入本次配对文件。文件内容含固定 loopback 地址、端口、配对标识和密钥；不含网站 Cookie。该操作仅首次安装或轮换时需要。
4. 插件先设置 `chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`，再写入配对信息；不使用 sync 存储、不暴露给 content script。skill 的配对校验运行一次短期 relay，完成 hello 后删除一次性导入副本；超时保留明确的待配对状态与文件路径。原私有配置仍供 skill 使用。
5. 重新配对轮换密钥，使旧配对失效。插件卸载、配置删除、Profile 变化时显式重新配对，不能静默改绑。

同一配对文件仅导入一个 Profile，不能靠扩展 ID 区分多个 Profile。复制同一秘密到多个 Profile 不在支持范围内；hello 额外携带插件本地生成且不随配置导入的安装实例 ID，首次校验后在本机绑定，出现不同实例 ID 即拒绝并提示重新配对。

安装流程允许 skill 自动生成文件并打开扩展配置入口，但不承诺能跳过浏览器要求的首次用户交互。本次方案不读取现有浏览器秘密或在用户不知情时绑定任意扩展。

### 7.2 认证封装

传输为 loopback HTTP；HMAC-SHA-256 提供双方身份校验与完整性。密钥不通过网络、URL、命令行或 stdout 发送。

所有协议 JSON 使用 `{pairId, payload, mac}` 封装；`payload` 为 UTF-8 JSON 原始字节的 base64url，不依赖双方重新序列化对象。MAC 覆盖固定协议标识、请求/响应方向、HTTP method、path、pairId 和 payload，字段以换行分隔且标识字段禁止换行。验证签名后才解码并按允许字段执行；签名比较使用恒定时间校验能力。

payload 包含 `version:1`、消息类型、时间戳和 nonce。响应绑定请求 nonce；每次 relay 实例生成 `relayInstanceId` 和 `serverNonce`，握手之后的报文必须包含它们。允许 60 秒时钟偏差；在实例存活期记录 nonce 并拒绝重放。签名错误不返回任务或 Cookie。

插件发带随机 `clientNonce` 的已签名 hello，验证签名及绑定 clientNonce 的服务端响应后，才允许读取凭据。后续每个 poll/result 及其响应均签名，不因 localhost、Origin 或扩展 ID 匹配而跳过认证。

威胁边界：防网页跨源调用和不持有配对密钥的本地端口冒充者；不能抵御已控制当前 OS 用户、可读取私有配置或浏览器存储的恶意程序。HTTP 不提供加密，不宣称防御本机高权限网络监听。

### 7.3 HTTP 端点

| 端点 | 调用方 | 行为 |
| --- | --- | --- |
| `POST /v1/credential-relay/hello` | 插件 | 双方验证 nonce，建立本次实例会话 |
| `POST /v1/credential-relay/poll` | 插件 | 返回一项租约任务或空闲/关闭指示 |
| `POST /v1/credential-relay/result` | 插件 | 上报对应 requestId + leaseId 的结果，收到 ACK 后立即丢弃结果引用 |

没有公开的任务提交端点、任务查询端点或 Cookie 下载地址，CLI 通过 IPC 工作。所有请求限定准确 Host、JSON Content-Type、固定路径和请求体大小；拒绝网页 Origin、无签名请求以及通配 CORS。响应使用 `Cache-Control: no-store`。关闭阶段不再接受新任务。

插件正常无任务时每 60 秒尝试 hello；连接失败即返回休眠。认证成功且有任务时，短期 poll 获取队列；空队列等待最多 10 秒或接收关闭指示后回到 alarm。没有无限快速重连。

结果传送失败可在原租约/截止时间内最多重传 2 次，每次使用新的报文 nonce；业务 requestId/leaseId 不变。relay 等父进程 IPC 接收确认后才回最终 ACK，对重复 result 返回相同交付状态，但不向父进程重复交付；插件不建立长期结果缓存。worker 被终止导致内存结果丢失时，通过租约再次领取并重新读取 Cookie。实例已经关闭而 ACK 未到插件时，插件在重传上限后丢弃结果，不为旧任务等待或重启服务。

## 8. 插件迁移与旧入口

新凭据通道不能混入现有通用 `commandQueue` 的 5 分钟完成缓存。使用独立模块和状态，不将凭据写入日志、task summary、chrome.storage 或通用结果队列。

默认模式改为 `credential-relay`：

- 停止默认探测旧 `19527` / `8788`，清理旧 bridge alarms 与 interval；只有新凭据 alarm。
- 新通道只接受 Cookie 读取，不接受脚本执行、导航、DOM/CDP 指令。
- 禁止 `onMessageExternal.getCookies` 无认证返回 Cookie；旧外部网页请求只能收到停用说明。
- 禁止旧网关任务自动执行 `cookies.get` / `cookies.export`。既有手动弹窗复制/下载仍可用；“导出到网关”仅在用户明确点击时运行，并展示目标地址。
- `syncGatewayUrl` 等外部配置消息不得改写 relay 的配对目标；旧兼容模式只允许从插件界面显式开启并配置，禁止自动发现即启用。
- 如用户仍需要旧 DOM/CDP 网关，可选择启用旧自动化模式；这不属于新 relay 的能力。该模式也不能通过旧凭据命令绕过上述限制。

升级后需要重新加载扩展并完成一次配对。扩展 README 当前含外部仓库“主源目录”及同步命令说明；实施时应改为本仓库实际分发说明，不能执行仓库中不存在的同步命令。

## 9. 业务接入、缓存与重试

统一业务策略接口包括：`loadCached`、`describeRequest(targetUrl)`、`classifyAuthFailure(response)`、`validate(candidate)`、`saveValidated(candidate)`。域名、Key、SSO 判断存在服务描述中；relay 与插件无业务分支。

执行流程：

1. 显式单次参数/环境变量优先。对用户显式覆盖的凭据若失败，返回明确失败，不悄悄切换浏览器账号；仅默认缓存来源允许自动补齐。
2. 已知需要登录的服务在无缓存时请求浏览器；Paoding/FAST 先尝试无凭据路径。
3. 有缓存则先调用业务；只有站点定义的登录错误进入自动刷新，一次业务调用最多一次刷新。
4. 获取 candidate 后做轻量只读验证；成功才替换缓存，不用坏候选覆盖现有状态。浏览器返回与已失败缓存相同的值时停止，提示在对应站点重新登录。
5. 只读查询可以重试一次。Dinsight 在输出流开始后不自动重放问句。构建、部署、配置发布等写请求若响应不明，不自动重放；先查询执行状态，无法确认则交付不确定状态。

登录失效分类必须按服务实现：401、跳向已知登录路径的重定向、明确业务登录错误；403 只有能确定是登录/CSRF 问题时才刷新。一般 403、500、DNS、超时、限流、SQL 错误不触发取凭据。

| 业务 | 获取与接入策略 |
| --- | --- |
| 服务云 MySQL | 实际查询 API URL + `cloud_console_token_egg`，接入独立旧加载器 |
| Apollo 测试修改 | Portal API URL + 适用 Cookie；`jt_apollo_login_token` 为现有文档主 Key，保持完整标头兼容；先只读校验 |
| Dinsight | `api-dinsight.ke.com` 实际 API URL，保留 5 Key 规则；`csrf_token` 同步生成 X-CSRF-Token；使用已有 whoami 验证 |
| Shipwright CI | Shipwright API URL 单独取 Cookie，不再无条件复用服务云完整标头 |
| 服务云部署/交付 | 服务云 API URL 单独取 Cookie，写操作前先读校验 |
| FeCI | FeCI API URL 取 Cookie，与服务云交付各自管理 |
| Paoding | 移除缺 Cookie 即退出；匿名查询成功不启动 relay，明确需要登录才启用回退 |
| FAST | 保持直接查询与页面探测原路径；本版不新增 `_secondx` 强制检查、不把普通直连失败当鉴权失败，也不改写完整索引发现链 |
| Apollo 读取、Kafka、测试 MySQL | 不接入浏览器凭据获取 |

新缓存采用 v2 结构化 Cookie 文件，位于现有私有目录的 `credentials/` 子目录，按 Profile + 目标 origin 分文件，使用 Cookie 的 domain/path/secure/expiry 在每次构造标头前匹配。业务筛选规则属于各服务描述，不能仅按 origin 覆盖其他服务仍需的 Cookie。

缓存写入使用同目录临时文件 + 原子 rename；在本次请求的 URL 与 names 范围内，用已验证的完整候选集合替换旧匹配条目，包括删除浏览器已不再返回的条目，范围外保持不变。Cookie identity 为 name/domain/path/storeId，缓存文件已按 Profile 隔离。跨进程更新使用短时文件锁，超时放弃持久化但允许本次内存使用；不会让缓存锁保持 relay 运行。会话 Cookie 不虚构过期时间；以业务响应判断登录有效性。

旧 JSON、下载文件、`--set-token`/`--set-cookie` 保留兼容，成功验证后才迁移；作用域不明的旧整串凭据只用于对应既有服务，不再自动跨站共享。旧明文输入只保存到权限受限文件，不打印值/前缀。受影响缓存统一设置权限，新协议不要求加密静态存储。

## 10. 错误与对用户的呈现

| 错误 | 含义与处理 |
| --- | --- |
| `NOT_PAIRED` | 引导一次性配对，不能自动相信未知插件 |
| `RELAY_PORT_BUSY` | 截止时间内未取得监听权，给出端口与重试提示，不终止占用者 |
| `EXTENSION_UNAVAILABLE` | 浏览器未及时响应；提示打开浏览器/启用插件 |
| `PAIRING_MISMATCH` | 签名或 Profile 不匹配；不降级到匿名协议 |
| `COOKIE_NOT_FOUND` / `MISSING_REQUIRED_COOKIE` | 在指定 Profile 和 URL 下未取得需要字段，提示登录目标网站 |
| `CREDENTIAL_REJECTED` | candidate 验证失败，保留旧缓存，结束自动刷新 |
| `UNSUPPORTED_SOURCE` / `UNSUPPORTED_COOKIE_CONTEXT` | 指定来源/分区上下文超出第一版范围 |
| `CANCELLED` / `DEADLINE_EXCEEDED` | 清理任务及子进程，返回上层 |
| `INVALID_REQUEST` / `RESULT_TOO_LARGE` | 调用参数或返回超限，不扩大范围、不截断凭据 |

正常日志仅输出服务名、Profile 标签、阶段、耗时和错误码。禁止 Cookie/Token 值、前缀、完整鉴权响应、配对密钥进入日志。原始 HTTP 错误体先分类和脱敏，再交给 CLI。进程内清理指释放引用，不承诺 JavaScript 字符串能从物理内存立即擦除。

## 11. 验证与验收

采用现有 `node --test tests/*.test.mjs` 体系，测试只使用虚构凭据；不依赖开发者真实登录态。重点验证行为而不是镜像实现。

1. 缓存有效：业务成功，未 fork relay，插件未收到任务。
2. 缺缓存、一次明确失效：触发一次读取，验证后缓存；第二次失效停止。
3. 500/超时/普通403：不启动 relay；Paoding 匿名成功不取 Cookie。
4. 使用实际 Node 子进程和端口验证成功、取消、父进程退出、超时后释放监听，不遗留子进程。
5. 同进程并发合并、两个 CLI 端口竞争、外部端口占用；不错误交付结果或杀陌生进程。
6. 错误 MAC、冒充 relay、重放 nonce、过期租约、错误 Profile、迟到/重复结果全部可预测处理。
7. URL 的父域/hostOnly、path、secure、过期、同名 Cookie，按浏览器 API 语义匹配；拒绝空范围、非 HTTP(S)、分区/隐身请求。
8. 浏览器 worker 中断、alarm 恢复、ACK 丢失，重领/重传仍不重复交付；没有通用完成缓存残留。
9. 无认证外部 `getCookies`、旧网关 cookie 命令及配置改写不能绕过新路径。
10. 写操作响应未知不自动重放，Dinsight 已开始输出不自动重复提问。
11. 缓存原子写、并发合并、旧缓存兼容与文件权限；stdout/stderr/错误对象无测试凭据标记。

手工联调单独进行：Chrome 与 Edge 普通 Profile；首次配对；浏览器保持打开但 worker 已休眠；浏览器关闭/设备睡眠后恢复；缺失和过期凭据的只读验通。真实网站按可用账号逐项验证，记录环境与时间，不把 Node mock 测试当作网站登录成功证据。联调不触发真实构建或部署。

## 12. 实施顺序与回退

1. 完成协议和 Node 临时进程生命周期，以模拟扩展验证任务/清理/并发。
2. 完成插件配对、alarm、Cookie 获取、旧入口约束，用虚构数据做双端测试。
3. 先接服务云 MySQL、Dinsight、Apollo 只读预检与 Paoding 匿名优先修正。
4. 再接 Shipwright、FeCI、服务云交付的凭据验证，保持已有写操作约束。
5. 更新 SKILL.md、安装与配对指南，进行真实浏览器只读联调。

提供 `LEO_INSPECTOR_BROWSER_CREDENTIALS=off` 关闭自动获取；关闭后保留手工配置与旧缓存读取。不得以回退为理由重新打开无认证 Cookie 导出。技术方案批准后再编写逐文件实施计划，本次不修改产品脚本。

## 13. 官方依据

- Chrome Developers：Cookies API 的 URL 匹配、HttpOnly 元数据、同名 Cookie 顺序、storeId 与 partitionKey。
  `https://developer.chrome.com/docs/extensions/reference/api/cookies`
- Chrome Developers：Alarms 的调度延迟、设备睡眠及启动时检查 alarm 的建议。默认 60 秒是本方案取值，不是延迟保证。
  `https://developer.chrome.com/docs/extensions/reference/api/alarms`
- Chrome Developers：Manifest V3 service worker 会在空闲时终止，设计必须容忍意外停止。
  `https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`
- Chrome Developers：Storage API 的可信上下文访问限制。
  `https://developer.chrome.com/docs/extensions/reference/api/storage`

以上官方页面于 2026-10-09 查阅。方案不依赖最新版本特有的 alarm 持久化开关，使用启动时检查/重建的兼容方式。
