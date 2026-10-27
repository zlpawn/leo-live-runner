# Task 4 · 自研门锁维修单 → 客服跟进短信

> 场景 ID：`sms-task4-customer-service`
> 对应需求：智能门锁短信降本改造 Task 4

## 验证目标

`SendMessageLogicImpl.sendMessageRepairOrderFollowUpWithFallback` 的五种行为：

| 条件 | 预期行为 |
|---|---|
| 首号码未达限额 | 发首号码，Redis 计数 +1 |
| 首号码达 300 | 轮转下一号码 |
| 首号码发送失败 | 轮转下一号码 |
| Redis 异常 | Fail-Open 放行（照常发送） |
| 非 `hui_ju` 维修单 | 静默跳过 |

**配置**：
- `repair.order.customer.service.phones`（默认 `["<客服手机号1>","<客服手机号2>"]`）
- `repair.order.customer.service.daily.limit`（默认 `300`）
- `repair.order.customer.service.fallback.enable`（默认 `true`）

**入口**：`POST /iot/repairOrders/add`

---

## precheck 前置检查

| 检查项 | 能力调用 | 说明 |
|---|---|---|
| 房源 + 门锁 | `house.resolve` + `lock.resolve` | 维修必须有门锁 |
| 售后厂商 = hui_ju | `lock.resolve().meta.afterSaleManufacturerCode` | 非 hui_ju 会跳过 |
| 客服跟进开城 | Apollo `repair.order.customer.service.city` | 含 `{manufacturer}.{cityCode}.orderType` |
| 商品编码可解析 | Apollo `iotCommunityLockOrderMap` 的 `FIX` 节点 | 否则「获取维修商品编码失败」 |

**无需手动指定 ID**——按条件查现成的 hui_ju 门锁房源：

```sql
-- 用 iot-platform 查一把可用于维修的 hui_ju 门锁
SELECT l.lock_id, l.house_id, h.city_code
  FROM house_lock l
  JOIN house_info h ON l.house_id = h.house_id AND l.house_type = h.house_type
 WHERE l.house_type = 2 AND l.status = 1
   AND l.manufacturer_code = 'hui_ju'
   AND l.after_sale_manufacturer_code = 'hui_ju'
 LIMIT 5;
```

拿到后 `lock.resolve({houseId})` 确认，再检查 Apollo `repair.order.customer.service.city` 是否含该城市。
---

## seed 最小补齐

一般无需造数，用现有房源 + 门锁。

若要验证轮转，需预置 Redis 计数：

```js
// 把首号码计数推到限额
redis.set(`iot:sms:daily_count:repair_order_notify_customer_service:<客服手机号1>:${yyyyMMdd}`, '300')
```

---

## trigger 触发

```js
{
  mode: 'execute',
  action: 'http',
  detail: {
    method: 'POST',
    path: '/iot/repairOrders/add',
    headers: {
      'lianjia-ucid': '<ucid>',
      'name': '<操作人姓名>'
    },
    body: {
      contactName: '测试租客',
      faultType: '1',
      manufacturerCode: 'hui_ju',
      afterSaleManufacturerCode: 'hui_ju',
      deviceTypeCode: 1,
      deviceId: '<lockId>',
      orderType: 'common',
      phone: '<测试手机号>',
      content: 'AI验证-门锁无法上锁',
      planVisitStartTime: '2026-10-28 09:00:00',
      planVisitEndTime: '2026-10-28 12:00:00'
    }
  }
}
```

---

## assert 断言

### 正常发送

| 证据 | 内容 |
|---|---|
| 日志（必须） | `客服跟进短信发送成功, phone=<首号码>, 今日已发=<n>` |
| Redis | `iot:sms:daily_count:repair_order_notify_customer_service:<首号码>:<yyyyMMdd>` = `<n>` |
| Redis TTL | ≈ 90000 秒（25 小时） |

### 限额轮转

| 证据 | 内容 |
|---|---|
| 日志（必须） | `客服手机号当日短信已达限额 300, phone=<首号码>, 切换下一手机号` |
| 日志（必须） | `客服跟进短信发送成功, phone=<次号码>` |
| 负向断言 | 首号码无 `发送成功` |

### 发送失败轮转

| 证据 | 内容 |
|---|---|
| 日志（必须） | `客服手机号短信发送失败, phone=<首号码>, 自动轮转尝试下一手机号` |
| 日志（必须） | `客服跟进短信发送成功, phone=<次号码>` |

### Redis Fail-Open

| 证据 | 内容 |
|---|---|
| 日志 | `[CustomerServiceSms] Redis查询单日计数异常, Fail-Open放行尝试发送` |
| 日志（必须） | 短信仍然 `发送成功` |

### 非自研跳过

| 证据 | 内容 |
|---|---|
| 日志（必须） | `非自研门锁维修单无需客服跟进短信` |
| 负向断言 | 无 `客服跟进短信发送成功` |

---

## cleanup 清理

1. 删除 `repair_order` 中本次创建的记录
2. 重置 Redis 计数 key（`del`），否则第二次跑会直接轮转

```js
redis.del(`iot:sms:daily_count:repair_order_notify_customer_service:${phone}:${yyyyMMdd}`)
```

---

## 常见问题

| 现象 | 根因 | 处理 |
|---|---|---|
| 没有客服短信 | 非 hui_ju 厂商 | 换 hui_ju 门锁 |
| 没有客服短信 | 城市未开城 | 查 `repair.order.customer.service.city` |
| 第二次跑直接轮转 | Redis 计数未重置 | cleanup 里 `del` 计数 key |
| 报「获取维修商品编码失败」 | Apollo `iotCommunityLockOrderMap` 的 `FIX` 无该城市 | 查 Apollo |
