# leo-test-data-seeder

测试环境数据构造与业务流程编排 skill。面向研发自测与 QA 测试。

## 快速开始

### 1. 安装依赖

```bash
cd skills/leo-test-data-seeder
npm install
```

### 2. 直接运行（零配置）

连接信息和测试库密码都已内置在 `resources/systems.json`，克隆后即可使用：

```bash
node scripts/verify.js
```

**如需切换到其他环境**，用环境变量覆盖即可（优先级最高，不改仓库文件）：

```bash
export SEEDER_IOT_PLATFORM_PASSWORD='...'
export SEEDER_TRUSTEESHIP_CONTRACT_PASSWORD='...'
export SEEDER_SUN_CORE_PASSWORD='...'
export SEEDER_BEIJIA_COMMODITY_PASSWORD='...'
export SEEDER_MANAGER_WORKBENCH_PASSWORD='...'
```

> **说明**：内置的是**内网测试环境**的连接信息与密码。这些主机（`*.mars.test.*.ljnode.com`）只在公司内网可达，公网无法直连，因此可以随 skill 分发，实现开箱即用。生产环境凭据绝不内置。

### 3. 只读体检

```bash
# 能力层体检（连接 + 数据解析）
node scripts/verify.js

# 场景层体检（前置条件是否齐备）
node scripts/run.js --list
node scripts/run.js sms-task1-auto-install
```

两者都只读，不写任何数据。

## 目录结构

```
.
├── SKILL.md                  # Skill 主文档（能力索引 + 场景清单）
├── references/
│   ├── capabilities.md       # 原子能力接口契约
│   ├── pitfalls.md           # 坑清单（现象 → 根因 → 解法）
│   ├── data-model.md         # 各系统库表结构
│   └── scenarios/            # 业务流程场景（每个场景一个独立文档）
│       ├── README.md
│       ├── task1-auto-install.md
│       ├── task2-sign-install.md
│       ├── task3-dispatch.md
│       ├── task4-customer-service.md
│       └── task5-low-battery.md
├── resources/
│   └── systems.json          # 内置连接配置（不含密码）
├── scripts/
│   ├── common/
│   │   ├── systems.js        # 连接注册表（MySQL/HTTP/Kafka）
│   │   ├── credentials.js    # 凭据管理
│   │   └── ledger.js         # 造数账本（反向清理）
│   ├── capabilities/         # 原子能力
│   │   ├── house.js
│   │   ├── lock.js
│   │   ├── contract.js
│   │   ├── equity.js
│   │   ├── commodity.js
│   │   ├── installOrder.js
│   │   ├── managerTask.js
│   │   └── order.js
│   ├── scenarios/            # 业务流程（5 个可执行场景）
│   │   ├── runner.js         # 五段编排器
│   │   ├── index.js          # 场景注册表
│   │   └── task*.js          # 各场景实现
│   ├── run.js                # 场景运行入口
│   └── verify.js             # 能力只读体检
└── package.json
```

## 核心概念

**原子能力**：造/查某一类数据，实现方式（改表 or 调接口）对上层透明。

| 能力 | 类型 |
|---|---|
| house / lock / installOrder / managerTask / order | ✅ 可造 |
| contract / equity / commodity | ⚠️ 仅查（从零造易产生脏数据） |

**统一签名**：`resolve(cond)` / `ensure(spec)` / `reverse(handle)`

**统一返回**：`{ ok, handle, source, cleanup, reason, message, missing, candidates }`

**两种模式**：`readonly`（默认，只查）/ `execute`（可写可触发）

## 关键设计

1. **`source` 字段区分 reused / created**：只有 created 的进清理账本，复用的别人的数据不能删。
2. **权益白名单二次校验**：`equity.resolve` 会额外查 `beijia_goods_range`，这是「权益存在但家服报无可用权益」的根因。
3. **按白名单选商品**：`commodity.resolveWithWhitelist` 确保选出的商品能通过权益校验。顺序必须是先权益后商品。
4. **记账式清理**：每条 created 记录反向 SQL/API，cleanup 按依赖逆序执行。

## 已知限制

- 场景层（`scripts/scenarios/`）尚未实现，目前只有原子能力和文档。
- 合同/权益/商品仅支持查询，不支持从零构造。
- 测试环境数据会变化，文档中的「已知可用组合」可能失效，以 `precheck` 实际结果为准。
