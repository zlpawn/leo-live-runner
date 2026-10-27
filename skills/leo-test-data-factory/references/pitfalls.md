# 坑清单（实战验证）

> 全部来自 2026-10-26/27 智能门锁短信降本改造的真实环境验证。
> 按「现象 → 根因 → 解法」组织，每条可直接执行。

---

## A. 房源与门锁

### A1 报「未找到有效房源地址」

- **现象**：`createAutoInstallOrder` 抛 `RegularServiceException: 未找到有效房源地址`
- **根因**：`iot_plat.house_info` 没有该 `house_id` 的记录
- **解法**：`house.ensure({houseId, cityCode})`
- **必填字段**：`house_id, house_type, city_code, city_name, house_address, source_code='light', source_type=3`

### A2 报「房源已安装门锁，请检查房源数据」

- **现象**：`createAutoInstallOrder` 抛异常
- **根因**：`iot_plat.house_lock` 已存在该房源的记录
- **解法**：`lock.ensureAbsent({houseId})`，或换一个未装锁的房源
- **注意**：造安装单场景必须无锁；造维修场景必须有锁

### A3 房源存在但查不到

- **现象**：`house_info` 有记录，但业务查不到
- **根因**：`house_type` 不匹配（轻托管整租是 `2`）
- **解法**：`house.resolve({houseId, houseType: 2})` 显式带 houseType

---

## B. 合同

### B1 报「未找到合同信息」

- **现象**：`contractService.getContractByContractCode` 返回 null
- **根因**：合同号不存在或写错
- **解法**：`contract.resolve({contractCode})` 先校验

### B2 合同ID 与合同号混用

- **现象**：查权益/任务表返回空
- **根因**：权益表用 `biz_code = contractId`（数字，如 `<contractId>`），业务消息用 `contractCode`（如 `<合同号>`）
- **解法**：`contract.resolveIdByCode` / `contract.resolveCodeById` 显式转换

### B3 收房合同 vs 出房合同搞混

- **现象**：`queryTaskDealUsers` 返回空数组
- **根因**：`manager_task.upstream_code` 需要**收房**合同号（`biz_type=1`），用了出房合同号（`biz_type=2`）
- **解法**：先用 `contract.resolve({houseId, bizType:1, status:2})` 找到收房合同，再查任务

---

## C. 权益（最高频）

### C1 家服报「无可用权益」，但权益实例明明存在 ⚠️ 最坑

- **现象**：`sun_core.template_instance` 里有 `lock_install` 记录，`status=2`，有效期正常，但家服 `maintain/create` 返回 `errno=10004 无可用权益`
- **根因**：`sun_core.beijia_goods_range` 白名单（`type=1`）的 `col_four` 不含目标货架码
- **解法**：`equity.resolve` 的第 3 步二次校验，返回 `goodsRangeOk=false` 和完整白名单
- **识别方法**：`equity.resolve` 会返回 `goodsRangeOk=false` 和完整白名单，对比目标货架码即可

```sql
-- 直接查白名单
SELECT col_four FROM beijia_goods_range WHERE template_id = 342 AND type = 1;
```

### C2 权益实例过期或状态不对

- **现象**：`template_instance` 有记录但查不到
- **根因**：`status != 2` 或 `effective_start_time > now` 或 `effective_end_time < now`
- **解法**：`equity.resolve` 校验 `status=2` 和有效期覆盖当天

### C3 报「没有查询到有效权益」（iot 侧）

- **现象**：`sunFacade.queryInstallTemplateInstId` 返回 null
- **根因**：① `package_instance` 缺失；② `jiafu.sun.code` 未配该城市的模板编码
- **解法**：先查 Apollo `jiafu.sun.code`，确认 `INS.{cityCode}` 有值；再查 `package_instance`

```json
// jiafu.sun.code 示例（测试环境）
{ "INS": { "310000": "lock_install", "320500": "lock_install", "110000": "121212" } }
```

---

## D. 商品

### D1 报「非智能设备相关商品无需处理」

- **现象**：日志 `checkWorkOrder` 返回 false，链路中断
- **根因**：商品编码不是门锁类（例如选到了灯具类商品）
- **解法**：`commodity.resolve` 按 `workOrderType` 过滤，并用 `commodity.resolveByShelfCode` 确认 `commodity_name` 含「门锁」

### D2 shelf_code 与 commodity_code 混用

- **现象**：配置对不上，或订单查不到商品
- **根因**：下单传 `shelf_code`（`SCM…`），Apollo `device.commodityOrderTypeConf` 配的是 `commodity_code`（`CM…`）
- **解法**：`commodity.resolve` 返回两者，按用途取

### D3 报「获取维修商品编码失败」

- **现象**：`getRepairCommodityCode` 返回 null
- **根因**：Apollo `iotCommunityLockOrderMap` 的 `FIX` 节点没有该城市
- **解法**：查 Apollo 确认 `FIX.commodityList[].cities[]` 含目标 cityCode

---

## E. 在途安装单

### E1 造了安装单但 `checkInstallOrder` 查不到 ⚠️

