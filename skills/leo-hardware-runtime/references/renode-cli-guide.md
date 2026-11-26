# Renode CLI 跨平台操作与开发规范

## 1. CLI 安装与路径管理（macOS / Windows）

统一使用 `scripts/renode_manager.py` 管理生命周期，严禁在脚本或配置文件中写死用户目录：

```bash
# 1) 体检当前环境
python3 scripts/renode_manager.py doctor

# 2) 查看官方 Release 列表
python3 scripts/renode_manager.py releases

# 3) 预演安装 / 更新（Dry-run，不落盘）
python3 scripts/renode_manager.py install --version latest

# 4) 确认后正式安装 / 更新
python3 scripts/renode_manager.py install --version latest --confirm
```

### 各系统默认安装位置策略
- **macOS**：
  - 优先查找 `RENODE_BIN` 环境变量 -> `PATH` 中的 `renode` -> `/Applications/Renode.app/Contents/MacOS/Renode` -> `~/Applications/Renode.app/Contents/MacOS/Renode` -> `~/.local/share/leo-hardware-runtime/renode/Renode.app/Contents/MacOS/Renode`。
  - `install --confirm` 下载 `*.osx-arm64-portable.dmg`（或 x64 对应便携包），通过 `hdiutil` 静默挂载拷贝后卸载，并自动创建 `~/.local/bin/renode` 软链。
- **Windows**：
  - 优先查找 `RENODE_BIN` 环境变量 -> `PATH` 中的 `Renode.exe` / `renode.cmd` -> `%LOCALAPPDATA%\leo-hardware-runtime\renode\bin\Renode.exe` -> `%ProgramFiles%\Renode\bin\Renode.exe`。
  - `install --confirm` 下载 `*.windows-portable.zip`，免管理员权限直接解压至 `%LOCALAPPDATA%\leo-hardware-runtime\renode`，并生成 `%LOCALAPPDATA%\leo-hardware-runtime\bin\renode.cmd` 包装脚本。

---

## 2. 无头模式（Headless）运行要点

在 CI 或 Agent 终端调用 Renode 时：
1. **标准参数组合**：`renode --plain <script.resc>`，配合 `stdin=subprocess.DEVNULL` 与进程超时控制。
2. **避免 `--disable-gui=true`**：Renode 1.17.1 的 OptionsParser 会在 `--disable-gui=true` 时触发异常；直接传 `--plain` 即可自动降级到无界面 Console 模式。
3. **跨平台 `.repl` / `.resc` 路径铁律**：
   - 在 `.repl` 的 `filename: "..."` 与 `.resc` 的 `LoadHEX @...` 中，**Windows 路径也必须统一转为正斜杠 `/`（`.as_posix()`）**，避免 `\t`、`\n` 或 `\U` 被当成转义字符。

---

## 3. `PythonPeripheral`（IronPython 2.7）编写红线

Renode 1.17.1 内置的是 **IronPython 2.7.12 (.NET)**，与主机 Python 3.x 有显著差异，编写外设脚本必须遵守以下规则：

1. **禁止 Python 3 专属语法**：不使用 f-string（`f"..."`）、类型注解（`x: int`）、`pathlib`、`nonlocal` 等，统一使用 `%` 格式化和 `os.path`。
2. **十六进制编解码统一用 `binascii`**：
   - 使用 `binascii.hexlify(...)` 和 `binascii.unhexlify(...)`，不要混用 Python 2 的 `.encode("hex")` 与 Python 3 的 `bytes.fromhex()`。
3. **动态读取外部参数**：
   - 通过 `os.environ.get("LEO_HW_SIM_CONFIG")` 读取 `sim_launcher.py` 生成的 `runtime_config.json`，实现外设脚本彻底无硬编码。
4. **`bytes` / `bytearray` 写入 `SystemBus`**：
   - `bus.WriteByte(addr, val)` 的第二个参数在 IronPython 2.7 中需确保是 `int`（若遍历 `bytes`/`str`，需判断 `ord(b) if isinstance(b, str) else int(b)`）。
5. **Windows Socket 断连异常码**：
   - Windows Winsock 在对端关闭或重置连接时可能抛出 `10053`、`10054`、`10058`、`10060`，而 POSIX 下常见 `32 (EPIPE)`、`104 (ECONNRESET)`，桥接脚本需统一捕获并视为可恢复断连日志，避免异常穿透崩溃整个 Renode 进程。
6. **`IsWrite` 处理寄存器偏移量要用十六进制字面量**：
   - 如 `0x304`、`0x308`，切勿漏写 `0x` 前缀导致中断使能/清除位失效。
