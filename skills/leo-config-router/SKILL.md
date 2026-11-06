---
name: leo-config-router
description: 企业级全量配置、业务白名单与权限编排路由中枢（声明式场景驱动 + 3-Way 差异核算 + 安全降权审计 + 状态机防漏 Checklist + 线上闭环核验）。适用于门锁权限、各类硬件维保权限、业务灰度免审批白名单、多系统权限对账与批量配置运维场景。
---

# leo-config-router：企业级配置与权限编排路由中枢

`leo-config-router` 是面向企业级复杂配置运维的通用中枢。它将业务中常见的**“全量表格提单 ➔ 差异核算与安全审计 ➔ 多端协同下发 ➔ 线上生产核验”**抽象为**声明式场景驱动（Scenario-Driven）**的标准化流水线。

无论具体是**门锁权限**、**水电表网关维保权限**、**业务灰度免审批白名单**还是**离职调岗安全对账**，均通过统一内核驱动，实现**0 环节遗漏、0 越权隐患、全流程闭环**。

---

## 🏗️ 核心架构

```
┌────────────────────────────────────────────────────────┐
│ 1. Input Adapters (数据输入源)                          │
│    • Excel / CSV / 飞书多维表格 (Bitable)                │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Core 3-Way Diff Engine (差异核算与安全引擎)           │
│    • 增量计算 (Added)    • 保持不变 (Retained)          │
│    • 降权审计 (Degraded) • 幽灵配置排查 (Ghost/Removed)  │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Scenario Profiles (场景声明目录: scenarios/*.yaml)   │
│    • 字段映射规则 (Field Mapping)                       │
│    • 人员/数据标准化管道 (Sanitizer: 工号->UCID等)      │
│    • 编排流水线步骤 (Pipeline Steps: 后门/配置/角色)     │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ 4. Multi-Target Drivers (多端协同与核验)                │
│    • Apollo 配置中心 (全量清洗版 / 增量版)              │
│    • 后端批量后门接口 (HTTP POST 批量开通全国数据权限)   │
│    • Luke 权限中心 (只读核验与工号导出，委托 live-inspector)
└────────────────────────────────────────────────────────┘
```

---

## 🚦 AI 执行刚性铁律（绝对防漏状态机契约）

AI Agent 在响应用户任何配置或权限诉求时，**必须严格按照以下四阶段推进，严禁跳步，严禁漏环节**：

### 阶段一：场景识别与路由 (Scenario Routing)
- 分析用户诉求，自动匹配 `scenarios/` 目录下的注册场景（如输入涉及“门锁”，自动路由至 `sm_lock`）。
- 绝不在代码库中盲目探查 Excel，**必须由用户明确提供或确认文件路径**。

### 阶段二：数据解析与 3-Way Diff 审计 (Analysis & Audit)
- 运行通用引擎执行自适应 Sheet 识别、表头识别与 UCID 标准化。
- 执行 3-Way Diff，重点核查**“降权越权风险人员”**（如曾拥有免审批权限，现转为普通一线）。
- **必须优先向用户展示 Diff 审计概览与生成的 Checklist**。

### 阶段三：分步流水线推进 (Step-by-Step Dispatch)
严格遵循风险分级原则推进：
1. **Tier 1 (低风险 - 接口刷新)**：执行后端后门接口批量刷新（如开通全国数据权限），记录调用结果。
2. **Tier 2 (中风险 - 配置中心)**：生成 Apollo 全量清洗版 JSON 文件，提示用户确认并下发。
3. **Tier 3 (高风险 - 权限中心)**：**【绝对红线】严禁调用任何接口自动化增删 Luke 角色**！仅导出标准化系统工号文本，供业务人员在 Luke 控制台人工批量导入。

### 阶段四：线上生产环境双向闭环核验 (Post-flight Verification)
- 必须通过 `leo-live-inspector` 直连线上生产环境（Apollo HTTP / Luke GraphQL）：
  - 核查 Apollo 生产配置项人数是否与推荐清洗名单 100% 一致（0 遗漏、0 多余）。
  - 核查 Luke 生产环境对应角色下新增成员是否全部绑定生效。
