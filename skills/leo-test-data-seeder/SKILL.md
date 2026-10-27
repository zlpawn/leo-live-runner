---
name: leo-test-data-seeder
description: 测试环境数据构造与业务流程编排中枢。面向研发自测与 QA 测试，提供两层能力：(1) 原子能力层——构造/查询房源、门锁、合同、权益、商品、家服订单、在途安装单、任务处理人等测试数据，实现方式对使用者透明（改表或调接口）；(2) 业务流程层——编排原子能力完成端到端场景，如创建安装单、创建维修单、签约通知、派单通知、低电量通知等，每个场景自带前置检查、最小补齐、触发、断言与清理五段流程。内置测试环境连接配置，无需代码仓库权限即可使用。适用于 IOT 智能门锁短信/推送通知类需求的功能验证、联调与回归。
---

# 🧪 Leo Test Data Seeder（测试数据构造与业务流程编排）

本 Skill 面向**研发自测与 QA 测试**，把「造测试数据」这件事拆成两层可复用的能力：

- **原子能力层**：造/查某一类数据（房源、合同、权益、商品、订单……），使用者不关心底层是改表还是调接口；
- **业务流程层**：编排原子能力，完成一个端到端场景（创建安装单、维修单、签约通知……），自带断言与清理。

> ⚠️ **【核心执行原则：AI 全自动后台执行】**
> - 用户只需用自然语言表达意图（如 *“帮我造一份上海带门锁安装权益的合同和房源”*、*“验证一下安装单的派单通知”*）。
> - AI 必须在后台自动解析意图，先跑 `precheck` 体检，再决定是否造数、如何触发、如何断言。
> - **默认只读模式**：任何写操作（INSERT / 调创建接口 / 发 Kafka 消息）执行前必须显式确认，或由用户明确开启执行模式。
> - **切勿在回复中输出“请您手动运行 node scripts/...”等推卸给用户的言论。**

---

## 一、分层模型

```
┌─────────────────────────────────────────┐
│  业务流程层 (scripts/scenarios/*)          │
│  创建安装单 / 创建维修单 / 签约通知 / ...    │
│  只做编排，不关心数据落在哪张表              │
└──────────────────┬──────────────────────┘
                   │ 调用 ensure / resolve
┌──────────────────▼──────────────────────┐
│  原子能力层 (scripts/capabilities/*)       │
│  房源 / 门锁 / 合同 / 权益 / 商品 / 订单 ... │
│  实现方式不暴露：改表 or 调接口             │
└─────────────────────────────────────────┘
```

**三条铁律**

1. 业务流程只说「我需要一份带权益的上海合同」，不关心它来自查库还是造数据。
2. 原子能力对上层隐藏实现方式（SQL / HTTP / Kafka 都是内部细节）。
3. 原子能力必须幂等：同样的 spec 调 `ensure` 两次，不产生两份数据。

---

## 二、原子能力索引

