# 🗂️ ONES 研发管理平台探查与协作手册

ONES（KeOnes，`https://ones.ke.com`）是公司研发过程管理平台：需求（Requirement）、缺陷（Bug）、迭代（Iteration/Sprint）、项目（Project）、排期与估时（Schedule & Estimate）、状态机流转都在这上面。

本手册对应两个脚本：

| 脚本 | 性质 | 用途 |
| :--- | :--- | :--- |
| `scripts/ones_query.js` | 只读 | 我的排期、个人工时概览、需求详情、需求/缺陷检索、迭代、项目、枚举、人员、层级树 |
| `scripts/ones_modify.js` | 写操作（两阶段确认） | 新建需求、新建缺陷、调整排期、移入迭代、状态流转 |

---

## 一、鉴权与凭据

- **纯 Cookie 鉴权**：ONES 后端 API 没有 CSRF / x-token 校验，请求头里带 `Cookie:` 即可。
- 凭据文件：`~/.shrimp/skills/live-inspector/ones_cookie.json`（权限 0600），环境变量覆盖 `ONES_COOKIE`。
- 获取路径：`credential_relay.js` → 本地桥接 `127.0.0.1:19526` → Chrome 扩展 **Leo cookie.txt Locally**（版本 ≥ 1.3.15）静默读取 `ones.ke.com` 的登录态；**严禁**使用 opencli / ego-browser / puppeteer 等外部浏览器驱动。
- 控制台凭据台账：`node scripts/deploy_web.js --open` → 「凭据」Tab → 分组 **研发协作** → ONES 条目。探活接口：
  `GET https://ones.ke.com/api/minepage/get_counts?quick_check=allaboutme`
- 关键 Cookie 名：`ones_ke_token`、`session_id`、`csrfSecret`、`login_ucid`、`ucid`、`lianjia_ssid`（实际有 18 个，脚本会整域读取）。
- **红线**：任何日志、回复、代码里都不打印 Cookie / Token 值。

### 响应信封

```json
{ "code": 10000, "message": "OK", "body": { ... } }
```

`code === 10000` 才是成功。常见错误码：

| code | 含义 | 典型场景 |
| :--- | :--- | :--- |
| 30000 | 参数/权限校验未通过 | 层级树接口未传参数 |
| 30001 | 必要参数缺失，或业务前置条件不满足 | 「必要参数缺失或为空business_direction_id!」「已上线需求不可排期~」「产研需求必须关联项目」 |
| 31001 | 必要参数缺失或格式不正确 | `get_sprint_detail` 未带 `sprint_id` |
| 31101 | 无该页面权限 | 查他人缺陷详情 |
| 41001 | 服务端处理失败 | `moveReq` 目标迭代/需求不存在 |
| 41003 | 服务端内部异常（字段缺失/类型错误） | `updateSchedule` 传了 `estimatable` → `Unknown column 'estimatable'` |
| 44000 | 网关超时/服务不可用 | `project_list` 偶发 `ESOCKETTIMEDOUT`（重试即可） |

**登录态失效的识别**：ONES 的 SPA 对未知或未授权路径会返回 `200 + <!DOCTYPE html>` 前端外壳。脚本把「已知 API 路径返回 HTML」判定为登录态失效（`isOnesAuthFailure`），而不是路径写错。

---

## 二、只读能力（`ones_query.js`）

### 2.1 当前登录人

```bash
node scripts/ones_query.js me
node scripts/ones_query.js me --json
```

接口：`GET /api/uc/fetchUser`（画像）+ `GET /api/minepage/get_counts?quick_check=allaboutme`（待办计数）。

返回 `display_name / email_prefix / usercode / ucid / org_code / org_name / position_name / level_name / superior_name`。注意 **`fetchUser` 不含业务层级 ID**（business_direction_id 等），层级要用 `ptree` 系列接口按名称解析。

### 2.2 我的排期（按时间窗）

```bash
node scripts/ones_query.js schedule --from 2026-11-01 --to 2026-11-30
node scripts/ones_query.js schedule --with-bugs
```

