# 数据模型参考

> 各系统库表结构与关键字段。连接配置见 [resources/systems.json](../resources/systems.json)。

---

## 系统总览

| 逻辑系统 | 库名 | 主机 | 用途 |
|---|---|---|---|
| `iot-platform` | `iot_plat` | m10155:10155 | 房源/门锁/安装单/维修单/通知记录 |
| `manager-workbench` | `manager_workbench` | m11848:11848 | 任务处理人 |
| `trusteeship-contract` | `trusteeship_contract` | m10038:10038 | 合同 |
| `sun-core` | `sun_core` | m10038:10038 | 权益包/模板/适用范围 |
| `beijia-commodity` | `beijia_commodity` | m10038:10038 | 商品/货架/服务项/价格 |

---

## iot_plat（IOT 平台）

### house_info 房源

| 字段 | 类型 | 说明 |
|---|---|---|
| `house_id` | varchar | 房源ID（唯一键之一） |
| `house_type` | tinyint | 0集中式 1分散式 **2轻托管整租** |
| `city_code` | int | 城市编码 |
| `city_name` | varchar | 城市名 |
| `house_address` | varchar | 房源地址 |
| `source_code` | varchar | 商家code，轻托管固定 `light` |
| `source_type` | tinyint | 1saas 2open **3轻托管** |
| `whole_house_code` | varchar | 整房编码，通常等于 house_id |
| `resblock` | varchar | 小区名 |
| `room_name` | varchar | 房间号 |

### house_lock 门锁

| 字段 | 类型 | 说明 |
|---|---|---|
| `lock_id` | varchar | 门锁ID |
| `house_id` | varchar | 房源ID |
| `house_type` | tinyint | 房源类型 |
| `manufacturer_code` | varchar | 厂商编码，自研为 `hui_ju` |
| `after_sale_manufacturer_code` | varchar | 售后厂商 |
| `prod_type` | varchar | 产品型号，如 `HJ02` |
| `status` | tinyint | 1有效 |
| `battery` | int | 电量 |
| `to_landlord` | tinyint | 是否已移交业主，0否 |
| `biz_category` | tinyint | 业务分类 |

### install_order_detail 安装单

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | bigint | 主键 |
| `house_id` | varchar | 房源ID |
| `house_type` | tinyint | 房源类型 |
| `city_code` | int | 城市 |
| `address` | varchar | 地址 |
| `manufacturer_code` | varchar | 厂商 |
| `third_order_code` | varchar | 家服工单号 |
| `status` | tinyint | **4 = 有效**（查询必需） |
| `order_status` | tinyint | **1待派单 2已派单 3已联系**（查询取 1/2/3） |
| `order_time` | datetime | 下单时间 |
| `op_person_ucid` | bigint | 操作人 |

**查询条件（与代码一致）**：
```sql
WHERE house_id = ? AND order_status IN (1,2,3) AND status = 4
```

### repair_order 维修单

| 字段 | 说明 |
|---|---|
| `order_id` | 工单号 |
| `house_id` / `house_type` | 房源 |
| `manufacturer_code` | 厂商 |
| `after_sale_manufacturer_code` | 售后厂商（`hui_ju` 才发客服短信） |
| `order_type` | `common`/`urgent`/`night` |
| `status` | 工单状态 |

### inform_record 通知记录

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `manufacturer_code` | 厂商 |
| `device_id` | 设备ID（门锁用 lock_id） |
| `device_type_code` | 设备类型 |
| `phone` | 接收手机号 |
| `inform_user_type` | 接收人类型 |
| `inform_type` | 通知类型 |
| `inform_msg_template` | 短信模板名 |
| `threshold` | 触发电量阈值 |

### lock_auth_info 门锁授权

| 字段 | 说明 |
|---|---|
| `house_id` / `house_type` | 房源 |
| `target_type` | **1签约人（租客）** 3管家 4业主 |
| `target_phone` | 授权手机号 |

