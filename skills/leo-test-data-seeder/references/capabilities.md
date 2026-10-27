# 原子能力接口契约

> 所有能力对上层隐藏实现方式。业务流程只调 `ensure`，不直接写 SQL 或调接口。

## 通用签名

```js
resolve(cond, ctx)   // 查一份符合条件的现成数据；查不到返回 ok:false，永不写库
ensure(spec, ctx)    // 保证存在：先 resolve，缺了再按类型决定造 or 报错
reverse(handle, ctx) // 按句柄撤销；幂等，已不存在视为成功
```

`ctx` 结构：

```js
{
  mode: 'readonly' | 'execute',
  systems: SystemsRegistry,   // 连接管理（见 scripts/common/systems.js）
  logger: Logger,
  ledger: Ledger              // 造数账本，记录每条 created 的反向操作
}
```

---

<a id="house"></a>
## house 房源 —— ✅ 可造

```js
resolve({ houseId } | { cityCode, houseType }, ctx)
ensure({ houseId, cityCode, houseType = 2, address }, ctx)
reverse({ houseId, houseType }, ctx)
ensureAbsent({ houseId, houseType }, ctx)   // 确保不存在（造安装单前用）
```

**载体**：`iot-platform` → `iot_plat.house_info`

| 项 | 内容 |
|---|---|
| 唯一键 | `house_id` + `house_type` |
| 必填 | `house_id, house_type, city_code, city_name, house_address, source_code='light', source_type=3` |
| 陷阱 | 缺失时 `createAutoInstallOrder` 报「未找到有效房源地址」；低电量、维修等链路也依赖它 |
| reverse | `DELETE FROM house_info WHERE house_id=? AND house_type=?` |
| 备注 | `standard_house_id`、`resblock_id` 可为空；`whole_house_code` 通常等于 `house_id` |

---

<a id="lock"></a>
## lock 门锁 —— ✅ 可造

```js
resolve({ houseId, houseType = 2 }, ctx)
ensure({ houseId, lockId, manufacturerCode, prodType }, ctx)
ensureAbsent({ houseId, houseType }, ctx)   // 造安装单前必须无锁
reverse({ lockId }, ctx)
```

**载体**：`iot-platform` → `iot_plat.house_lock`

| 项 | 内容 |
|---|---|
| 唯一键 | `lock_id` |
| 陷阱 | 房源已装锁时 `createAutoInstallOrder` 报「房源已安装门锁，请检查房源数据」 |
| reverse | `DELETE FROM house_lock WHERE lock_id=?` |
| 备注 | `lock_id` 在测试环境常是 32 位 hex（如 `<lockId>`），也可是数字串 |

---

<a id="contract"></a>
## contract 合同 —— ⚠️ 仅查

```js
resolve({ contractCode } | { contractId } | { houseId, bizType, status } | { cityCode, bizType }, ctx)
ensure  // 等价 resolve，永不造
resolveIdByCode(contractCode, ctx)   // contractCode → contractId
resolveCodeById(contractId, ctx)     // contractId → contractCode
```

**载体**：`trusteeship-contract` → `trusteeship_contract.contract`

| 字段 | 含义 |
|---|---|
| `id` | 合同ID（权益/任务表用这个） |
| `contract_code` | 合同号（业务消息用这个，如 `TG2610896839`） |
| `house_code` | 房源ID |
| `city_code` | 城市 |
| `biz_type` | 1=收房合同，2=出房合同 |
| `sub_biz_type` | 1=标准合同 |
| `status` | 2=已签约，3=履约中，6=已到期 |

**关键**：`contractId` 与 `contractCode` 是两个体系，跨表时必须显式转换。权益表用 `biz_code = contractId`，业务消息用 `contractCode`。

**不造原因**：字段数十个、有状态机、跨系统一致性要求高。

---

<a id="equity"></a>
## equity 权益 —— ⚠️ 仅查

```js
resolve({ contractId, templateCode, cityCode, shelfCode }, ctx)
ensure  // 等价 resolve
```

**载体**：`sun-core` → `sun_core` 库

**解析链**（三步，缺一不可）：

1. `package_instance`：`biz_code = contractId`、`city_code = cityCode`、`status = 1`
2. `template_instance`：`template_id = template.id`（按 `code` 匹配，如 `lock_install`）、`status = 2`、有效期覆盖当天
3. **`beijia_goods_range` 二次校验**：`template_id`、`type = 1`（白名单）、`col_four = shelfCode`

