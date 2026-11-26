---
name: leo-hardware-runtime
description: Cross-platform (macOS and Windows) embedded hardware firmware runtime and cloud integration simulator powered by Renode CLI. Manages Renode CLI lifecycle (install, update, doctor), probes .hex/.bin/.elf firmware, emulates MCU peripherals and cellular/network modems with real TCP bridging, and coordinates with leo-live-inspector to verify or prepare test environment data and inspect backend logs. Use when running firmware locally, debugging device-to-cloud protocols, onboarding a new hardware model, or installing/managing Renode CLI.
---

# Leo Hardware Runtime (`leo-hardware-runtime`)

跨平台（**macOS & Windows**）嵌入式硬件仿真运行时与端云联调 Skill。用于在无真机开发板条件下，通过 **Renode CLI** 运行真实固件（`.hex` / `.bin` / `.elf`），桥接测试环境后端完成鉴权、指令下发与事件上报全链路联调。

> **核心工程约束**
> 1. **严禁连接线上环境（仅限本地 / 测试环境联调）**：绝不允许连接任何线上生产域名或生产 IP；`sim_launcher.py` 与模组桥接脚本在代码层强制拦截不带测试/本地标识的外部域名，仅允许 `--mock`、回环/内网地址或明确带测试标识的测试环境地址。
> 2. **零硬编码路径与环境**：所有脚本严禁写死个人目录、项目路径、测试账号或服务器密钥；固件路径、工作目录、后端项目路径、IMEI、密钥与服务端地址均通过 CLI 参数或运行时配置动态传入。
> 3. **双系统原生兼容**：Python 工具脚本使用标准库适配 macOS 与 Windows（POSIX 正斜杠路径转换、`LOCALAPPDATA`/`HOME` 自动适配）；Renode `PythonPeripheral` 严格遵循内置 IronPython 2.7 语法规范。
> 4. **协同 `leo-live-inspector`（不绑定 `leo-test-data-factory`）**：涉及查询或补齐测试库设备三元组、查看后端测试日志时，由 AI 在用户指定的**后端工程根目录**调用 `leo-live-inspector`（只调用测试环境脚本 `test_mysql_query.js` / `test_log_query.js`，写库前先展示 Diff 并经用户确认）。

---

## 🎯 能力矩阵与标准命令

所有脚本位于本 Skill 的 `scripts/` 目录下，执行前先定位本 Skill 目录 `<SKILL_DIR>`：

| 场景 | 执行脚本 | 说明 |
| :--- | :--- | :--- |
| **Renode 环境体检** | `python3 <SKILL_DIR>/scripts/renode_manager.py doctor` | 检测 macOS/Windows 本机 `renode` CLI、版本、Python 依赖与环境路径 |
| **安装 / 更新 Renode CLI** | `python3 <SKILL_DIR>/scripts/renode_manager.py install [--version latest] [--confirm]` | 首次先 Dry-run 展示版本与安装目录，确认后追加 `--confirm` 自动下载安装与建链 |
| **固件结构探针** | `python3 <SKILL_DIR>/scripts/firmware_probe.py <firmware_path>` | 自动提取向量表（VectorTable/SP/PC）、AT 指令、域名端口及 RTT/Key 字符串线索 |
| **产物目录与配置管理** | `python3 <SKILL_DIR>/scripts/workspace.py status \| set-output <dir> \| set ...` | 管理 `~/.shrimp/skills/leo-hardware-runtime/config.json`（三级解析：本次指定 ➔ 配置记忆 ➔ 默认 `~/.shrimp/skills/leo-hardware-runtime/output/`） |
| **参数化启动联调** | `python3 <SKILL_DIR>/scripts/sim_launcher.py --device <model> --firmware <path> --host <host> --port <port> --imei <imei> --tk-key <key>` | 根据型号 Profile 渲染 `.repl/.resc` 并运行仿真，产物落盘至配置的 `output_dir`，汇总 RTT 日志与 TCP 收发包 |

