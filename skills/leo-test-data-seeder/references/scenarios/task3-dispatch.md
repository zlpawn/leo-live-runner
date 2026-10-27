# Task 3 · 社区服务单 → 派单通知

> 场景 ID：`sms-task3-dispatch`
> 对应需求：智能门锁短信降本改造 Task 3

## 验证目标

`OtherOrderService.doSendDispatchNotice` 的三路分流：

| 条件 | 预期行为 |
|---|---|
| `REPAIR` + `hui_ju`（自研门锁维修） | **强制短信**，与开关无关 |
| 其他工单 + 开关开 + 有 UCID | 服务者 App Push（`BJFWZ_LIUCHENGTONGZHI`，`scheme=""`） |
| 开关关 或 无 UCID | 短信 `order_dispatch_notice` |

**开关**：`order.dispatch.servicer.app.push.enable`（默认 `false`）

**入口**：Kafka `beijia-service-order-change`，`eventType=5`（下单/路由）

---

## precheck 前置检查

| 检查项 | 能力调用 | 说明 |
|---|---|---|
| 服务单存在且可查 | 家服 `OrderQueryFacade#getOrderDetail` | 旧单重放返回 `code:1` |
| 商品是门锁类 | `commodity.resolveByShelfCode` | 非门锁商品会被判「非智能设备」 |
| 派单角色配置 | Apollo `order.dispatch.roleCodes` | 为空则「未设置派单通知角色」 |
| 供应商可派单 | Apollo `order.dispatch.commodityCode` | 不在内则「无需自动派单」 |
| 通知范围配置 | Apollo `order.dispatch.notice.orderTypes` | 不含该工单类型则跳过 |

---

## seed 最小补齐

用 `order.ensure` 创建真实工单。家服建单成功后会自动发 eventType=5 消息。

**无需手动指定 ID**——用 `discover` 找到合同与商品后，用 `order.ensure` 建单：

```js
// 安装单
const ins = await capabilities.discover.findContractWithUsableEquity({
  templateCode: 'lock_install', workOrderType: 'INS'
}, ctx);
// 维修单
const fix = await capabilities.discover.findContractWithUsableEquity({
  templateCode: 'trusteeship_lock_fix', workOrderType: 'REPAIR'
}, ctx);
```

`discover` 返回的 `handle` 里已含 `contractId`、`templateInstId`、`shelfCode`，直接传给 `order.ensure`。
> 维修单走 `REPAIR + hui_ju` 分支，即使 Push 开关开着也走短信——这是**设计**，不是 bug。

---

## trigger 触发

**优先重放已存在消息**（避免重复建单）；需要新单时才 `order.ensure`。

```js
{
  mode: 'execute',
  action: 'kafka',
  detail: {
    topic: 'beijia-service-order-change',
    payload: {
      serviceCode: '10003',
      eventType: 5,
      originalServiceOrderStatus: 0,
      serviceOrderType: 17,
      eventDesc: '路由',
      originalServiceOrderStatusDesc: '初始态',
      creatorUcid: '0',
      orderCode: 'T010020261026<客服手机号>9',
      serviceOrderStatus: 5,
      serviceOrderCode: '<serviceOrderCode>',
      serviceOrderStatusDesc: '供应商已接单',
      time: Date.now()
    }
  }
}
```

---

## assert 断言

### 前置断言（否则链路没走到派单）

| 证据 | 内容 |
|---|---|
| 日志（必须） | `doEventProcess HandleAddOrder: workOrderType=安装\|维修, manufacturerCode=hui_ju` |

没有这行说明在商品判定就断了（`非智能设备相关商品无需处理`）。

### 服务者 App Push 分支

| 证据 | 内容 |
|---|---|
| 日志（必须） | `dispatchNotify: 服务者 App Push 发送成功, orderCode=` |
| 日志 | `from_ucid=BJFWZ_LIUCHENGTONGZHI` |
| payload | `"scheme":""` |
| payload 文案 | 含「请尽快派单处理」，**不含**「登录后台派单链接」 |
| 负向断言 | 无 `order_dispatch_notice` |

### 自研维修强制短信分支

| 证据 | 内容 |
|---|---|
| 日志（必须） | `templateName":"order_dispatch_notice` |
| 日志 | `phoneList` 含调度员手机号 |
| 负向断言 | **无** `服务者 App Push` |

### 开关关兜底分支

同「自研维修强制短信」的断言。

---

## cleanup 清理

`order.reverse({orderCode})` —— 调家服取消接口。

---

## 常见问题

| 现象 | 根因 | 处理 |
|---|---|---|
| `非智能设备相关商品无需处理` | 商品不是门锁类 | 用 `commodity.resolve({workOrderType})` 重新选门锁商品 |
| `code:1 获取订单详情异常` | 重放旧订单，家服拒绝 | 用新建订单或近期正常订单 |
| `厂商 xxx 无需自动派单` | 供应商不在 `order.dispatch.commodityCode` | 换供应商或改 Apollo |
| hui_ju 维修单没走 Push | **设计如此** | 断言按短信校验 |
