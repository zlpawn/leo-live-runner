# 协同 `leo-live-inspector` 进行测试环境查数、造数与日志排查

本 Skill 不绑定 `leo-test-data-factory`，也不硬编码任何本地后端仓库路径或测试库密码。所有测试环境数据查询、补齐与后端日志诊断，均通过 **`leo-live-inspector`** 在用户指定的后端项目工作目录下执行。

---

## 1. 工作目录要求

- 执行 `leo-live-inspector` 相关脚本时，应首先向用户确认**后端项目所在工作目录**（例如包含目标接入服务或平台服务源码与 `application-test.yml` 的目录），或直接使用当前所处的后端工程目录。
- 这样 `leo-live-inspector` 会自动嗅探该工程下的 `application-test.yml` 并缓存测试库连接凭据，无需在 `leo-hardware-runtime` 中保存任何数据库密码或项目路径。

---

## 2. 联调前 Pre-flight：查询设备三元组与密钥

在进行真实后端联调前，通过 `leo-live-inspector` 的 `scripts/test_mysql_query.js` 核验设备是否已在测试库录入（以门锁接入场景为例）：

1. **查询指定 IMEI 是否存在及其 `tk_key`**：
   - 目标工程目录（或服务别名）由当前后端仓库决定，例如查询 `lock_hardware_info`：
   ```sql
   SELECT id, bar_code, imei, tk_key, valid_status, product_num
   FROM iot_plat.lock_hardware_info
   WHERE imei = '<IMEI>'
   ```
2. **反查某个 `tk_key` 实际绑定的 IMEI**：
   ```sql
   SELECT id, bar_code, imei, tk_key, valid_status
   FROM iot_plat.lock_hardware_info
   WHERE tk_key = '<TK_KEY>'
   ```
3. **常见根因**：如果固件发送 `0x8001` 鉴权包后，服务端立即关闭 TCP 连接且返回 0 字节（`Remote server closed connection (0 bytes received)`），通常就是 `lock_hardware_info`（及/或 `house_lock`）中查不到该 IMEI，导致后端抛出异常并 `ctx.close()`。

---

## 3. 测试环境缺数时的处理流程（严禁静默写入）

当核验发现测试库缺少目标 IMEI / `tk_key` 记录时，按以下两阶段执行：

1. **阶段 1（确认）**：
   - 向用户说明缺失的表记录（例如缺少 `iot_plat.lock_hardware_info` 中的 `imei`、`bar_code`、`tk_key`），展示**拟插入/更新的 SQL Diff 或接口参数**，询问用户是：
     - (A) 由用户提供已入库的 IMEI 与 `tk_key`；还是
     - (B) 确认通过 `leo-live-inspector` 写入一条测试记录。
2. **阶段 2（执行与回查）**：
   - 用户明确确认后，在后端工程目录下调用 `leo-live-inspector` 的 `scripts/test_mysql_query.js` 执行写入（`INSERT` 或带严格 `WHERE` 的 `UPDATE`），并立即 `SELECT` 回查确认生效。

---

## 4. 联调中排查后端日志

当固件发送数据包后后端无响应、断连或业务结果不符合预期时，通过 `leo-live-inspector` 的 `scripts/test_log_query.js` 在对应测试泳道/应用下检索实时日志（关键词可用设备 `IMEI`、`认证`、`解密`、`0x8001` 等），实现端云双视角联合排障。