| 能力 | 类型 | 载体 | 参考文档 |
|---|---|---|---|
| `house` 房源 | ✅ 可造 | `iot_plat.house_info` | [capabilities.md](references/capabilities.md#house) |
| `lock` 门锁 | ✅ 可造 | `iot_plat.house_lock` | [capabilities.md](references/capabilities.md#lock) |
| `installOrder` 在途安装单 | ✅ 可造 | `iot_plat.install_order_detail` | [capabilities.md](references/capabilities.md#installorder) |
| `managerTask` 任务处理人 | ✅ 可造 | `manager_workbench.manager_task` + `task_relation` | [capabilities.md](references/capabilities.md#managertask) |
| `order` 家服订单 | ✅ 可造（调接口） | `POST /api/manager/cloud/maintain/create` | [capabilities.md](references/capabilities.md#order) |
| `contract` 合同 | ⚠️ 仅查 | `trusteeship_contract.contract` | [capabilities.md](references/capabilities.md#contract) |
| `equity` 权益 | ⚠️ 仅查 | `sun_core` 三表 + `beijia_goods_range` | [capabilities.md](references/capabilities.md#equity) |
| `commodity` 商品 | ⚠️ 仅查 | `beijia_commodity` 五表 | [capabilities.md](references/capabilities.md#commodity) |
| `discover` 自动发现 | ⚠️ 仅查 | 组合上面多个能力 | [capabilities.md](references/capabilities.md#discover) |

> **`discover` 是开箱即用的关键**：测试环境数据天天变，使用者不该被要求知道某个合同号。`discover.findContractWithUsableEquity()` 会实时扫描「已签约 + 有权益 + 商品在白名单内」的可用组合，直接返回 `contractId`、`templateInstId`、`shelfCode`。

> **为什么合同/权益/商品「仅查」不「造」**：合同有几十个字段和状态机、权益要三张表加白名单联动、商品要五张表加各城市货架码。从零造基本是脏数据，且极易造成跨系统不一致。这类能力的 `ensure` 等价于 `resolve`，查不到时**明确告诉你缺什么**，绝不退化成硬造。

---

## 三、业务流程场景索引

| 场景 | 说明 | 可执行 | 文档 |
|---|---|---|---|
| `sms-task1-auto-install` | 全自动下单 → 租务管家通知（Link Push / 短信） | `task1-auto-install.js` | [md](references/scenarios/task1-auto-install.md) |
| `sms-task2-sign-install` | 出房签约 → 在途安装单提醒（Link Push / 短信） | `task2-sign-install.js` | [md](references/scenarios/task2-sign-install.md) |
| `sms-task3-dispatch` | 社区服务单 → 派单通知（服务者 App Push / 短信） | `task3-dispatch.js` | [md](references/scenarios/task3-dispatch.md) |
| `sms-task4-customer-service` | 自研门锁维修单 → 客服跟进短信（限额轮转） | `task4-customer-service.js` | [md](references/scenarios/task4-customer-service.md) |
| `sms-task5-low-battery` | 门锁低电量 → 管家短信（城市白名单拦截） | `task5-low-battery.js` | [md](references/scenarios/task5-low-battery.md) |

### 运行方式

```bash
node scripts/run.js --list                          # 列出所有场景
node scripts/run.js sms-task1-auto-install          # 只读体检（不写数据）
node scripts/run.js sms-task1-auto-install --execute          # 完整执行
node scripts/run.js sms-task1-auto-install --execute --cleanup # 执行并清理
```

只读模式输出「体检报告」，告诉你前置条件是否齐备、缺什么。`--execute` 才会真正造数和触发。

每个场景固定五段流程：

```
precheck → seed → trigger → assert → cleanup
```

- **precheck**：体检，明确区分「已有可复用 / 需补齐 / 无法补齐」，不写任何数据
- **seed**：只补最小集，全部记账
- **trigger**：触发（HTTP 或 Kafka），只读模式下仅打印
- **assert**：断言链路是否真的生效（日志 / 落库 / 缓存三类证据）
- **cleanup**：按账本反向清理，只清 `source=created` 的

---

## 四、统一返回结构

所有 `resolve` / `ensure` 返回同一结构：

```js
{
  ok: boolean,
  handle: { type, id, key, meta } | null,
  source: 'reused' | 'created' | null,
  cleanup: { reversible, kind: 'sql'|'api'|'none', payload } | null,
  reason: 'equity_not_in_goods_range',   // 机器可读原因码
  message: '...',                        // 人可读说明
  missing: ['equity'],                   // 缺哪类前置
  candidates: [...]                      // 候选方案
}
```

**两个关键字段**

- `source`：只有 `created` 的才进清理账本。`reused` 是别人的数据，不能删。
- `cleanup`：不清理会导致**第二次跑结论就是错的**（实测踩过：残留门锁导致报「房源已安装门锁」、残留安装单导致读到旧单、Redis 计数被推到 300 导致直接轮转）。

---

## 五、运行模式与安全护栏

### 5.1 两种模式

| 模式 | resolve | ensure | trigger | 用途 |
|---|---|---|---|---|
| `readonly`（默认） | ✅ | 退化为 resolve | ❌ 只打印 | 查数据、看缺什么 |
| `execute` | ✅ | ✅ | ✅ | 端到端验证 |

### 5.2 护栏（必须遵守）

1. **Kafka 消息是广播的**：本地用新消费组时，测试环境部署实例**也会消费同一条消息**，短信/Push 会发两遍。已确认测试环境可接受重复，但仍需在触发前提示。
2. **Apollo 开关不要改全局**：验证开关类逻辑时用 `-Dkey=value` 覆盖本地进程，不改测试环境 Apollo。
3. **凭据内置，开箱即用**：连接信息与测试库密码内置在 `resources/systems.json`（仅限内网测试环境，公网不可达）。如需切换环境，用环境变量 `SEEDER_<SYSTEM>_PASSWORD` 覆盖，优先级最高。
4. **写操作二次确认**：家服建单、Kafka 发消息、任何 INSERT，执行前打印影响面。

---

## 六、连接配置

**已内置**在 [resources/systems.json](resources/systems.json)，含主机、库名与测试环境密码，克隆即可运行：

| 逻辑系统 | 用途 |
|---|---|
| `iot-platform` | `iot_plat` 库（房源/门锁/安装单/维修单/通知记录） |
| `manager-workbench` | `manager_workbench` 库（任务处理人） |
| `trusteeship-contract` | `trusteeship_contract` 库（合同） |
| `sun-core` | `sun_core` 库（权益包/模板/适用范围） |
| `beijia-commodity` | `beijia_commodity` 库（商品/货架/服务项/价格） |
| `iot-redis` | 测试 Redis（短信日计数等） |
| `beijia-trade-access` | 家服 HTTP（创建/取消订单） |
| `kafka` / `apollo` | 测试 Kafka 集群与 Apollo ConfigService |

**使用者无需代码仓库权限**，也无需任何额外配置。

> 内置的是内网测试环境信息，主机域名（`*.mars.test.*`）公网不可达。切换环境用环境变量 `SEEDER_<SYSTEM>_PASSWORD` 覆盖。

---

## 七、高频坑清单（实战验证）

完整清单见 [pitfalls.md](references/pitfalls.md)，这里列最致命的几条：

| 现象 | 根因 | 解法 |
|---|---|---|
| `未找到有效房源地址` | 缺 `house_info` | `house.ensure` |
| `房源已安装门锁` | `house_lock` 存在 | `lock.ensureAbsent` 或换房源 |
| 家服报 `无可用权益`（权益实例其实存在） | `beijia_goods_range` 白名单不含该城市货架码 | `equity.resolve` 的二次校验 |
| 在途安装单查不到 | `status≠4` 或 `order_status∉(1,2,3)` | `installOrder.ensure` 默认值 |
| `queryTaskDealUsers` 返回空 | `upstream_code` 用了出房合同号 | 改用**收房**合同号 |
| `非智能设备相关商品无需处理` | 商品编码不是门锁类 | `commodity.resolve` 按 `workOrderType` 过滤 |
| 自研 hui_ju 维修单没走 Push | **这是设计**：`REPAIR + hui_ju` 强制走短信 | 断言时按短信校验 |

---

## 八、使用示例（自然语言 → 后台动作）

| 用户说 | AI 后台执行 |
|---|---|
| “查一下上海有没有带门锁安装权益的合同” | `equity.resolve` + `contract.resolve`，输出候选表 |
| “帮我造一个能跑安装单通知的房源和合同” | `precheck` → 报告缺什么 → 确认后 `seed` |
| “验证一下派单通知走的是 Push 还是短信” | 跑 `sms-task3-dispatch`，输出断言结果 |
| “这个房源为什么报无可用权益” | `equity.resolve` 的二次校验，指出白名单缺哪个货架码 |
| “清理刚才造的数据” | 按账本逆序 `cleanup` |

---

## 九、文档索引

- [references/capabilities.md](references/capabilities.md) —— 原子能力接口契约（签名、字段、陷阱、反向清理）
- [references/scenarios/](references/scenarios/) —— 业务流程场景（每个场景一个独立文档）
- [references/pitfalls.md](references/pitfalls.md) —— 完整坑清单（现象 → 根因 → 解法）
- [references/data-model.md](references/data-model.md) —— 各系统库表结构与关键字段说明
