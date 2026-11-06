# leo-config-router

企业级全量配置、业务白名单与权限编排路由中枢（声明式场景驱动 + 3-Way 差异核算 + 安全降权审计 + 状态机防漏 Checklist + 线上闭环核验）。

## 🌟 核心特性

- **声明式场景驱动 (Scenario-Driven)**：通用底层引擎与具体业务规则解耦，扩展新场景只需添加一个 YAML 声明文件，核心代码 0 侵入。
- **全量 3-Way Diff 算法**：智能识别保持不变 (Retained)、纯增量 (Added)、高危降权 (Degraded) 与幽灵配置 (Ghost/Removed)。
- **严密安全防线**：实时比对线上配置中心（如 Apollo）与输入全量名单，精准拦截转岗/离职人员权限残留风险。
- **状态机防漏清单 (Checklist)**：CLI 运行时严格输出 `[✓]` / `[!]` 步骤状态，避免任何工序遗漏。
- **权限安全红线**：严禁自动化增删 RBAC（如 Luke）生产角色，采用名单导出 + 线上只读核验闭环。

## 📁 目录结构

```
leo-config-router/
├── SKILL.md                 # Antigravity/Agent 调度 SOP 契约
├── core/                    # 通用底层核心引擎
│   ├── excel_loader.py      # 自适应 Sheet 探测与 Excel 解析加载器
│   ├── diff_engine.py       # 通用 3-Way Diff 与安全降权审计引擎
│   └── pipeline.py          # 流水线编排器与状态机清单 (Checklist)
├── scenarios/               # 声明式业务场景配置目录
│   └── sm_lock.yaml         # 门锁权限月度配置场景声明
├── scripts/                 # CLI 统一执行入口
│   └── config_router.py     # 统一 CLI 工具
└── references/              # 相关参考与文档沉淀
```

## 🚀 快速上手

运行需要 Python 3.10+，推荐使用 [uv](https://docs.astral.sh/uv/) 执行（零环境污染，免手动装包）：

```bash
# 查看所有已注册的场景
uv run --with pyyaml --with python-calamine python scripts/config_router.py --list-scenarios

# 运行指定场景分析 (默认 Dry-Run，输出状态机清单与文件)
uv run --with pyyaml --with python-calamine python scripts/config_router.py \
  --scenario sm_lock \
  --file /path/to/需求收集表.xlsx

# 连带触发后端后门批量接口刷新
uv run --with pyyaml --with python-calamine python scripts/config_router.py \
  --scenario sm_lock \
  --file /path/to/需求收集表.xlsx \
  --execute-backdoor
```

## 🧩 如何扩展新场景

在 `scenarios/` 目录下新增一个 YAML 声明文件（例如 `scenarios/water_meter.yaml`），详见 [SKILL.md](SKILL.md)。
