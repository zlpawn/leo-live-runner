# Task 1 · 全自动下单 → 租务管家通知

> 场景 ID：`sms-task1-auto-install`
> 对应需求：智能门锁短信降本改造 Task 1

## 验证目标

`LockOrderLogicImpl.sendAutoOrderDispatchNotice` 的开关分流：

| 条件 | 预期行为 |
|---|---|
| 开关开 + 有 UCID | Link Push（`LINK_BEIKEZULIN`，`scheme=""`） |
| 开关关 或 无 UCID | 短信 `zuwu_auto_order_dispatch_notice` |

**开关**：`zuwu.auto.order.dispatch.link.push.enable`（默认 `false`）

**入口**：`POST /zuwu/order/createAutoInstallOrder`，body `{"contractCode":"...","needDelay":false}`

---

## precheck 前置检查

| 检查项 | 能力调用 | 失败提示 |
|---|---|---|
| 合同存在且已签约 | `contract.resolve({contractCode})` | `contract_not_found` |
| 房源存在 | `house.resolve({houseId})` | `house_not_found`，需 `house.ensure` |
| 房源未装锁 | `lock.ensureAbsent({houseId})` | `lock_exists` → 报「房源已安装门锁」 |
| 权益 + 白名单 | `equity.resolve({contractId, templateCode:'lock_install', cityCode})` | `equity_not_in_goods_range` |
| 安装商品在白名单内 | `commodity.resolveWithWhitelist({cityCode, workOrderType:'INS', whitelist})` | `commodity_not_in_whitelist` |
| 城市开城 | Apollo `cloudManagerFullyAutoOrderDto` 含 cityCode | 「全自动下单当前城市未开城」 |

**关键顺序**：先 `equity.resolve` 拿白名单 → 再 `commodity.resolveWithWhitelist` 按白名单选商品。顺序反了会选中白名单外商品，家服报「无可用权益」。

---

## seed 最小补齐

通常只需补 `house`（若缺）。合同、权益、商品必须复用现成的。

**无需手动指定 ID**——用 `discover` 自动找现成可用的组合：

```js
const found = await capabilities.discover.findContractWithUsableEquity({
  templateCode: 'lock_install',
  cityCode: '310000',        // 可选，不传则全城市扫
  workOrderType: 'INS'
}, ctx);

// found.handle = {
//   contractCode, contractId, houseId, cityCode,
//   templateInstId, shelfCode, commodityCode, commodityName, whitelist
// }
```

> 测试环境数据天天变，硬编码 ID 很快就会失效。`discover` 会实时扫描「已签约 + 有权益 + 商品在白名单内」的组合。

---

## trigger 触发

```js
{
  mode: 'execute',
  action: 'http',
  detail: {
    method: 'POST',
    path: '/zuwu/order/createAutoInstallOrder',
    body: { contractCode: '<合同号>', needDelay: false }
  }
}
```

---

## assert 断言

### Link Push 分支

| 证据类型 | 断言内容 |
|---|---|
| 日志（必须） | `AutoOrderDispatchNotify: Link Push 发送成功` |
| 日志（必须） | `url:.../msg/groupsend/users` 且 `from_ucid=LINK_BEIKEZULIN` |
| 卡片 payload | `"scheme":""` 空串 |
| 负向断言 | 无 `zuwu_auto_order_dispatch_notice` |

### 短信兜底分支

| 证据类型 | 断言内容 |
|---|---|
| 日志（必须） | `templateName":"zuwu_auto_order_dispatch_notice` |
| 日志（必须） | `phoneList` 含管家手机号 |
| 负向断言 | 无 `LINK_BEIKEZULIN` |

---

## cleanup 清理

按依赖逆序：

1. `order.reverse({orderCode})` —— 家服取消（若已建单）
2. `house.reverse({houseId})` —— 仅当 `source='created'`

Redis 无需处理（本场景不涉及计数）。

---

## 常见问题

| 现象 | 根因 | 处理 |
|---|---|---|
| `无可用权益` | 白名单不含商品货架码 | 见 precheck 第 4/5 步 |
| `房源已安装门锁` | `house_lock` 存在 | `lock.ensureAbsent` |
| `未找到有效房源地址` | 缺 `house_info` | `house.ensure` |
| `没有查询到有效权益` | `jiafu.sun.code` 未配该城市 | 查 Apollo |