- 出具最终核验对比报告，只有全部通过后方可宣布 SOP 完成。

---

## 🛠️ CLI 命令速查

CLI 脚本位于：`/Users/pa/project/LEO/leo-live-runner/skills/leo-config-router/scripts/config_router.py`

```bash
# 1. 查看系统中已注册的所有场景
/Users/pa/.local/bin/uv run --with pyyaml --with python-calamine python /Users/pa/project/LEO/leo-live-runner/skills/leo-config-router/scripts/config_router.py --list-scenarios

# 2. 执行门锁权限场景分析 (默认 Dry-Run，输出状态机清单与文件)
/Users/pa/.local/bin/uv run --with pyyaml --with python-calamine python /Users/pa/project/LEO/leo-live-runner/skills/leo-config-router/scripts/config_router.py \
  --scenario sm_lock \
  --file /Users/pa/Downloads/门锁权限需求收集.xlsx

# 3. 连带执行后端后门接口 (刷全国数据权限)
/Users/pa/.local/bin/uv run --with pyyaml --with python-calamine python /Users/pa/project/LEO/leo-live-runner/skills/leo-config-router/scripts/config_router.py \
  --scenario sm_lock \
  --file /Users/pa/Downloads/门锁权限需求收集.xlsx \
  --execute-backdoor
```

---

## 💡 如何在 5 分钟内扩展一个全新业务场景？

扩展新场景**完全不需要修改核心代码**，只需在 `/Users/pa/project/LEO/leo-live-runner/skills/leo-config-router/scenarios/` 下新建一个 YAML 声明文件即可！

### 新场景声明模板：`scenarios/example_scene.yaml`

```yaml
id: "water_meter_perm"                       # 场景唯一标识
name: "智能水表维保人员白名单配置"              # 场景中文名
description: "处理全国智能水表维保人员白名单与区域权限刷新"

# 1. 触发关键词 (供 AI 意图路由)
triggers:
  - "水表权限"
  - "水表白名单"
  - "water_meter"

# 2. 输入规则
input:
  format: "excel"
  sheet_detection: "active_or_visible"
  sanitizer: "beike_ucid_converter"          # 可选: none / beike_ucid_converter
  fields:
    key_col: ["员工系统号", "工号", "ucid"]
    name_col: ["姓名", "员工姓名"]
    role_col: ["权限类别", "岗位"]
    group_col: ["城市", "服务网格"]

# 3. 业务角色划分策略
grouping:
  whitelist_candidates:                      # 需进入白名单的角色
    match_roles: ["维保主管", "驻场工程师"]
  degraded_roles:                            # 降权需剔除的角色
    match_roles: ["普通施工人员", "已停职"]

# 4. 编排流水线步骤 (有序执行)
pipeline:
  # 步骤 1: 批量接口刷新
  - step_id: 1
    name: "区域权限缓存刷新"
    type: "http_batch_api"
    risk_level: "low"
    endpoint: "http://iot.beijia.ke.com/backdoor/water/refreshScope"
    method: "POST"
    payload_template:
      ucids: "${target_data}"

  # 步骤 2: 配置中心白名单
  - step_id: 2
    name: "Apollo 维保白名单"
    type: "apollo_config"
    risk_level: "medium"
    app_id: "zulin-iot-platform"
    key: "water.meter.maintainer.whitelist"
    query_url: "http://prod.config.apollo.ke.com/configfiles/json/zulin-iot-platform/default/application"
    format: "json_array"
    diff_strategy: "full_clean_recommended"

  # 步骤 3: 权限中心工号导出 (供人工录入)
  - step_id: 3
    name: "Luke 角色工号导出"
    type: "luke_export"
    risk_level: "high"
    roles:
      - role_id: "water:meter:engineer"
        role_name: "水表维保工程师"
        target_data: "new_whitelist_eids"
```

只要保存该文件，`leo-config-router` 就会立即支持该场景，具备全自动 3-Way Diff、安全预警与状态机清单能力！