接口：`GET /api/minepage/get_infos?quick_check=allaboutme&category=estimate`

每条估时（estimate）包含：`require_id / estimate_id / title / action（开发/联调/技术设计/测试/其他） / role_code / member / man_hour / start_time / end_time / finished / sprint_id / sprint_title / date_distribution`。

脚本会做三件事：
1. 自动调用 `GET /api/requirements/get_estimate_role` 拉取角色码字典（进程内缓存，失败时优雅降级），将底层 `role_code`（如 `ER0001` → `RD`、`ER0002` → `FE`、`ER0003` → `QA`、`ER0007` → `PM`）翻译为易读名称赋给 `role`，同时保留原始 `roleCode`；
2. 按 `--from/--to` 与 `start_time~end_time` 求交集过滤（服务端忽略 `start_date/end_date` 参数，必须本地过滤）；
3. 按 `require_id` 聚合成「这个时间窗里我要交付哪些需求、各多少总人天」。

**重要限制**：`quick_check=allaboutme` 只返回**当前登录人**的数据；服务端忽略 `email_prefix` / `member` 参数（实测传他人账号仍返回自己的 16 条）。所以「查某人的排期」不能直接做——脚本会在 `--person` 与当前登录人不一致时给出 `warning` 并说明替代路径：
- 用 `ones_query.js reqs --pm <账号>` 查此人作为 PM 的需求；
- 对单个需求用 `ones_query.js req <id>` 看全员估时明细（`get_estimate_and_schedule_detail` 会返回所有角色成员的估时）。

`category` 只能取 `all / bug / require / approval / onlinebug / trace / onlinecheck / estimate / workorder / cr / onlineplan / feedback`。

### 2.2b 个人工时概览（`manhour`）

```bash
node scripts/ones_query.js manhour
node scripts/ones_query.js manhour --from 2026-11-01 --to 2026-11-30 --all --json
```

对应 ONES 个人工时页（`https://ones.ke.com/profile/manhour`）背后的两个只读 BI 接口：
- `GET /api/bi/get_person_report_distribution?display_name=<姓名(账号)>&start_time=<YYYY-MM-DD>&end_time=<YYYY-MM-DD>`：返回窗口内每一天的 `day / week_day / is_workday / man_hour`；
- `GET /api/bi/get_person_report_summary`：返回同窗口的总人天、需求/缺陷/工单人天、PM/开发/其他占比、参与需求数与代码提交统计。

**逐日状态判定（基准 `MANHOUR_TARGET = 1` 人天）**：
- 法定节假日与周末调休完全以 ONES 返回的 `is_workday`（`1`=工作日，`0`=非工作日）为准，无需本地维护节假日表；
- **非工作日**：`man_hour > 0` 记为 `overtime`（🌙 加班），否则记为 `off`（· 假）；
- **未来工作日**（`date > today` 且 `man_hour <= 0`）：记为 `pending`（⏳ 待打），不计入漏打告警；
- **已过/今日工作日**：`= 1` 记为 `full`（✅ 已打满），`0 < h < 1` 记为 `short`（🟡 不足），`h > 1` 记为 `over`（🔴 超出），`h <= 0` 记为 `missing`（⛔ 未打）。
- 默认只展示截至今天的日期；加 `--all` 时连同未来日期一并返回（供 Web 控制台渲染完整月历/周历）。

### 2.3 需求详情

```bash
node scripts/ones_query.js req 50564297
node scripts/ones_query.js req 钥匙箱 --limit 5      # 标题关键词，命中多条时列候选
```

| 用途 | 接口 |
| :--- | :--- |
| 需求主体 | `GET /api/requirements/get_require_detail?require_id=` |
| 排期（阶段时间） | `GET /api/requirements/scheduleDetail?require_id=` |
| 估时 + 排期 + 汇总 | `GET /api/requirements/get_estimate_and_schedule_detail?require_id=` |
| 关联缺陷 | `POST /api/bug/get_bugs {require_ids:[id]}` |

`get_require_detail` 关键字段：