---

## 🔄 端云联调标准 5 步工作流（含记忆复用与缺项引导）

1. **环境检查（`renode_manager.py doctor`）**：
   - 检查本机 `renode` CLI、`leo-live-inspector` 与 `config.json`；若缺失 Renode CLI，先展示下载方案并在用户确认后执行 `install --confirm`。
2. **Pre-flight 体检与参数回显（`sim_launcher.py --device <model> --preflight`）**：
   - **参数三级复用与持久化**：所有用户补齐过的参数（`output_dir`、`backend_dir`、`default_test_host` 及分型号 `devices.<model>.{imei, tk_key, test_host, test_port, last_firmware}`）自动保存于本机 **`~/.shrimp/skills/leo-hardware-runtime/config.json`**。
   - **每次联调前强制展示当前参数单**：即使全部参数已在 `config.json` 中就绪，也必须先把解析出的配置表（含来源 `cli` / `config_device` / `missing`）展示给用户确认，方便随时修改（如换 IMEI、换测试地址）。
   - **缺项引导规范**：
     - 缺 `test_host`：默认使用测试环境域名（`default_test_host` 默认 `test.huiju.iot.cloud.ke.com`，`default_test_port` 全局默认 `8010`）；若被清空则从固件推导 `test.<domain>` 建议或切 `--mock`。
     - 缺 `imei` / `tk_key`：询问用户直接提供，或询问是否授权在 `backend_dir` 下通过 `leo-live-inspector` 从测试库查询/经确认后补齐（详见 [inspector-integration.md](references/inspector-integration.md)）。
     - 未知 `device` 型号：列出已有支持型号，引导先跑 `firmware_probe.py` 分析新固件。
3. **固件探查（`firmware_probe.py`）**：
   - 对已知型号（如 `hj07`），`sim_launcher.py` 会自动从固件向量表读取最新 `SP`/`PC`（或回退到型号默认值）。
   - 对全新型号，先运行探针定位向量表偏移、Modem AT 串口地址、定时器/RTT 与 Flash/SRAM 密钥槽位。
4. **启动仿真联调（`sim_launcher.py`）**：
   - 缺项未补齐前脚本会拒绝静默启动；全部就绪后自动把最新确认参数写回 `~/.shrimp/skills/leo-hardware-runtime/config.json`，并将产物输出到 `output_dir/<YYYY-MM-DD>/<device>_<HHMMSS>_<tag>/`。
   - 通过环境变量 `LEO_HW_SIM_CONFIG` 注入 Renode 外设脚本，支持 `--mock` 离线验证。
5. **双向通信验证与日志归因**：
   - 检查输出中的 RTT 日志（鉴权 `Auth Pass`、指令拉取 `0x8005`、状态上报 `0x8108`）及 `TCP_BRIDGE TX/RX` 原始报文。
   - 若服务端拒收或主动断开，立即在 `backend_dir` 调用 `leo-live-inspector` 的测试日志查询定位后端具体报错。

---

## 📦 架构分层与扩展新硬件

- **Renode CLI 与 IronPython 规范**：[references/renode-cli-guide.md](references/renode-cli-guide.md)
- **联动 `leo-live-inspector` 查数/造数/查日志**：[references/inspector-integration.md](references/inspector-integration.md)
- **MCU 芯片层**：`references/mcu/<chip>/`（如 [nrf54l15](references/mcu/nrf54l15/base.repl.tmpl)）
- **通信模组层**：`references/modems/`（如 [eigencomm_cat1.py](references/modems/eigencomm_cat1.py)）
- **具体硬件型号层**：`references/devices/<model>/`（如 [hj07/profile.md](references/devices/hj07/profile.md) 与 [hj07/device.json](references/devices/hj07/device.json)）

接入新硬件时：优先复用已有 `mcu/` 与 `modems/` 模块，仅在 `references/devices/<new_model>/` 新增 `device.json` 与 `profile.md` 说明差异寄存器/内存偏移即可。
