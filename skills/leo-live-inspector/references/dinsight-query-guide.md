# 🧠 Dinsight 自然语言大数据探查参考手册

本手册说明如何在 `leo-live-inspector` 中复用现有 Chrome 插件获取凭证，直连 Dinsight Agent 查数。

---

## 1. 接口协议

- 前端：`https://dinsight.ke.com/`
- API：`https://api-dinsight.ke.com`
- 登录校验：`GET /api/v1/auth/me`
- 创建对话：`POST /api/threads`
- 提问查数：`POST /api/threads/{threadId}/runs/stream`（`text/event-stream`）

默认 Agent：`odin-data-agent-claude`，模型 `GLM-5.2`，模式 `flash`，集群 `cluster_id=100`（公共集群），空间 `space_id=0`（个人空间）。

---

## 2. 凭证获取

Dinsight 登录态在父域 `.ke.com`。插件按当前页域名过滤时，必须把顶部域名改成 **`ke.com`**。

### 2.1 首选：复制 Cookie 标头

用户动作：

1. 打开 `https://dinsight.ke.com/`，确认已经登录；
2. 点击 **Leo cookie.txt Locally**，域名填 `ke.com`；
3. 点击【复制 Cookie 标头】，把整串发给 AI。

AI 收到后必须：

1. 立刻后台执行 `node scripts/dinsight_query.js --set-token "<cookie-header>"`；
2. 再执行 `node scripts/dinsight_query.js --whoami --json` 验证登录；
3. **禁止把完整 Cookie / token 值回显给用户**；
4. 只告诉用户：已保存、实际保留了哪些 Key、当前登录账号。

脚本只会保留这 5 个 Key，其余全部丢弃：

| Key | 作用 |
| :--- | :--- |
| `prd-assistant-token-prod` | Dinsight 主登录态 |
| `access_token` | SSO 访问令牌，单拷主 Token 时常常 401 |
| `login_ucid` | 当前工号 |
| `security_ticket` | 安全票据 |
| `csrf_token` | 写接口 CSRF，请求头同时带 `X-CSRF-Token` |

整包 `.ke.com` Cookie 大约 100+ 条，原样带上会触发 `400 Request Header Or Cookie Too Large`。

### 2.2 次选：只复制主 Token

复制 `prd-assistant-token-prod` 后执行 `--set-token`。若 `/api/v1/auth/me` 返回 401，再请用户改复制 Cookie 标头。不要引导 F12 的 `document.cookie`，主 Token 是 HttpOnly。

本地持久化路径：`~/.shrimp/skills/live-inspector/dinsight_cookie.json`。

---

## 3. 提问

```bash
node scripts/dinsight_query.js "近7天北京成交量"
node scripts/dinsight_query.js --whoami
node scripts/dinsight_query.js --json "帮我看这个指标昨天有没有异常"
```

AI 拿到 SSE 摘要后，应结合本地代码、库表和业务口径做二次分析，而不是把原始流原样丢给用户。

---

## 4. 执行注意

- CLI 流式超时默认 **180 秒**。`scripts/common/http.js` 必须尊重调用方传入的 `timeout`，不能写死 10s。
- 解析 SSE 时拼接 `AIMessageChunk.content`，完整保留 `raw`。最终 markdown 表格通常在流尾。
- Cookie 标头只保留：`prd-assistant-token-prod`、`access_token`、`login_ucid`、`security_ticket`、`csrf_token`。整包 `.ke.com` Cookie 会 `400 Request Header Or Cookie Too Large`。
- ODS 表未接入时，改用对应 DW 表并说明分区口径。门锁 `open_time` 可能为 `2106-02-07` 脏数据，排序应结合 `ctime`。
