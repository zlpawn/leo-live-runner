# 通用浏览器操作与页面抓取手册

通过随附的 CLI 操作用户真实的有界面 Chrome：页面导航、通用数据抓取、元素交互、DOM 快照、截图和网络抓包。

```bash
node <skillDir>/scripts/cli/index.mjs <command>
```

> 使用边界（线上写操作红线、Cookie 规则）见 `SKILL.md` 的“通用浏览器操作”章节，本手册全面阐述通用抓取与交互能力。

---

## 核心机制与架构

- **桥接服务（Bridge Server）**：监听本地端口（默认 `127.0.0.1:19526`，扩展默认同时兼听 `19526` 与 `19527` 双端口），负责分发命令队列并接收 Chrome 扩展回传的结果。
- **Chrome 扩展（Extension）**：常驻浏览器后台，通过长轮询消费命令。在目标页面上结合 **CDP（Chrome DevTools Protocol 原生可信输入事件）** 与 DOM 树完成高保真操作。可在扩展「高级设置」中可视化修改 Bridge 地址与端口；若开启 Shrimp 本地网关（默认 `8787`），自动渐进式呈现网关配置与数据导出。
- **任务组与窗口隔离**：默认**新开独立窗口**（`sameWindow: false`）执行自动化，与用户当前正在浏览操作的窗口互不干扰。独立窗口与用户窗口共享同一 Chrome profile，所有 Cookie、LocalStorage 及登录态直接可用。
- **按需启动与无感保活**：操作浏览器的命令发现桥接没开，会自动在后台拉起并等扩展连上（需要 Chrome 已打开）。桥接连续 10 分钟没有收到命令就自动退出；扩展的轮询和心跳不算命令。`health`、`doctor` 只检查，不会启动桥接。

---

## 通用抓取与交互工作流

### 1. 服务启动与健康探测
- **主动启动并等待扩展**：`start`（或 `node <skillDir>/scripts/cli/index.mjs start`）
- **前台运行、调整空闲时间**：`server --port 19526 --idle-exit-min 30`（`0` 表示不自动退出，也可用环境变量 `LEO_LANTERN_IDLE_EXIT_MIN`）
- **端口冲突自愈与换端口指引**：若 `19526` 与 `19527` 均被其他程序占用，CLI 自动探测下一个可用空闲端口（如 `19528`），并抛出 `bridge_port_occupied` 错误，指导用户在 Chrome 扩展的「高级设置」->「Bridge 地址」中填入推荐端口保存，随后带 `--port <新端口>` 重试。
- **检查服务与扩展状态**：`health` 或 `doctor`。若 `extensionOnline: false`，到 `chrome://extensions` 确认扩展已加载并保持 Chrome 运行。
- **重载扩展**：`ext-reload`（当后台扩展更新后，无需重启 Chrome 即可重新加载扩展）。

### 2. 任务生命周期与标签页管理
- **开启或复用任务组**：`start-task --title "browser-task"`（默认新开独立窗口，不干扰用户浏览；同窗口执行加 `--same-window=true`）
- **查看所有标签页**：`tabs`
- **接管指定标签页**：`claim --tabId=<tabId>`（会控制已有页面，慎用；`start-task` 的 `about:blank` 占位页若未使用，会在接管或 `end-task` 时自动关闭）
- **关闭指定标签页**：`close-tab <tabId>`
- **导航、新标签与刷新**：
  - `goto "https://example.com"`
  - `new-tab "https://example.com"`（强制新开加 `--force`）
  - `reload`（跳过缓存加 `--bypass-cache`）
- **结束任务**：`end-task`（同时关闭整个任务标签组加 `--close-group`）

### 3. 页面感知与通用数据抓取
- **高密度 DOM 快照**：
  - `snapshot` 或 `state`：获取当前页高信息量交互 DOM 树（包含 `tag`、`text`、`selector`、`id`、`rect`、`visible`、`ref`、`generation`）。
- **精准检索元素**：
  - `find --text "查询"` / `find --sel "button.submit"` / `find --within ".ant-menu" --text "领域空间"` / `find --nth 0` / `find --target '{"kind":"semantic","role":"button","name":"Sign in"}'`