```
id/title/desc/status/require_status/status_name  priority  require_type/require_label
sprint_id/sprint_title  pm[]（对象数组）  rd_list/qa_list/fe_list（列表接口才有）
business_direction_id/name … sub_system_id/name   project_ids/project_titles
notest  safety_risk  safety_risk_functions  estimatable  is_support_estimate
transitions（当前状态机：{init, [当前状态]: {master: {ets: [{event,target,type}]}}}）
```

`get_require_detail` 的 `pm` 是 `["姓名(账号)"]` 字符串数组；而 `requirement_list` 的 `pm` 是 `[{value,name,text,displayName}]` 对象数组，脚本统一归一化成 `["姓名(账号)"]`。

**排期字段**（`scheduleDetail`）：`develop_start_time / develop_end_time / test_start_time / test_end_time / submit_test_time / online_time`，未设置时返回 `0`。

**关联缺陷必须用 `require_ids` 数组**：`{require_id: 50564297}` 返回 0 条，`{require_ids: [50564297]}` 才返回。

### 2.4 需求列表检索

```bash
node scripts/ones_query.js reqs --sprint IoT-2026-10-27
node scripts/ones_query.js reqs --pm sunzehao003
node scripts/ones_query.js reqs --level 惠居技术中心/惠居B端/惠居IoT/IoT系统 --sprint 10028902
node scripts/ones_query.js reqs --title 钥匙箱
```

接口：`POST /api/requirements/requirement_list`

| 参数 | 是否生效 | 说明 |
| :--- | :--- | :--- |
| `sprint_id` | ✅ | 唯一可靠的迭代过滤；`0` = 需求池 |
| `pm` | ✅ | 字符串或数组，账号 `sunzehao003` |
| `business_direction_id` / `business_line_id` / `system_id` / `sub_system_id` | ✅ | 层级过滤 |
| `title` | ✅ | 标题模糊匹配 |
| `page` / `limit` | ✅ | 分页 |
| `id` | ❌ | 被忽略，按 ID 查必须用 `get_require_detail` |
| `status` / `status_name` / `status_list` | ❌ | 全部被忽略 |
| `rd` / `rd_list` / `members` / `member` / `email_prefix` | ❌ | 被忽略（因此「某人参与的所有需求」无法直接从列表接口拿到） |

不传任何过滤条件时返回全库 44 万+ 条，**必须带过滤条件**。

### 2.5 缺陷检索

```bash
node scripts/ones_query.js bugs --summary 钥匙 --limit 5
node scripts/ones_query.js bugs --resolver 孙泽浩
node scripts/ones_query.js bugs --id 10413977
```

接口：`POST /api/bug/get_bugs`

生效参数：`id`（精确）、`resolver`、`sprint_id`、`require_ids[]`、`page`、`limit`。
注意：服务端会静默忽略 `summary` / `kw` 等模糊字段并固定每页返回 10 条；因此传 `--summary` 时，脚本会自动从最新往旧分页扫描（默认最多扫描 600 条）并在本地按标题关键词过滤。
缺陷状态是英文枚举：`open / reopen / processed / rejected / deferred / fixed / closed`；`category` 是中文枚举（见 `enums bug`）。

### 2.6 迭代（Sprint）与项目

```bash
node scripts/ones_query.js iterations IoT-2026-11 --limit 10
node scripts/ones_query.js iterations 10028902            # 传纯数字 = 迭代详情
node scripts/ones_query.js iterations --level 惠居技术中心/惠居B端/惠居IoT/IoT系统
node scripts/ones_query.js projects --kw 惠居
```

| 用途 | 接口 | 关键约束 |
| :--- | :--- | :--- |
| 迭代列表 | `GET /api/iterations/fetchIterations` | **必须 GET + query**；POST 会忽略 limit/keyword 并固定只返回前 1001 条 |
| 迭代关键词 | 同上 + `critical_key=` | 服务端支持，比本地过滤可靠 |
| 迭代详情 | `GET /api/requirements/get_sprint_detail?sprint_id=` | 参数名是 `sprint_id`，传 `id` 会报 30001 |
| 项目列表 | `POST /api/project/project_list` | 搜索要用 `kw` + `source=sug` + `from=req_create`；返回 `pageList`（不是 `datalist`），含 `m_project_id`（新建需求时必填的是这个） |
| 层级树 | `GET /api/ptree/get_business_directions` / `get_businesslines?business_direction_id=` / `get_systems?business_line_id=` / `get_subsystems?system_id=` | 逐级下钻 |

