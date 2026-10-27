# Task 5 · 门锁低电量 → 管家短信（城市白名单）

> 场景 ID：`sms-task5-low-battery`
> 对应需求：智能门锁短信降本改造 Task 5

## 验证目标

`LockLogicImpl.isZuwuManagerLowBatteryCityOpen` 的白名单过滤：

| 条件 | 预期行为 |
|---|---|
| 城市在白名单 | 正常给管家发短信 |
| 城市不在白名单 | 静默拦截，不发短信 |
| 白名单为空 `[]` | 拦截所有城市 |

**配置**：`lowBatteryZuwuManagerCityList`（`@ApolloJsonValue`，默认 `[]`）

**入口**：Kafka `beijia-iot-metadata-change`

```json
{
  "data": { "battery": 5 },
  "deviceId": "<lockId>",
  "deviceType": 1,
  "directConnection": false,
  "manufacturerCode": "hui_ju",
  "source": 3,
  "updateTime": "2026-10-27T10:00:00"
}
```

---

## precheck 前置检查

| 检查项 | 能力调用 | 说明 |
|---|---|---|
| 房源 house_type=2 | `house.resolve({houseId, houseType:2})` | 仅轻托管整租走该逻辑 |
| 门锁存在且未移交 | `lock.resolve()` → `meta.toLandlord=0` | 已移交不提醒 |
| 无租客授权 | 查 `lock_auth_info` 无 `target_type=1` | 有租客走租客分支 |
| Apollo 白名单 | `lowBatteryZuwuManagerCityList` | **默认空 → 拦截全部** |

**无需手动指定 ID**——按条件查现成的轻托管门锁房源：

```sql
SELECT l.lock_id, l.house_id, l.manufacturer_code, h.city_code
  FROM house_lock l
  JOIN house_info h ON l.house_id = h.house_id AND l.house_type = h.house_type
 WHERE l.house_type = 2 AND l.status = 1 AND l.to_landlord = 0
   AND l.manufacturer_code = 'hui_ju'
 LIMIT 5;
```

再确认该房源无租客授权（`lock_auth_info` 无 `target_type=1`），否则会走租客分支。
---

## seed 最小补齐

一般无需造数。

---

## trigger 触发

```js
{
  mode: 'execute',
  action: 'kafka',
  detail: {
    topic: 'beijia-iot-metadata-change',
    payload: {
      data: { battery: 5 },
      deviceId: '<lockId>',
      deviceType: 1,
      directConnection: false,
      manufacturerCode: 'hui_ju',
      source: 3,
      updateTime: new Date().toISOString()
    }
  }
}
```

---

## assert 断言

### 城市未开城（默认状态）

| 证据 | 内容 |
|---|---|
| 日志（必须） | `[ZuwuLowBattery] lowBatteryZuwuManagerCityList 配置为空, 静默拦截所有管家低电短信` |
| 负向断言 | 无 `低电量给资管发送短信` |
| 数据 | `inform_record` 无新增记录 |

### 城市已开城

| 证据 | 内容 |
|---|---|
| 日志（必须） | `低电量给资管发送短信，phone：` |
| 数据 | `inform_record` 有新增记录（`device_id` = lockId） |

### 城市不在白名单（白名单非空但不含该城市）

| 证据 | 内容 |
|---|---|
| 日志（必须） | `[ZuwuLowBattery] 当前房源城市未命中管家低电量开城白名单` |
| 负向断言 | 无 `低电量给资管发送短信` |

---

## cleanup 清理

删除 `inform_record` 中本次新增的记录（按 `device_id` + `ctime` 定位）。

---

## 常见问题

| 现象 | 根因 | 处理 |
|---|---|---|
| 所有城市都不发 | 白名单默认空 | **设计如此**，需在 Apollo 配置目标城市 |
| 消息处理了但没反应 | `house_type != 2` | 换轻托管整租房源 |
| 消息处理了但没反应 | `to_landlord = 1`（已移交） | 换未移交房源 |
| 走的是租客分支 | 房源有租客授权 | 换无租客授权的房源 |
| 本地和测试环境都发了 | 两个消费组各自消费 | 测试环境可接受重复 |

---

## 本地验证开关的技巧

验证「白名单非空」场景时，**不要改测试环境 Apollo**，用命令行覆盖本地进程：

```bash
java -jar app.jar \
  -DlowBatteryZuwuManagerCityList='["310000"]'
```

这样只影响本地实例，不污染共享配置。
