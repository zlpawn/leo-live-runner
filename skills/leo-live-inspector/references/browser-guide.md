# 通用浏览器操作手册

通过随附的 CLI 操作用户真实的有界面 Chrome：页面导航、元素交互、DOM 快照、截图和网络抓包。

```bash
node <skillDir>/scripts/cli/index.mjs <command>
```

> 使用边界（线上写操作红线、Cookie 规则）见 `SKILL.md` 的“通用浏览器操作”章节，本手册只讲用法。

## 工作机制

- **桥接服务**：监听 `127.0.0.1:19527`，分发命令并接收扩展回传的结果。
- **Chrome 扩展**：通过长轮询消费命令，结合 CDP 原生可信输入事件和 DOM 完成操作。
- **窗口隔离**：默认新开独立窗口（`sameWindow: false`），不干扰用户当前窗口；与用户窗口共享同一 Chrome profile，登录态直接可用。
- **按需启动**：操作浏览器的命令发现桥接没开，会自动在后台拉起并等扩展连上（需要 Chrome 已打开）。桥接连续 10 分钟没有收到命令就自动退出；扩展的轮询和心跳不算命令。`health`、`doctor` 只检查，不会启动桥接。

## 工作流

1. **启动与检查**（一般可省略）
   - 主动启动并等待扩展：`start`
   - 前台运行、调整空闲时间：`server --port 19527 --idle-exit-min 30`（`0` 表示不自动退出，也可用环境变量 `LEO_LANTERN_IDLE_EXIT_MIN`）
   - 检查状态：`health`。若 `extensionOnline: false`，到 `chrome://extensions` 确认扩展已加载，并保持 Chrome 运行。
2. **任务生命周期**
   - 开启或复用任务：`start-task --title "browser-task"`（需要在同一窗口执行时加 `--same-window=true`）
   - 查看所有标签页：`tabs`
   - 接管指定标签页：`claim --tabId=<tabId>`（会控制用户已有页面，慎用；`start-task` 的 `about:blank` 占位页若没用过，会在接管或 `end-task` 时自动关闭）
   - 导航或新标签：`goto "https://example.com"`、`new-tab "https://example.com"`
3. **页面感知与交互**
   - DOM 快照（含 tag、text、selector、rect、visible、ref、generation）：`snapshot` 或 `state`
   - 查找元素：`find --text "保存"`
   - 点击（CDP 可信事件，支持 text / sel / ref）：`click --ref 10`、`click --text "进入配置"`、`click --sel "button.submit"`
   - 填写表单（原生 Prototype Setter，支持 React 受控组件）：`fill --ref 10 --val "text"`、`fill --sel "#input" --val "text"`
   - 上传文件（绕过系统弹窗）：`upload "/path/a.png" "/path/b.png"`，或 `upload --sel "input[type='file']" --files "a.png,b.png"`
   - 执行脚本（闭包隔离，返回 `{ ok, evalResult, hasResult, resultType }`）：`eval "1+1"`、`eval --file "/path/to/script.js"`
   - 等待文本：`wait --text "成功" --timeout-ms 5000`
   - 等待内容静止（流式输出）：`wait --idle --idle-ms 2000`，限定区域加 `--sel ".chat-messages"`
   - 读取纯文本：`content --max-chars 4000`
4. **网络抓包与截图**
   - 抓包：`net-start`、`net-get --grep "api"`、`net-stop`
   - 截图：`screenshot --out page.png`、`screenshot --sel ".box" --out box.png`、`screenshot --ref 10 --out btn.png`
5. **结束任务**：`end-task`

## 常见排查

1. **Ref 与 Generation**：`snapshot`、`state`、`find` 返回的元素都带 `ref` 和 `generation`。可直接传 `--ref 10`，或 `--target '{"kind":"ref","ref":10}'`。省略 `generation` 时绑定当前文档；提供了 `generation` 且页面已跳转，会返回 `stale_ref_generation` 并阻止误操作。
2. **Ant Design / Element Plus 下拉框**：展开事件通常绑定在内层元素的 `mousedown` 上。优先用 `--sel ".ant-select-selector"` 或 `state` 拿到的内层 `ref`；`click` 对 `.ant-select` 根节点会自动穿透。复杂浮层可用 `eval` 派发 `mousedown`。
3. **遮罩拦截点击**：`click` 返回成功但界面没反应，可能是残留遮罩挡住了按钮。用 `eval "document.elementFromPoint(x, y)"` 确认命中元素；刷新页面通常可恢复。
4. **流式内容**：LLM 流式输出或长轮询页面，用 `wait --idle --idle-ms 2000` 等文本稳定后再继续。
5. **Shadow DOM**：常规查找找不到自定义组件内的元素时，用 `eval` 从宿主进入：`host?._sr || host?.shadowRoot`。
6. **富文本编辑框**：对 `div[contenteditable="true"]` 直接赋值，框架可能感知不到。先 `el.focus()`，再 `document.execCommand('insertText', false, '文本')`。
7. **模糊文本误触**：`click --text` 可能点中侧边栏的同名链接。表单控件优先用限定在主内容区的选择器；误开了无关标签页，用 `close-tab <tabId>` 关闭，再 `claim --tabId=<原tabId>` 恢复。
8. **`selector_ambiguous`**：多个元素复用同一类名时会报错。改用带语义的选择器，如 `input[placeholder*='标题']`，或加父级缩小范围。
9. **标签输入框要回车确认**：`press Enter --sel "input[placeholder*='标签']"`。`press` 派发的是脚本键盘事件（`isTrusted: false`），只接受可信事件的组件和回车提交表单等默认行为不会响应。

## 代码来源

`scripts/cli/` 的主源在 `local-ai-gateway` 的 `lib/skills/leo-lantern/scripts/cli/`，这里是副本，以便本 Skill 独立使用。两份共用 `19527` 端口和同一个扩展，要保持一致：改完主源后，在 `local-ai-gateway` 根目录运行 `npm run sync:lantern-cli`。