迭代列表第一项恒为 `{id: 0, title: "需求池"}`（非迭代内需求）。`fetchIterations` 的 `totalcount` 是全库总数（26804），带层级过滤时 `datalist` 才是真实范围。

### 2.7 枚举与人员

```bash
node scripts/ones_query.js enums requirement
node scripts/ones_query.js enums bug
node scripts/ones_query.js users 孙泽浩
```

`GET /api/enum/get_enum?category=requirement|bug`，返回各字段的 `[{key,value}]`。

需求枚举要点：`priority = P0/P1/P2`；`require_type = 产品需求/技术需求/埋点类需求/事务型需求/线上问题`；`require_label = 常规需求/紧急插入需求`；`notest = 不免测/一级免测/二级免测/三级免测`；`status = 方案中…已上线/已完成/已取消/已暂停`（16 个）。
缺陷枚举要点：`bug_type = showcase阶段/测试阶段/开发阶段/产品阶段/用户验收阶段（UAT)`；`find_way = 手工测试/性能测试/自动化测试/未标明/流量回放/混沌演练/Ai自动化测试/监控报警/CR/diff测试…`；`bug_category` 40+ 项（`功能逻辑`、`界面问题`、`性能问题`…）。

人员：`POST /api/uc/fetchUsers {kw}` 返回 `display_name / account / user_code / ucid / org_name / position_name`，`kw` 支持姓名、账号、工号的中文/拼音模糊匹配。脚本把结果统一成 ONES 的人员标识串 **`姓名(账号)`**，例如 `孙泽浩(sunzehao003)`。

---

## 三、写操作（`ones_modify.js`）

> 🚨 **两阶段铁律**：不带 `--confirm` 只输出预审单（现状 + Diff + 完整 payload），**绝不落库**；用户明确确认后，AI 才追加 `--confirm` 提交，并自动回查验证。

### 3.1 新建需求

```bash
# 阶段 1：预审
node scripts/ones_modify.js create-req \
  --title "【钥匙箱三期】扫码开门" \
  --level "惠居技术中心/惠居B端/惠居IoT/IoT系统" \
  --project "惠居IoT项目" \
  --pm 孙泽浩 \
  --sprint IoT-2026-11-24 \
  --with-safety-func --desc "…"

# 阶段 2：确认后提交
node scripts/ones_modify.js create-req ... --confirm
```

接口：`POST /api/requirements/save_requirement`，成功返回 `{code:10000, body: <新需求ID>}`。

**必填字段（服务端逐项校验，缺什么报什么）**：

| 字段 | 报错文案 | 说明 |
| :--- | :--- | :--- |
| `business_direction_id` | 必要参数缺失或为空business_direction_id! | 用 `--level` 解析 |
| `business_line_id` | …business_line_id! | 同上 |
| `pm` | …pm! | `["姓名(账号)"]` |
| `priority` | …priority! | P0/P1/P2 |
| `safety_risk` | …safety_risk! | `["无"]` 或具体风险项 |
| `m_project_id` | 推行贝壳项目管理规范，产研需求必须关联项目 | `--project`，取项目的 `m_project_id`（不是 `id`） |
| `safety_risk_functions` | （表单必填项） | 显式声明 `["不包含以上业务功能"]` 或具体功能清单 |

`require_type` / `require_label` / `notest` / `desc` / `followers` / `sprint_id` 可选但有默认值（脚本默认 `产品需求 / 常规需求 / 不免测`）。`system_id` / `sub_system_id` 不是强制项，但层级不全会导致需求在迭代视图里不好找，脚本按 `--level` 全量带上。

