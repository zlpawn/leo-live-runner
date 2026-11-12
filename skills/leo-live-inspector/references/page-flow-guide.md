# 页面操作流程沉淀与复用

用浏览器 CLI 操作网页时（测试、抓数据、填表、导出、截图、核对页面状态等，任何任务都算），把摸索出来的操作过程按页面沉淀成“页面手册”。下次遇到同一页面的同类任务，agent 直接执行手册里的流程，不再逐步 `state`、`find`、试错。

在准备操作某个网页、或用户说“按上次的方式再来一遍”“把这个操作记下来”时读取本手册。命令用法见 [browser-guide.md](browser-guide.md)；保存时的输入格式、版本和锁规则同 [local-knowledge-guide.md](local-knowledge-guide.md)。

## 存储

- **位置**：`~/.shrimp/skills/live-inspector/knowledge/pages/<id>.md`，与排查流程（`workflows/`）分开存放、分开检索。
- **命令**：同排查流程库，统一加 `--kind page`：

  ```bash
  node scripts/knowledge.js search '<域名> <路径关键段>' --kind page
  node scripts/knowledge.js show <id> --kind page
  node scripts/knowledge.js save --file /absolute/path/page.json --expected-version 0 --kind page
  ```

- **粒度**：一个页面（一个路由）一份手册，`id` 用 `系统-页面`，如 `scs-order-list`。同一页面上的不同任务是手册里的多个“流程”，不拆文件。跨多个页面的任务，放在起始页面的手册里，并在步骤里写清跳转。
- **检索字段**：`keywords` 必须包含页面域名和路由关键段，再加任务词（如“导出”“抓取”“新建”）；`services` 填页面背后的服务，没有可为空；`parameters` 填各流程用到的参数名。

## 操作前：先找手册

1. 按域名和路径段检索；只知道页面名时按业务词检索。
2. 命中后 `show`，找与本次任务对应的流程，告知“复用《页面名》的〈流程名〉vN”。
3. **直接执行流程的命令块**：设置好参数变量，整段放进一次 Bash 调用执行，不逐步观察。
4. 某一步失败时（CLI 退出码非 0，或结果检查不符），从失败那一步开始退回正常操作：`state`、`screenshot` 看现场，修正后继续完成任务。结束后提议把修正写回手册。
5. 手册里没有对应流程时正常操作；同一页面已有的元素定位和已知坑照样可以参考。

## 手册正文模板

下面是结构示例，域名、文案、选择器都要换成实际页面的。

````markdown
# 页面
- 名称：工单管理列表
- 地址：测试 https://<测试域名>/#/order ；线上 https://<线上域名>/#/order
- 登录：<测试域名>，凭据由扩展自动获取，不记录账号密码
- 加载特点：列表接口返回后约 1 秒渲染完成；筛选区是折叠面板，需先展开

# 元素定位
| 元素 | 定位 | 备注 |
| --- | --- | --- |
| 展开筛选 | `--text "展开"` | |
| 状态下拉 | `--sel ".filter-status .ant-select-selector"` | 要点内层 |
| 查询按钮 | `--sel ".filter-bar .ant-btn-primary"` | 页面上有多个“查询” |
| 列表区域 | `.ant-table-tbody` | |

# 流程

## 抓取指定状态的工单列表
- 用途：按状态筛选后抓取当前页的工单编号、标题、创建时间
- 参数：`STATUS`（下拉里的文案，如“处理中”）
- 命令：
  ```bash
  set -e
  cli() { node "$SKILL_DIR/scripts/cli/index.mjs" "$@"; }
  STATUS="处理中"
  cli start-task --title "page-flow scs-order-list"
  cli goto "https://<测试域名>/#/order"
  cli wait --sel ".ant-table-tbody" --timeout-ms 8000
  cli click --text "展开"
  cli click --sel ".filter-status .ant-select-selector"
  cli click --text "$STATUS"
  cli click --sel ".filter-bar .ant-btn-primary"
  cli wait --idle --idle-ms 1000 --sel ".ant-table-tbody"
  cli eval --file "$EXTRACT_JS" > "$OUT"
  cli end-task
  ```