- **读取页面纯文本（大文本抓取）**：
  - `content --max-chars 4000`：快速读取页面主体文本内容，适用于文章、长篇日志或脱壳文本抓取。
- **流式/动态页面稳定等待**：
  - 固定文本等待：`wait --text "加载完成" --timeout-ms 5000`
  - 内容静止等待（N 毫秒无内容变化）：`wait --idle --idle-ms 2000`（抓取流式 LLM 输出或长轮询接口数据必备）
  - 局部区域静止等待：`wait --sel ".data-table" --idle --idle-ms 1500`
- **通用结构化数据抽取（推荐避坑方式）**：
  - `eval "1+1"`：直接执行表达式。
  - `eval --file "/path/to/extract.js"`：**强烈推荐**。将页面抽取逻辑写成单独 JS 文件通过 `--file` 执行，返回结构化 JSON，彻底避免命令行引号转义和中文破坏。

### 4. 复杂元素交互与控制
- **点击元素（原生 CDP 可信物理事件，支持 ref / text / sel / target；重名可用 `--within` 限定容器或 `--nth` 指定序号，歧义报错会附带候选列表 `candidates`）**：
  - `click --ref 10`（最简推荐）
  - `click --text "进入配置"`
  - `click --text "领域空间" --within ".ant-menu"`（或 `--nth 0`）
  - `click --sel "button.submit"`
  - `click --target '{"kind":"ref","ref":10}'`
- **表单填写（兼容 React/Vue 受控组件，支持 `--within` / `--nth` / `--blur` 失焦校验）**：
  - `fill --ref 10 --val "admin" --blur`
  - `fill --sel "#input" --within ".ant-modal" --val "admin" --blur`
- **键盘按键（原生 CDP `Input.dispatchKeyEvent`，`isTrusted: true`）**：
  - `press Enter --sel "input[placeholder*='搜索']"`：完全支持回车查询、Tag 标签确认与快捷键触发。
- **文件上传（原生 CDP `DOM.setFileInputFiles`，绕过系统弹窗）**：
  - 单文件：`upload "/path/to/file.png"`
  - 多文件批量：`upload "/path/to/file1.png" "/path/to/file2.png"`
  - 指定选择器：`upload --sel "input[type='file']" --files "a.png,b.png"`

### 5. 网络抓包、截图与凭证导出
- **非侵入式网络抓包（XHR/fetch 接口数据抓取；若标签页已有其他调试器占用，自动降级为页面层 `page_hook` 拦截 `fetch`/`XHR`）**：
  - 启动抓包：`net-start`
  - 过滤获取接口报文：`net-get --grep "api/v1/list"`（直接获取真实后端返回的原始 JSON 数据）
  - 停止抓包：`net-stop`
- **页面与局部截图**：
  - 可视区域截图：`screenshot --out page.png`
  - 整页长截图：`screenshot --full-page --out full.png`
  - 元素区域截图：`screenshot --sel ".chart-container" --out chart.png` 或 `screenshot --ref 10 --out btn.png`
- **Cookie 导出与中继（自动创建父目录）**：
  - Netscape 格式：`cookies --domain "example.com" --format txt --out "$HOME/.shrimp/cookies/example.com.txt"`
  - JSON 格式：`cookies --domain "example.com" --format json`
  - 按 URL 读取：`cookies --url "https://example.com/path" --out "$HOME/.shrimp/cookies/example.com.json"`
  - 读不到时后台打开网站提取：`cookies --url "https://example.com" --open-if-missing --out "$HOME/.shrimp/cookies/example.com.json"`（在后台独立窗口打开，读完自动关闭；若跳转登录页抛出 `login_required`，提示用户登录）。

---

## 通用抓取的四大标准范式

在编写抓取逻辑或沉淀页面手册（`page-flow`）时，根据页面特点选用以下最佳抓取范式：