| 项 | 内容 |
|---|---|
| 常用模板 | `lock_install`(342) 安装、`trusteeship_lock_fix`(341) 维修、`lock_replace`(343) 迁移 |
| **最致命陷阱** | 权益实例存在但家服仍报「无可用权益」→ **90% 是第 3 步白名单不含该货架码** |
| 返回 | `handle.meta.instId`、`handle.meta.goodsRangeOk`、`handle.meta.whitelist` |
| 原因码 | `equity_instance_missing`、`equity_expired`、`equity_not_in_goods_range` |

**白名单缺口是常见现象**：某个城市有权益实例，但该城市的安装货架码不在 `beijia_goods_range` 白名单里，家服就报「无可用权益」。用 `discover.findContractWithUsableEquity` 可自动跳过这类组合。

**不造原因**：三张表联动 + 白名单，硬造极易造成跨系统不一致。

---

<a id="commodity"></a>
## commodity 商品 —— ⚠️ 仅查

```js
resolve({ cityCode, workOrderType, manufacturerCode? }, ctx)
ensure  // 等价 resolve
```

**载体**：`beijia-commodity` → `beijia_commodity` 库

| 表 | 作用 |
|---|---|
| `commodity_shelf_info` | 货架码 `shelf_code`(SCM…) ↔ 商品编码 `commodity_code`(CM…)，含城市、售价 |
| `commodity_info` | 商品主数据，`id` 用于权益白名单的 `goods_id` |
| `commodity_shelf_service_item` | 货架的服务项，`item_shelf_code` |
| `service_item_shelf_info` | 服务项详情，`amount` |
| `service_item_shelf_price_info` | 价格规则，`price_type=1` 是售价，`price_rule` 是价格字符串 |

**关键映射**：下单传 `shelf_code`(SCM…)，Apollo `device.commodityOrderTypeConf` 配的是 `commodity_code`(CM…)，**两者不可混用**。

**不要硬编码货架码**——用 `commodity.resolve` 按条件查：

```js
// 按城市 + 工单类型查门锁商品
const cmd = await capabilities.commodity.resolve({
  cityCode: '310000', workOrderType: 'INS'
}, ctx);
// handle.key = shelfCode, handle.meta.commodityCode
```

**商品名关键词映射**（用于自动过滤门锁类）：

| workOrderType | 商品名关键词 |
|---|---|
| `INS` | 安装 |
| `REPAIR` / `FIX` | 维修 |
| `REPLACE` | 迁移 |
| `RECYCLE` | 回收 |

`resolve` 默认还要求商品名含「门锁」，避免选到灯具等非门锁商品。

---

<a id="order"></a>
## order 家服订单 —— ✅ 可造（调接口）

```js
ensure({ houseResourceId, contractId, templateInstId, shelfCodeList, serviceTime, contact }, ctx)
reverse({ orderCode }, ctx)
```

**创建**：`POST {beijia-trade-access}/api/manager/cloud/maintain/create`

```json
{
  "houseResourceId": <houseId>,
  "contractId": <contractId>,
  "templateInstId": <templateInstId>,
  "commodityCodeList": ["<shelfCode>"],   // 由 commodity.resolve 或 discover 得到
  "emergencyType": 0,
  "contactUser": "...",
  "contactUserMobile": "...",
  "userRemark": "...",
  "serviceTime": "2026-10-27 09:00-12:00",
  "templateTagType": 1,
  "fromSource": "zuwu-auto-create-task",
  "channelCode": "newpuzuManager"
}
```

**取消**：`POST {beijia-trade-access}/api/manager/cloud/order/cancel`

```json
{ "orderCode": "T010020261026<客服手机号>9", "cancelReason": 1, "cancelRemark": "测试数据清理" }
```

| 项 | 内容 |
|---|---|
| 必带 Header | `X-BeiKe-Ucid`、`X-Ke-Sid` |
| 前置 | 房源 + 合同 + **权益实例且商品在白名单**，三者缺一必失败 |
| 返回 | `handle.key = orderCode`、`handle.meta.serviceOrderCode` |
| 副作用 | 创建成功后家服自动发社区服务单 Kafka 消息，可能触发下游通知（见 Task 3） |
| 工单类型 | 由商品决定，用 `commodity.resolve` 按 `workOrderType` 查即可 |

---

<a id="installorder"></a>
## installOrder 在途安装单 —— ✅ 可造

```js
resolve({ houseId, inFlight = true }, ctx)
ensure({ houseId, cityCode, thirdOrderCode?, status = 4, orderStatus = 1 }, ctx)
reverse({ id }, ctx)
```