---

## manager_workbench（租务管家工作台）

### manager_task 管家任务

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `task_id` | 任务ID（`task_relation` 关联键） |
| `contract_code` | 合同号 |
| `contract_type` | 1托管收房 2托管出房 |
| `biz_type` | **1签约** 2解约 |
| `task_type` | 1物业交割 3检修 **4门锁** 5入住指南 7面对面交房 |
| `upstream_code` | **上游合同号**（查询键，用收房合同号） |
| `house_code` | 房源ID |
| `city_code` | 城市 |
| `status` | 任务状态 |

**查询条件**：
```sql
SELECT * FROM manager_task
WHERE upstream_code = ? AND task_type = 4 AND biz_type = 1;
```

### task_relation 任务处理人

| 字段 | 说明 |
|---|---|
| `task_id` | 关联 manager_task.task_id |
| `deal_user_id` | 处理人 UCID |
| `deal_user_name` | 处理人姓名 |
| `role` | `zuwuManager` 租务管家 / `ziguanManager` 资管经理 |
| `is_delete` | **0 = 有效** |

---

## trusteeship_contract（租务合同）

### contract 合同

| 字段 | 说明 |
|---|---|
| `id` | **合同ID**（权益/任务表用） |
| `contract_code` | **合同号**（业务消息用） |
| `house_code` | 房源ID |
| `city_code` | 城市 |
| `biz_type` | **1收房 2出房** |
| `sub_biz_type` | **1标准合同** |
| `status` | 1草稿 2已签约 3履约中 6已到期 |
| `parent_id` | 父合同ID |
| `real_signed_time` | 实际签约时间 |
| `product_type` | 产品类型 |

---

## sun_core（权益中心）

### package 权益包

| 字段 | 说明 |
|---|---|
| `id` | 权益包ID |
| `city_code` | 城市 |
| `code` | 包编码，如 `trusteeship_in_right_320500` |
| `attribute_biz_type` | `trusteeship_in_right` 收房 / `trusteeship_out_right` 出房 |
| `status` | 2有效 |

### package_instance 权益包实例

| 字段 | 说明 |
|---|---|
| `id` | 实例ID |
| `city_code` | 城市 |
| `biz_code` | **合同ID**（不是合同号） |
| `package_id` | 关联 package.id |
| `status` | 1有效 |

### template 权益模板

| 字段 | 说明 |
|---|---|
| `id` | 模板ID |
| `code` | 模板编码，如 `lock_install` |
| `name` | 模板名 |
| `use_range_type` | **3 = 贝家商品中心**（按 tag/白名单匹配） |
| `content` | JSON，含 tag，如 `{"tag":["sxz_smart_lock"]}` |
| `status` | 1有效 |

**常用模板**：

| id | code | 名称 |
|---|---|---|
| 341 | `trusteeship_lock_fix` | 智能门锁维修 |
| 342 | `lock_install` | 智能门锁-安装工单 |
| 343 | `lock_replace` | 智能门锁-迁移工单 |
| 446 | `instant_rent_iot` | 即刻租权益门锁 |

### template_instance 权益模板实例

| 字段 | 说明 |
|---|---|
| `id` | **实例ID**（下单传 `templateInstId`） |
| `package_id` | 关联 package.id |
| `template_id` | 关联 template.id |
| `biz_code` | 合同ID |
| `stock` / `remain_amount` | 库存/剩余（测试环境常为 -999 表示无限） |
| `status` | **2 = 有效** |
| `effective_start_time` / `effective_end_time` | 有效期 |

### beijia_goods_range 商品适用范围（**最关键的坑**）

| 字段 | 说明 |
|---|---|
| `template_id` | 关联 template.id |
| `type` | **1 = 白名单**，2 = 黑名单 |
| `col_one` ~ `col_three` | 一/二/三级品类，`all` 表示不限 |
| `col_four` | **货架码 shelf_code**（SCM…） |
| `col_five` | 服务项编码，`all` 表示不限 |
| `extend` | 扩展说明 |

