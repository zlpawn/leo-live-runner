# Credential Relay Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Steps use checkbox syntax for tracking.

**Goal:** 自动从已登录浏览器获取 Cookie/Token，按需监听、取完退出。
**Architecture:** 业务进程内临时 Node HTTP relay；插件 alarm 低频领取任务；轻量 session helper 处理一次刷新，现有缓存继续复用。
**Tech Stack:** Node ESM / node:test / Chrome MV3，无新增运行时依赖。
**Spec:** docs/superpowers/specs/2026-10-09-credential-relay-design.md

## Global Constraints

- 127.0.0.1:19528，60 秒插件探测，默认 180 秒超时；两个 POST JSON 端点。
- 无配对或签名；信任本机；单普通 Profile；凭据不输出日志。
- Cookie 来源第一版仅浏览器 cookies API；names/URL 通用。
- Paoding 匿名优先；FAST 不强制凭据；写请求不自动重放。

## Review Focus

- 浏览器 worker 重启/响应丢失不能造成无限等待。
- 显式凭据不能被自动浏览器账号替换。
- 普通 403/500/网络失败不能触发凭据刷新。
- Shipwright 与服务云不能互发整串 Cookie。
- 取消、端口占用、异常均释放本进程资源。

## Task 1: Relay 与插件

Files: scripts/credential_relay.js, resources/chrome_extension/credential-relay.mjs, background.js, poll-loop.mjs, tests/credential-relay.test.mjs
Interface: getBrowserCookies({url,names,timeoutMs,signal}) -> Promise<Cookie[]>; createCredentialRelayClient({chromeApi,fetchImpl}) -> {poll,start}.
- [x] 添加真实 loopback HTTP 测试，覆盖 poll/result/URL 筛选/关闭/取消/超时/占用/网页 Origin。
- [x] 运行测试观察未实现失败。
- [x] 实现 relay、插件模块及低频探测；旧离线循环按 alarm 恢复。
- [x] 运行测试确认通过。

## Task 2: 自动刷新与业务接入

Files: scripts/common/browser_credentials.js, common/credentials.js, cloud_mysql_query.js, test_log_query.js, apollo_modify.js, dinsight_query.js, ci_deploy.js, feci_deploy.js; tests/browser-credentials.test.mjs, tests/credential-relay.test.mjs
Interface: createCredentialSession({load,save,explicit,anonymous,names,fromCookies,isAuthFailure,isSuccess,getCookies}) -> {run(url,send,{readOnly}), current()}.
- [x] 编写缓存命中/缺失/一次401刷新/403和500不刷新/显式覆盖/写不重放/失败不保存测试并观察失败。
- [x] 实现轻量 session helper，接入实际 HTTP 入口；所有取得凭据先只读验通再缓存。
- [x] 用 CLI HTTP fixtures 证明 Paoding 匿名成功、Cloud/MySQL 自动获取与 CI 域隔离；保留已有测试。
- [x] 缓存原子写、修复 token 前缀日志和云 token 更新保留字段。

## Task 3: 文档、回归和审查

- [x] SKILL.md/扩展 README 更新安装后自动获取行为、超时和单 Profile 限制。
- [x] npm test 全套通过、node --check 语法检查、git diff --check。
- [x] 独立审查并修正关键问题；不调用真实写接口，不把 mock 测试冒充真实浏览器验通。

## Execution ledger

- 用户已明确要求基于精简方案实现；直接在当前会话执行，不再次询问计划或执行方式。
- 功能分支 codex/credential-relay；保持当前路径，避免已安装 skill 的符号链接指向旧实现。
- Hindsight 未暴露可调用工具；代码图在 skill 子目录无结果，使用文件读取补充。

- 完成：relay + 扩展自动领取、URL/name 筛选、60 秒 alarm、结果/取消/超时关闭；缓存一次刷新接入 Cloud/MySQL、Apollo Portal、Dinsight、CI/FeCI 与 Paoding。
- 审查修复：排队时间计入获取超时；Paoding 匿名失败后先尝试手动缓存；Cloud catalog 缺 token 时可自动获取；Shipwright 使用独立缓存；浏览器返回相同失效凭据不重试。
- Ruling: Cookie 文件导入统一按目标 URL 校验域、路径、secure、expiry，并支持 HttpOnly 前缀；Cloud MySQL 复用公共加载器且缓存优先 — 避免跨站 Cookie 混用及旧导出文件覆盖刷新结果 — 未适用于目标 URL 的旧导出凭据将不再导入，可由浏览器自动获取。
- 回归证据：Cookie 文件域隔离测试先失败后通过；Cloud 缓存优先测试观察到旧解析器覆盖缓存，统一加载后通过。补充扩展空闲不读 Cookie、排队取消、关闭开关及 CI 写请求 401 不重放测试。
- 最终验证（2026-10-10）：skill 根目录 `npm test` 96/96 通过；18 个变更 JS/mjs 文件 `node --check` 通过；`git diff --check` 通过。
- 使用文档更新：扩展版本 1.3.0，安装后重新加载、浏览器登录即可；自动获取默认开启，手动参数保留；FAST 与 ConfigService 不新增凭据要求。
- 验证边界：真实 loopback HTTP + 扩展模块 + CLI 模拟业务响应已验证；未操作真实 Chrome 登录态或触发真实构建/部署。真实扩展重载与 worker 休眠恢复仍需只读联调。
- 交付方式：保留当前功能分支和工作目录，提交实现；未获 push/合并请求，故不执行远程集成，也不增加收尾确认步骤。