### 范式 1：DOM 模式结构化抽取（适合表格、列表、图表）
```bash
set -e
cli() { node "$SKILL_DIR/scripts/cli/index.mjs" "$@"; }

# 1. 启动任务并导航
cli start-task --title "scrape-table"
cli goto "https://target-system.example.com/data"

# 2. 等待表格完全渲染稳定
cli wait --sel ".ant-table-tbody" --timeout-ms 10000
cli wait --idle --idle-ms 1500 --sel ".ant-table-tbody"

# 3. 编写抽取脚本并写入临时文件执行
cat << 'EOF' > /tmp/extract_data.js
return Array.from(document.querySelectorAll('.ant-table-tbody tr')).map(row => {
  const cells = row.querySelectorAll('td');
  return {
    id: cells[0]?.innerText.trim(),
    name: cells[1]?.innerText.trim(),
    status: cells[2]?.innerText.trim(),
    time: cells[3]?.innerText.trim(),
  };
}).filter(item => item.id);
EOF

cli eval --file "/tmp/extract_data.js" > "/tmp/result.json"
cli end-task
```

### 范式 2：接口嗅探模式抓取（适合复杂分页、数据量大或虚拟滚动列表）
很多现代前端采用了虚拟滚动或动态图表，直接抓取 DOM 耗时且易遗漏。采用网络抓包可直接截获原始后端 JSON：
```bash
cli start-task --title "sniff-api"
cli net-start
cli goto "https://target-system.example.com/complex-dashboard"

# 点击查询或滚动
cli wait --idle --idle-ms 2000
cli net-get --grep "/api/v1/detail" > /tmp/api_captured.json
cli net-stop
cli end-task
```

### 范式 3：纯文本与长文档快速抽取（适合文档、公告、知识库）
```bash
cli start-task --title "scrape-article"
cli goto "https://wiki.example.com/doc/123"
cli wait --sel "article" --timeout-ms 5000
cli content --max-chars 8000 > /tmp/article.txt
cli end-task
```

### 范式 4：凭证中继与脚本联动（适合海量文件下载或第三方脚本）
```bash
# 自动在后台提取已登录 Cookie 并导出为 Netscape 格式
cli cookies --url "https://media.example.com" --open-if-missing --format txt --out "/tmp/media_cookies.txt"

# 供 curl 或 Python 脚本携带 Cookie 批量下载原始数据
# curl -b /tmp/media_cookies.txt "https://media.example.com/api/export" -o data.csv
```

---

## 常见排查与 12 大通用交互/抓取避坑指南

1. **Ref 定位与 Generation 代际机制**：
   - `snapshot` / `state` / `find` 返回的所有元素对象中均携带 `generation` 与 `ref`。
   - CLI 支持直接传入 `--ref <N>`（如 `click --ref 10`），或以 JSON 形式传入 `--target '{"kind":"ref","ref":10}'`。
   - 若省略 `generation`，系统会自动绑定当前活动代际；若提供了 `generation` 且页面已发生全局跳转，系统会精准识别出 `stale_ref_generation` 并阻止误操作。

2. **UI 组件库（Ant Design / Element Plus 等）交互最佳实践**：
   - 下拉选择框（Select / Cascader）通常将展开事件绑定在内层的 `.ant-select-selector` 或 `input[role='combobox']` 的 `mousedown` 上。
   - 优先使用 `--sel ".ant-select-selector"` 或通过 `state` 获取的内层 `ref`。
   - `click` 内置对 `.ant-select` 根节点的智能穿透，自动分发到实际响应事件的 `.ant-select-selector`。
   - 复杂浮层兜底派发：`eval "document.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))"`。

3. **模态弹窗/遮罩层拦截物理点击 (Modal Wrap Interception)**：
   - **现象**：`click` 返回成功但界面未响应或未关闭。
   - **根因**：`click` 采用 CDP 原生可信物理事件（`isTrusted: true`），遵循 Chromium 真实 Hit-Testing。若组件库（如 `ant-modal-wrap`）在销毁/切换时残留了透明遮罩，点击会落在遮罩上（可通过 `eval "document.elementFromPoint(x, y)"` 验证顶层命中元素）。
   - **对策**：刷新页面可清除残存遮罩；或通过 `eval "document.querySelector('...').click()"` 绕过物理 Hit-Testing 直接派发。

4. **eval 脚本变量作用域与结果解析**：
   - `eval` 默认通过 IIFE 闭包执行脚本，因此即使连续多次使用 `const x = 1;` 声明变量，也不会污染全局命名空间，彻底规避 `Identifier '...' has already been declared` 异常。
   - 输出统一为 `{ ok: true, evalResult: <val|null>, hasResult: true, resultType: "..." }`，无需编写额外解析适配代码。