⚠️ **写入探针教训**：`saveBug` 几乎不校验枚举，用 `summary:'__probe__'` + 伪造 `category` 探字段会**真的建出缺陷**。所以本脚本所有「必填项校验」都在本地完成，**不发试探请求**。

### 3.2 新建缺陷

```bash
node scripts/ones_modify.js create-bug \
  --summary "OTA 升级后设备离线" --resolver 孙泽浩 \
  --require-id 50564297 --priority P0 --type 测试阶段 --find-way 手工测试 \
  [--category 功能逻辑] [--desc "复现步骤…"] \
  [--man-hour 0.2] [--start "2026-11-25 00:00:00"] [--end "2026-11-25 23:59:59"]
```

接口：`POST /api/bug/saveBug`，返回新缺陷 ID。

**服务端只强制 4 个字段**：`bug_type`、`find_way`、`priority`、`resolver`。但**枚举值不校验**（传 `BOGUS_CAT` 也能建成功），所以脚本在本地按枚举字典对 `--type` / `--find-way` / `--category` / `--priority` 做提示性校验，防止把脏数据写进平台。

`--require-id` 关联需求；关联前脚本会先读一次需求确认存在，避免挂到错误需求下。

### 3.2.1 缺陷的「排期」就是它的工时（`--man-hour`）

缺陷没有需求那种「开发/测试/提测/上线」阶段排期，它自己的 **`man_hour` + `start_time` + `end_time`** 就是排期。写入口是独立接口：

```bash
# 单条缺陷改工时（已有缺陷）
# 等价 body：{ id: <bugId>, man_hour: 0.2, start_time?: "...", end_time: "..." }
```

- 接口：`POST /api/bug/save_hour`，成功返回 `true`。
- **服务端强制 `man_hour` + `end_time`**，缺任一字段直接报 `30000 提测时 man_hour/end_time 必填`。
- `start_time` 可选，不传则沿用缺陷当前时间。
- `create-bug --man-hour 0.2` 会在缺陷**创建成功后**自动追加这次 `save_hour`；`--end` 缺省取当天 23:59:59。
- `/api/bug/` 下只有 `get_bugs` / `saveBug` / `save_hour` / `assign` / `changeStatus` 等有限接口，**没有** `updateBug` 这类通用更新接口（`/api/bug/updateBug` 返回 `37000` 路由不存在）。
- 新建缺陷时**不要**试图在 `saveBug` 里直接带 `man_hour`：工时是建完之后单独写的，两阶段顺序不能颠倒。

### 3.3 调整排期

```bash
node scripts/ones_modify.js schedule 50564297 \
  --develop-start 2026-12-01 --develop-end 2026-12-05 \
  --test-start 2026-12-08 --test-end 2026-12-12 \
  --submit-test "2026-12-06 23:59:59" --online "2026-12-20 23:59:59"
```

接口：`POST /api/requirements/updateSchedule`，body 形如：

```json
{ "require_id": 50564297, "develop_start_time": "2026-12-01 00:00:00", "online_time": "2026-12-20 23:59:59" }
```

**踩坑记录**：
- body 里**不能带 `estimatable`** → 报 `41003 Unknown column 'estimatable' in 'field list'`；
- 只传要改的字段即可，不传的字段保持不变（`{require_id}` 单独提交也返回 10000）；
- 业务校验：`上线时间不能早于开发时间`；`已上线需求不可排期~`（状态为已上线/已完成的需求无法改排期）；
- `updateReqSchedule` 是旧接口，已废弃（返回 SPA HTML）。

阶段时间之外还有 `interface_document_time / joint_adjustment_time / mock_time / case_review_time / showcase_time / uidoc_time / crowdsourced_time`，本脚本暂不暴露。

**人天估时**（`estimateCreate` / `estimateUpdate` / `estimateDelete`，字段为 `{require_id, estimate_id, role_name, member, man_hour, start_time, end_time, action}`）未纳入 CLI——估时与排期存在联动校验，建议在 ONES 页面调整。

### 3.4 移入迭代

```bash
node scripts/ones_modify.js move 50564297 --sprint IoT-2026-11-24
node scripts/ones_modify.js move 50564297,50566423 --sprint 10029024
```