**判定逻辑**：白名单无匹配记录 → `isHit=false` → 无减免 → 家服报「无可用权益」。

```sql
-- 查某模板的白名单
SELECT col_four FROM beijia_goods_range WHERE template_id = 342 AND type = 1;
```

**常见缺口**：某城市有权益实例，但该城市的安装货架码不在白名单里。用 `discover.findContractWithUsableEquity` 自动跳过这类组合。

---

## beijia_commodity（商品中心）

### commodity_shelf_info 商品货架

| 字段 | 说明 |
|---|---|
| `shelf_code` | **货架码 SCM…**（下单传这个） |
| `commodity_code` | **商品编码 CM…**（配置用这个） |
| `commodity_name` | 商品名 |
| `city_code` / `city_name` | 城市 |
| `level1_code` | 一级品类（`10003` = 维修） |
| `selling_price` | 售价 |
| `shelf_status` | 1上架 |
| `del_status` | **1 = 未删除** |

### commodity_info 商品主数据

| 字段 | 说明 |
|---|---|
| `id` | 商品ID（对应 `beijia_goods_range.goods_id`） |
| `commodity_code` | CM… |
| `commodity_name` | 商品名 |
| `level1_code` / `level2_code` / `level3_code` | 品类路径 |

### commodity_shelf_service_item 货架服务项

| 字段 | 说明 |
|---|---|
| `shelf_code` | 货架码 |
| `item_shelf_code` | 服务项货架码 SSI… |
| `item_selling_price` | 服务项售价 |

### service_item_shelf_info 服务项详情

| 字段 | 说明 |
|---|---|
| `shelf_code` | SSI… |
| `item_code` | 服务项编码 SI… |
| `item_name` | 服务项名 |
| `amount` | 金额 |
| `market_price` | 市场价 |

### service_item_shelf_price_info 价格规则

| 字段 | 说明 |
|---|---|
| `shelf_code` | SSI… |
| `price_type` | **1 = 售价**，2 = 原价 |
| `rule_type` | 1 = 固定价（FIXED） |
| `price_rule` | **价格字符串**，如 `"12"` = 12元 |
| `shelf_time` | 生效时间（取最接近查询时间的版本） |

---

## 商品查询方式

**不要硬编码货架码**——用 `commodity.resolve` 按城市 + 工单类型查询：

```js
const cmd = await capabilities.commodity.resolve({
  cityCode: '<cityCode>', workOrderType: 'INS'
}, ctx);
```

判断某商品是否门锁类：查 `commodity_shelf_info` 的 `commodity_name` 是否含「门锁」，
或看 `commodity_code` 对应的 `commodity_info.commodity_name`。


---

## Redis 关键 Key

| Key 格式 | 用途 |
|---|---|
| `iot:sms:daily_count:{template}:{phone}:{yyyyMMdd}` | 短信单日计数（客服跟进限额 300） |
| `{msgConstant}{phone}{内容后10位}` | 分钟级重复发送拦截（90 秒） |

---

## 关键 Apollo 配置

| Key | 用途 |
|---|---|
| `jiafu.sun.code` | 工单类型 + 城市 → 权益模板编码（`INS.310000 = lock_install`） |
| `iotCommunityLockOrderMap` | 工单类型 → 商品编码 + 各城市货架码 |
| `device.commodityOrderTypeConf` | 商品编码 → 工单类型/设备类型 |
| `repair.order.customer.service.city` | 客服跟进开城（厂商 + 城市 + orderType） |
| `lowBatteryZuwuManagerCityList` | 管家低电量开城城市（**默认空 = 全拦**） |
| `order.dispatch.roleCodes` | 派单通知角色 |
| `cloudManagerFullyAutoOrderDto` | 全自动下单开城配置 |