**载体**：`iot-platform` → `iot_plat.install_order_detail`

| 项 | 内容 |
|---|---|
| **致命陷阱** | `checkInstallOrder` 查询条件是 `status = 4 AND order_status IN (1,2,3)`。**两个字段任一不符就查不到**，实测漏设 `status=4` 白排查一轮 |
| 默认值 | `status=4`、`order_status=1`、`house_type=2` |
| 必填 | `house_id, house_type, city_code, address, manufacturer_code, third_order_code, status, order_status` |
| reverse | `DELETE FROM install_order_detail WHERE id=?` |

---

<a id="managertask"></a>
## managerTask 任务处理人 —— ✅ 可造

```js
resolve({ contractCode, taskType = 4, bizType = 1 }, ctx)
ensure({ contractCode, taskType, bizType, dealUsers: [{ dealUserId, dealUserName, role }] }, ctx)
reverse({ taskId }, ctx)
```

**载体**：`manager-workbench` → `manager_workbench` 库

| 表 | 作用 |
|---|---|
| `manager_task` | 管家任务，查询键 `upstream_code` |
| `task_relation` | 任务处理人，`task_id` 关联、`is_delete=0` |

**查询条件**：`manager_task.upstream_code = 收房合同号 AND task_type = 4(门锁) AND biz_type = 1(签约)`，再取 `task_relation.task_id = 该任务 AND is_delete = 0`。

| 项 | 内容 |
|---|---|
| **致命陷阱** | `upstream_code` 必须是**收房合同**号（`biz_type=1`），不是出房合同号。实测用出房合同号查两次都空 |
| 角色取值 | `zuwuManager`（租务管家）、`ziguanManager`（资管经理） |
| 返回 | `handle.meta.taskId`、`handle.meta.dealUsers` |
| reverse | `DELETE FROM task_relation WHERE task_id=? AND id IN (...)` + `DELETE FROM manager_task WHERE task_id=?`（仅限本次新建的） |

---

<a id="discover"></a>
## discover 自动发现 —— ⚠️ 仅查

**这是 skill 开箱即用的关键**：不依赖任何硬编码 ID，实时扫描测试环境找出可用组合。

```js
// 找「已签约 + 有指定权益 + 商品在白名单内」的合同
findContractWithUsableEquity({ templateCode, cityCode?, workOrderType?, limit? }, ctx)

// 找「有门锁签约任务且有处理人」的收房合同（Task 2 用）
findSignInstallCombination({ cityCode?, limit? }, ctx)
```

### findContractWithUsableEquity

扫描逻辑：

1. 从 `sun_core` 找出所有持有指定模板有效实例（`status=2`）的合同ID + 城市
2. 逐个验证合同存在且 `status=2`（已签约）
3. 取该模板的 `beijia_goods_range` 白名单
4. 按白名单在该城市选商品
5. 三者都通过才算「可用」

**返回**：

```js
{
  ok: true,
  handle: {
    contractCode, contractId, houseId, cityCode,
    templateInstId,      // 可直接传给 order.ensure
    shelfCode, commodityCode, commodityName,
    whitelist
  },
  candidates: [ /* 其他可用组合 */ ],
  rejected: [ { contractId, cityCode, reason } ]
}
```

**典型用法**：

```js
// Task 1/3：找安装单所需的全部要素
const found = await capabilities.discover.findContractWithUsableEquity({
  templateCode: 'lock_install', cityCode: '310000', workOrderType: 'INS'
}, ctx);
if (!found.ok) {
  console.log(found.reason, found.message);
  // no_contract_with_equity  → 该城市没有持有此权益的合同
  // no_usable_combination    → 有权益但商品都不在白名单
}

// 直接拿结果建单
await capabilities.order.ensure({
  houseResourceId: found.handle.houseId,
  contractId: found.handle.contractId,
  templateInstId: found.handle.templateInstId,
  shelfCodeList: [found.handle.shelfCode]
}, ctx);
```

### findSignInstallCombination

从 `manager_workbench` 找「`task_type=4` + `biz_type=1` + 有 `task_relation`」的收房合同，返回 `inContractCode`、`houseId`、`cityCode`、`dealUsers`。

### 为什么需要它

文档里写死具体合同号、房源ID，过几天测试环境数据一变就失效，使用者还得自己找。`discover` 把这一步自动化——使用者只需说「验证安装单通知」，skill 自己去找当前可用的数据。