接口：`POST /api/requirements/moveReq`，body `{sprint_id, require_ids: []}`（前端 redux 的 `moveReq` 就是这个形状）。
目标迭代或需求不存在时返回 `41001 切换迭代失败，请稍后再试~！`。移出迭代用 `removeRequirement {require_ids: []}`（未暴露）。

### 3.5 状态流转（含删除，高危）

```bash
node scripts/ones_modify.js advance 50565445 --event 评审
node scripts/ones_modify.js advance 50565445 --event 删除        # 高危
```

接口：`POST /api/fsm/change_status`，body `{type:'requirement'|'bug', id 或 ids, event, ext_param?}`。

可用事件由需求当前状态决定，从 `get_require_detail.transitions` 读取（如「待评审」状态下有：评审 / 需求取消 / 删除 / 暂停 / 排期）。脚本会在预审阶段就校验事件是否合法，并**把删除、需求取消标红为高危**。缺陷流转同理：`{type:'bug', id, event}`（缺陷事件：提测 / 分配 / 打回 / 延期处理 / 关闭…）。

清理自己误建的测试数据（本次实践验证过的路径）：

```bash
# 1) 先看缺陷状态与可用事件
node scripts/ones_modify.js advance <bugId> --event 删除      # 预审，会列出可用事件
# 2) 确认后删除
node scripts/ones_modify.js advance <bugId> --event 删除 --confirm
# 3) 回查（删除后 get_bugs 返回「缺陷 xxx 已被删除」）
```

⚠️ 脚本**不提供批量删除**：`--confirm` 每次只作用于一个对象，避免一次误操作清空一批数据。

---

## 四、安全边界

1. **线上生产环境只读**：ONES 本身就是生产系统（唯一环境），所有写操作都直接作用于真实研发数据。因此默认 `--confirm` 缺省 = 只看不写，AI 严禁「带 `--confirm` 一步到位」。
2. **只操作自己账号域内的数据**：不改他人创建的缺陷的状态、不给自己无权限的项目建需求。
3. **不做批量删除**：删除只能逐条、逐一确认。
4. **凭据不外泄**：输出里只有 Cookie 名与数量（凭据台账），不出现值。
5. **写前必查**：`create-bug` 先校验关联需求存在，`schedule` 先读现排期做 Diff，`move` 先读现迭代，`advance` 先校验事件合法。

---

## 五、AI 使用建议（意图 → 命令）

| 用户说 | AI 执行 |
| :--- | :--- |
| 我这个月的排期 / 这周要做什么 | `ones_query.js schedule --from … --to …` |
| 我这个月工时打满没 / 哪天漏打了工时 | `ones_query.js manhour [--from … --to …]` |
| 查下需求 50564297 / 钥匙箱那个需求什么状态 | `ones_query.js req <id\|关键词>` |
| IoT-2026-10-27 这个迭代有哪些需求 | `ones_query.js reqs --sprint IoT-2026-10-27` |
| 这个需求关联了哪些缺陷 | `ones_query.js req <id>`（末段自动带关联缺陷） |
| 帮我建个需求：… | 先 `create-req`（Dry-Run）→ 用户确认 → `--confirm` |
| 这个 bug 提个缺陷，挂在 xxx 需求下 | 先 `create-bug`（Dry-Run）→ 确认 → `--confirm` |
| 提个缺陷，排期 0.2 天 | 先 `create-bug --summary … --resolver … --man-hour 0.2`（Dry-Run）→ 确认 → `--confirm`（建完自动写工时） |
| 把 xxx 需求排到 12 月上线 | 先 `schedule <id> --online …`（Diff）→ 确认 → `--confirm` |
| 把需求挪到下个迭代 | 先 `move <id> --sprint …`（预审）→ 确认 → `--confirm` |
| 需求评审通过 / 标记完成 | 先 `advance <id> --event 评审`（预审）→ 确认 → `--confirm` |

配套注意：用户说「排期」时，先确认是**改阶段时间**（`schedule`）还是**换迭代**（`move`）——两者是不同接口、不同副作用。
