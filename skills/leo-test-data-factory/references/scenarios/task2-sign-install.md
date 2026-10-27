# Task 2 · 出房签约 → 在途安装单提醒

> 场景 ID：`sms-task2-sign-install`
> 对应需求：智能门锁短信降本改造 Task 2

## 验证目标

`TrusteeshipContractService.sendInstallOrderNoticeToManager` 的开关分流：

| 条件 | 预期行为 |
|---|---|
| 开关开 + 有 UCID | 按 UCID 逐个 Link Push（`scheme=""`） |
| 开关关 | 短信 `install_order_notice_to_manager` |

**开关**：`install.order.notice.manager.link.push.enable`（默认 `false`）

**入口**：Kafka `contract-change-event-test`

```json
{
  "detail": {
    "bizType": 2,        // 出房合同
    "subBizType": 1,     // 标准合同
    "status": 2,         // 已签约
    "eventType": 1103,   // 上传合同
    "contractCode": "TGCF...",
    "houseCode": <houseId>,
    "cityCode": "320500"
  }
}
```

---

## precheck 前置检查

| 检查项 | 能力调用 | 说明 |
|---|---|---|
| 房源有在途安装单 | `installOrder.resolve({houseId, inFlight:true})` | **必须 `status=4 AND order_status IN (1,2,3)`** |
| 房源有**收房**合同 | `contract.resolve({houseId, bizType:1, status:2})` | 出房合同不算 |
| 收房合同有任务处理人 | `managerTask.resolve({contractCode: 收房合同号})` | `upstream_code` 用**收房**号 |
| 出房合同已签约 | `contract.resolve({houseId, bizType:2, status:2})` | 用于构造消息 |

**两个致命陷阱**：

1. `installOrder` 缺 `status=4` 就查不到（`checkInstallOrder` 的查询条件）
2. `managerTask.upstream_code` 必须是**收房**合同号，用出房号查两次都空

---

## seed 最小补齐

`installOrder.ensure`（若缺）+ 必要时 `managerTask.ensure`。

**无需手动指定 ID**——用 `discover` 自动找现成可用的组合：

```js
const found = await capabilities.discover.findSignInstallCombination({
  cityCode: '320500'   // 可选，不传则全城市扫
}, ctx);
// found.handle = { inContractCode, houseId, cityCode, dealUsers[] }
```

拿到 `houseId` 后：
1. `installOrder.resolve({ houseId, inFlight: true })` 确认有在途安装单（缺则 `installOrder.ensure`）
2. `contract.resolve({ houseId, bizType: 2, status: 2 })` 找出房合同用于构造消息

---

## trigger 触发

```js
{
  mode: 'execute',
  action: 'kafka',
  detail: {
    topic: 'contract-change-event-test',
    broker: 'kafka01-test.lianjia.com:9092',
    payload: {
      detail: {
        bizType: 2, subBizType: 1, status: 2, eventType: 1103,
        contractCode: '<出房合同号>',
        houseCode: <houseId>,
        cityCode: '320500',
        timeStamp: Date.now()
      },
      traceId: ''
    }
  }
}
```

---

## assert 断言

### 前置断言（否则链路没走到通知点）

| 证据 | 内容 |
|---|---|
| 日志 | `【新签】new sign houseCode = <houseId>` |
| 日志 | 收房合同查询返回 `bizType=1` |
| 日志 | `获取租务侧任务的处理人成功` 且 `data` 非空数组 |

### Link Push 分支

| 证据 | 内容 |
|---|---|
| 日志（必须） | `签约在途安装单提醒 Link Push 发送完成, ucid=` |
| 日志 | `from_ucid=LINK_BEIKEZULIN` |
| payload | `"scheme":""` |
| 负向断言 | 无 `install_order_notice_to_manager` |

每个 UCID 一条 Push，数量应等于 `task_relation` 中 `is_delete=0` 的记录数。

### 短信兜底分支

| 证据 | 内容 |
|---|---|
| 日志（必须） | `templateName":"install_order_notice_to_manager` |
| 日志 | `收房签约成功存在在途门锁安装工单发送短信提醒结果：... result:true` |
| 负向断言 | 无 `Link Push 发送完成` |

---

## cleanup 清理

1. `installOrder.reverse({id})` —— 仅当 `source='created'`
2. `house.reverse({houseId})` —— 仅当 `source='created'`

---

## 常见问题

| 现象 | 根因 | 处理 |
|---|---|---|
| 走不到通知点 | `queryTaskDealUsers` 返回空 | `upstream_code` 改收房合同号 |
| 走不到通知点 | 在途安装单查不到 | 检查 `status=4` 和 `order_status` |
| 只有短信没有 Push | 开关未开 | 用 `-Dinstall.order.notice.manager.link.push.enable=true` 本地覆盖 |