- **现象**：`install_order_detail` 插入了记录，但 `getValidInstallOrderDetailByHouseId` 返回空
- **根因**：查询条件是 `status = 4 AND order_status IN (1, 2, 3)`，实测只设了 `order_status=1` 漏了 `status=4`
- **解法**：`installOrder.ensure` 默认 `status=4, orderStatus=1`

```sql
-- 验证 SQL（与代码完全一致）
SELECT id FROM install_order_detail
WHERE house_id = ? AND order_status IN (1,2,3) AND status = 4;
```

---

## F. 家服订单

### F1 重放旧订单消息报 `code:1 获取订单详情异常`

- **现象**：Kafka 重放历史 eventType=5 消息，`OrderQueryFacade#getOrderDetail` 返回 `{"code":1,"msg":"获取订单详情异常"}`
- **根因**：家服对旧订单/已完结订单拒绝查询，或订单已流转
- **解法**：用 `order.ensure` 新建订单，或用最近创建且状态正常的订单

### F2 家服建单成功但 iot 侧报错

- **现象**：家服返回 `orderCode`，但 iot 日志报异常
- **根因**：iot 侧后续步骤（写安装单、发消息）失败
- **解法**：看 iot 日志定位；家服订单可用 `order.reverse` 取消

### F3 取消订单失败

- **现象**：`/api/manager/cloud/order/cancel` 返回错误
- **根因**：订单状态不可取消（已完工/已取消），或 `operatorType=AGENT` 时非本人订单
- **解法**：用 `operatorType` 对应云管家（`CLOUD_MANAGER`），或检查订单状态

---

## G. Kafka 与消费

### G1 消息发了但本地实例没消费

- **现象**：`kafka_send` 成功，本地日志无反应
- **根因**：① 消费组 offset 已过；② 分区不匹配；③ 消费组刚启动在追历史
- **解法**：查 `--lag-only` 确认 offset；等待消费（实测追历史可能需数分钟）

### G2 本地和测试环境都消费了

- **现象**：短信/Push 发了两遍
- **根因**：本地用新消费组，与测试环境部署实例是**两个独立消费组**，各自都收到
- **解法**：已确认测试环境可接受重复。若要精确单次，停掉测试环境消费组或用泳道隔离

### G3 低电量消息发了没反应

- **现象**：发了 metadata 消息，日志无 `lowBatteryIsRemind`
- **根因**：`house_type != 2`（非轻托管整租）、`to_landlord=1`（已移交）、或门锁不存在
- **解法**：`house.resolve` + `lock.resolve` 确认前置

---

## H. 开关与配置

### H1 改了 Apollo 影响所有人

- **现象**：验证开关逻辑时改了测试环境 Apollo，影响其他测试
- **根因**：Apollo 是全局配置
- **解法**：用 `-Dkey=value` 覆盖本地进程启动参数，不改 Apollo

```bash
-Dinstall.order.notice.manager.link.push.enable=true
-Dorder.dispatch.servicer.app.push.enable=true
-Dzuwu.auto.order.dispatch.link.push.enable=true
```

### H2 客服跟进短信走不到

- **现象**：维修单创建了，但没有客服短信
- **根因**：① 非 `hui_ju` 厂商；② 城市未在 `repair.order.customer.service.city` 开城；③ `orderType` 不在配置的 `orderType` 列表
- **解法**：查 Apollo 配置，确认 `{manufacturer}.{cityCode}.orderType` 含本次的 orderType

### H3 低电量管家短信全被拦

- **现象**：所有城市都不发管家短信
- **根因**：`lowBatteryZuwuManagerCityList` 默认为空数组 `[]`，**设计上拦截所有城市**
- **解法**：这是预期行为。要放开需在 Apollo 配置目标城市

---

## I. 数据清理

### I1 第二次跑结论错误

- **现象**：同一个场景跑两遍，第二遍断言不通过
- **根因**：① 残留门锁 → 报「房源已安装门锁」；② 残留安装单 → 读到旧单；③ Redis 日计数被推到 300 → 直接轮转
- **解法**：`cleanup` 按账本逆序清理；Redis 计数单独重置

```js
// 重置客服短信计数
redis.del(`iot:sms:daily_count:repair_order_notify_customer_service:${phone}:${yyyyMMdd}`)
```

### I2 复用了别人的数据却删了

- **现象**：清理时误删了非本次创建的数据
- **根因**：没区分 `source`
- **解法**：只清 `source === 'created'` 的；`reused` 的绝不能删

---

## J. 易被误判为 bug 的设计行为

### J1 自研 hui_ju 维修单没走 Push

- **现象**：Push 开关已开，但 hui_ju 维修单仍走短信
- **根因**：**这是设计**。`WorkOrderTypeEnum.REPAIR && hui_ju` 强制走短信
- **解法**：不是 bug，断言时按短信校验

### J2 非自研维修单不发客服短信

- **现象**：维修单创建了，没有客服跟进短信
- **根因**：**这是设计**。只有 `hui_ju` 自研门锁发客服短信
- **解法**：日志会打 `非自研门锁维修单无需客服跟进短信`

### J3 低电量管家短信被拦

- **现象**：低电量消息处理了，但没发管家短信
- **根因**：**这是设计**。白名单为空时拦截所有城市
- **解法**：日志 `[ZuwuLowBattery] lowBatteryZuwuManagerCityList 配置为空, 静默拦截`