5. **流式 AI 对话与动态页面等待**：
   - 针对 LLM 流式输出或长轮询接口，使用 `wait --idle --idle-ms 2000`，当页面文本连续 2 秒不再发生变化时自动唤醒继续执行后续步骤。

6. **Web Component 与 Shadow DOM 穿透查找**：
   - **现象**：现代前端组件库（Vue 3 `defineCustomElement` / Lit / Polymer）中部分核心按钮在常规 DOM 查找中返回空。
   - **根因**：元素被封装在闭包 Shadow DOM 中（`el.shadowRoot` 为 null，或存储于内部属性 `el._sr`）。
   - **穿透方案**：
     ```bash
     eval "(() => {
       const host = document.querySelector('custom-element-tag');
       const root = host?._sr || host?.shadowRoot || host;
       const btn = root.querySelector('button.submit');
       if (btn) btn.click();
     })()"
     ```

7. **富文本编辑框（Contenteditable）安全数据绑定**：
   - **现象**：对 `div[contenteditable="true"]` 直接使用表单赋值，界面虽有文字但框架（Vue/React）未更新状态。
   - **最佳实践**：使用原生 `insertText` 模拟用户输入流：
     ```bash
     eval "(() => {
       const el = document.querySelector('div[contenteditable=\"true\"]');
       if (el) {
         el.focus();
         document.execCommand('selectAll', false, null);
         document.execCommand('insertText', false, '要注入的内容');
       }
     })()"
     ```

8. **模糊文本语义匹配与侧边栏防误触 (Anti-Ad Ambiguity Guard)**：
   - **现象**：使用 `click --text="关键词"` 定位表单时，若页面左侧栏存在同名链接可能误点击跳转。
   - **防范机制**：表单控件交互优先限定在主内容容器内（如 `.content-main` 或通过特异选择器定位）；误开外部域名标签页通过 `close-tab <tabId>` 及时关闭，并通过 `claim --tabId=<原tabId>` 恢复主工作流。

9. **选择器歧义（`selector_ambiguous`）与高特异性选择器**：
   - 多个输入框可能复用相同的底层类名（如 `input.semi-input`），导致 CLI 提示 `N matches for css target`。
   - 改用携带属性语义的高特异性选择器，如 `input[placeholder*='标题']`、`input[placeholder*='搜索']`，或结合父级节点层级缩小范围。

10. **标签组件（Tag Input）与键盘 Enter 键模拟**：
    - 向标签输入框填入文本后，页面未生成胶囊标签。
    - 使用 `press Enter --sel="input[placeholder*='标签']"`。`press` 优先采用 CDP 原生可信键盘事件（`Input.dispatchKeyEvent`，`isTrusted: true`），完全支持回车确认、提交表单与快捷键；极端受限环境自动降级为合成键盘事件。

11. **自定义日历与分时联动控件交互 (Cascading Date/Time Picker)**：
    - 平台定时/日期面板并非标准 HTML5 日期控件，而是包含时区、日历表格、时/分双列滚动的复合控件。
    - 操作时序：点击日期外层触发器展开日历 $\rightarrow$ 过滤纯数字文本节点并点击目标日 $\rightarrow$ 点击时间外层触发器 $\rightarrow$ 针对双列滚轮分别点选对应小时与分钟 $\rightarrow$ 再次点击触发器收起面板 $\rightarrow$ 校验显示文本。

12. **SPA 表单异步渲染与 Toast 拦截自愈机制**：
    - 提交后捕获页面全局 Toast / 警告弹窗（如 `.ant-message`, `.toast`, `.modal`），若有拦截错误立即中止并抛出明细；确认命中成功标记后才认定操作完毕。

---

## 代码来源与同步

`scripts/cli/` 的主源在 `local-ai-gateway` 的 `lib/skills/leo-lantern/scripts/cli/`，这里是全量副本，以便本 Skill 独立使用。两份共用 `19527` 端口和同一个扩展。改完主源后，在 `local-ai-gateway` 根目录运行 `npm run sync:lantern-cli` 即可无损同步。
