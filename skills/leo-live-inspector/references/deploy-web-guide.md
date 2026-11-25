# 🖥️ 测试环境可视化控制台（独立可剥离 UI 模块）

面向人工可视化操作的本地控制台，与 AI 对话模式共享同一套 CLI 与公共合流引擎（`scripts/common/qa_merge.js`）。
为确保与核心 Skill 解耦、未来可随时独立剥离，**所有页面与 HTTP 服务代码均隔离在 `scripts/web_console/` 目录下**：

| 文件 | 职责 | 剥离说明 |
| :--- | :--- | :--- |
| `scripts/deploy_web.js` | 薄 CLI 启动入口（18 行） | 仅调用 `scripts/web_console/server.js` |
| `scripts/web_console/server.js` | 本地 HTTP API 服务（`127.0.0.1:6886`） | 含 `X-Leo-Token` CSRF 与同源校验，复用 CLI 脚本与 `qa_merge.js` |
| `scripts/web_console/index.html` | 纯静态单页前端模板 | 零构建依赖，可独立托管或迁入桌面壳 |
| `scripts/common/qa_merge.js` | 通用 Git 仓库四级发现与隔离 `worktree` 合流引擎 | **核心 CLI 层**（`ci_deploy.js --merge-from` 与 Web 控制台共用） |

---

## 一、启动方式（幂等复用与代码指纹自动热重载）

```bash
node scripts/deploy_web.js --open          # 幂等启动并在浏览器打开 http://127.0.0.1:6886
node scripts/deploy_web.js --restart       # 强制重启当前端口上的控制台实例
node scripts/deploy_web.js --stop          # 停止当前端口上的控制台实例
node scripts/deploy_web.js --port 6899     # 指定其他本地端口
```

- **代码指纹（`buildId`）自动检测**：`scripts/web_console/server.js` 在启动时对 `deploy_web.js`、`web_console/*` 与 `common/*.js` 计算 12 位 SHA-1 指纹，并通过 `GET /api/initial` 暴露 `{ lastProject, buildId, pid }`；
- **同版本直接复用、跨版本自动重启**：再次执行 `node scripts/deploy_web.js` 时，若目标端口已有控制台在运行且 `buildId` 一致，直接复用现有进程；若代码已更新（`buildId` 不一致）或传了 `--restart`，自动平滑终止旧进程并启动新实例。

---

## 二、核心视图与高性能双主题

1. **首页 · 近三周工时概览（`#homeManhour`）**：
   - 打开首页即自动拉取**上周 / 本周 / 下周**（21 天）的 ONES 个人工时日历，按周横向并排对比哪天已打满（绿）、不足（黄）、未打/超出（红）、非工作日（灰）或未来待打（虚框）。
2. **ONES 研发协作工作台（`#page-ones`）**：
   - 聚合 `工时概览`（默认子页，含 4 项统计卡、月历视图与未打满工作日明细）、`我的排期`（含本周/本月/上一月/上周一~本周日/本周一~下周五 5 档快捷预设与请求序号防乱序覆盖）、`需求详情`、`需求检索`、`缺陷检索`、`迭代 / 项目` 以及两阶段 `写入`（新建需求、新建缺陷、调整排期、移入迭代、状态流转，均强制「预检 Diff → 确认提交」）。
3. **亮色 / 暗色双主题与零闪烁滚动**：
   - 支持右上角一键切换亮色/暗色主题（持久化至 `localStorage['leo.theme']`，亦支持 `?theme=light|dark` 参数直达），`<head>` 首帧同步落属性防闪烁；
   - **渲染性能守卫**：全站禁用 `backdrop-filter`、`background-attachment: fixed`、`filter: blur()` 与卡片悬停 `translateY`，消除长页面滚动时的合成层重算与白块闪烁。

---

## 三、通用项目发现（零配置覆盖全量服务）

项目清单不再局限于手工编写的 JSON，而是按 **4 级自动发现** 聚合全量服务：

1. **手动指定路径**：页面上手动设置的本地 Git 仓库路径（最高优先级）；
2. **已登记 Git 仓库**：内置 `resources/project_repos.json` 与个人扩展 `~/.shrimp/skills/live-inspector/project_repos.json`（自动托管裸克隆到 `~/.leo-live-inspector/clones/<project>`，免本地检出工作区）；
3. **本机工作区自动嗅探**：自动扫描 `~/IdeaProjects`、`~/dev`、`~/WebstormProjects`、`~/project` 等目录，命中后自动把 `origin` 地址沉淀到本地 `project_repos.json`；
4. **Shipwright 构建器自动反查**：若本机无仓库且未登记，自动向 Shipwright 查询该微服务的测试构建器，从构建器 `git` 步骤提取 GitLab 仓库地址并自动缓存。

---

## 四、双模使用（AI 对话 vs 网页控制台）

「隔离 worktree 合并开发分支到最新 `qa-YYYY-MM` 并构建部署」既可以在网页控制台点按钮，也可以直接在 IDE 对话中由 AI 调用 `ci_deploy.js` 完成：

```bash
# 阶段 1：AI 预审（Dry-Run 隔离预演合并，检查是否有冲突，不推送不构建）
node scripts/ci_deploy.js zulin-iot-platform --merge-from feature/my-branch --dry-run

# 阶段 2：用户确认后，执行隔离合并 + 推送 QA + Shipwright 构建 + 下发测试工作负载
node scripts/ci_deploy.js zulin-iot-platform --merge-from feature/my-branch
```

---

## 五、凭据台账与焦点切回自动同步（零高频轮询、免改扩展）

凭据 Tab 汇总全部 **18 项** 平台凭据（含 ONES 研发管理平台），页面只展示元信息（是否存在、更新时间、Cookie 名清单），**绝不向前端返回 Cookie / Token 值**。

- **无需升级 Chrome 扩展**：保持 `1.4.2` 扩展零改动；
- **焦点切回单次同步（防 SSO 风控）**：
  1. 点击「刷新」→ 先静默读 1 次 Chrome 现有 Cookie 并打接口探活，若有效直接落盘；
  2. 若未登录或已过期 → 前端直接通过浏览器原生 `window.open` 在当前窗口打开新标签页进入目标站点登录页，并将该凭据标记为 `待登录切回`（**后台不进行 3 秒高频轮询**）；
  3. 当你在新标签页完成登录、**切回控制台标签页的瞬间（触发 `focus` / `visibilitychange` 事件）**，前端自动触发单次静默读取与探活落盘。

---

## 六、安全边界

1. **本地防跨站 CSRF 保护**：服务启动时生成随机 `SESSION_CSRF_TOKEN`，所有 `POST /api/*` 强制校验 `Host`、`Origin` 同源以及 `X-Leo-Token` 请求头，阻断外部网页跨站调用本地接口；
2. **任务 ID 严格校验**：`/api/job?id=` 强制校验 `/^[A-Za-z0-9_-]{1,64}$/`，阻断路径穿越；
3. **冲突严格失败回滚**：隔离 `worktree` 合并出现冲突立即 `git merge --abort` 回滚并列出冲突文件；受保护 QA 分支自动转推 `auto/merge-...` 临时分支并生成 GitLab MR 链接；
4. **生产物理只读**：所有写接口在服务端硬钉测试环境（`-e test` / `--env TEST`），并强制执行「预检 → 确认」两步。