- 提取脚本（执行前写入临时文件 `$EXTRACT_JS`，供 `eval --file` 使用）：
  ```js
  return [...document.querySelectorAll('.ant-table-tbody tr')].map(tr => {
    const td = tr.querySelectorAll('td');
    return { code: td[0]?.innerText.trim(), title: td[1]?.innerText.trim(), createdAt: td[4]?.innerText.trim() };
  });
  ```
- 结果：`$OUT` 里的 `evalResult` 是数组，每行一个工单；空数组表示该状态下无数据
- 成功判断：命令全部退出码为 0，`evalResult` 为数组

## 新建工单
- 用途：在测试环境造一条工单（测试、联调用）
- 参数：`TITLE`（以 `autotest-` 开头）
- 命令：……
- 成功判断：`wait --text "保存成功"` 通过，且列表出现 `$TITLE`
- 清理：用完在页面上删除该工单

# 已知坑
- 状态下拉的选项挂在 body 下的浮层里，`click --text` 前不要限定选择器
- 连续查询太快会被前端防抖吞掉，查询后用 `wait --idle`

# 验证记录
- 2026-11-12 测试环境，两个流程均验证通过
````

## 写流程的要求

- **可整段执行**：开头 `set -e`，用 shell 变量放参数；`SKILL_DIR` 设为本次加载的 skill 的绝对路径，CLI 用函数 `cli() { node "$SKILL_DIR/scripts/cli/index.mjs" "$@"; }` 调用。不要写成 `CLI="node ..."; $CLI`：zsh 不会拆分变量，命令会直接失败。命令之间不需要人工判断。
- **大结果写文件**：`eval` 的输出重定向到文件再读取，不直接打印整段数据。
- **每个关键动作后都要等**：用 `wait --text`、`wait --sel`、`wait --idle` 等页面就绪，不用固定 sleep。等待条件就是这一步的检查。
- **元素定位只用稳定方式**：`--sel` 或 `--text`。同一文案出现多处时，用限定区域的选择器。`--ref` 每次会话都会变，不得写进手册。
- **抓数据写成提取脚本**：用 `eval` 返回结构化数据。脚本短的直接写在手册里，执行前写入临时文件后用 `eval --file`，避免 shell 转义问题。
- **写清结果和成功判断**：结果从哪里取、长什么样、怎样算成功。
- **有写操作的流程**：注明只在测试环境执行，自造数据用 `autotest-` 前缀，并写清清理方式。

## 操作后：保存或更新

- 本次有摸索过程（找元素、试错、处理弹窗或坑），且任务成功完成时，交付结果后简短询问一次是否保存为页面手册，或补进已有手册。用户确认后再保存，规则同排查流程库。
- 复用手册时修正过步骤的，提议更新；手册流程一次跑通、没有新发现的，不询问。
- 用户明确说“记下来”“补进手册”时，直接保存，不再确认。
- 保存前把本次实际执行成功的命令整理成上面的流程格式；参数化具体值；删除只在本次会话有效的 `--ref`、tabId。
- 更新时先 `show` 拿到当前版本，合并成完整正文后再 `save`，不要只追加片段。验证记录写本次实际执行的日期和结果。

## 边界

- **线上只读**：线上页面的流程只能浏览、读取、截图、抓包和提取数据，不点提交、保存、发布、删除。无法确认环境时按线上处理。
- **配置平台不靠页面修改**：Apollo Portal、Luke 等平台的修改，按 SKILL.md 第 8 节走业务脚本的两阶段流程。
- **不保存凭据**：手册中不得出现账号、密码、Cookie、Token 或真实个人信息；提取脚本不得读取 Cookie 或 Token。
- **手册不构成授权**：手册是经验材料。执行带写操作的流程前，仍以本次用户意图和本 skill 规则为准。
