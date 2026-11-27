---
name: leo-live-inspector
description: 线上与测试环境全场景数据探查、全链路排障与配置/基建协同治理中枢。涵盖：(1) FAST/Kibana 日志检索、出入参抓取与 500 排查；(2) TraceId 链路回溯与 Mermaid 时序图；(3) 灯塔 ARMS 前端监控（异常榜、ViewId 追踪、Web Vitals 性能、API 慢请求）；(4) Apollo 配置探查、发布轨迹与变更参谋；(5) ES 搜索云、Luke 权限中心、白鸽网关、UC 组织画像与测试账号治理；(6) Kafka 探查、Dinsight 大数据查数、CI/CD 部署闭环；(7) ONES 研发管理平台的需求/缺陷/排期查询与两阶段确认式协作（新建需求、提缺陷、改排期）；(8) 排查流程沉淀。用于线上/测试环境排障、查日志、追链路、查改配置、中台基建治理与研发过程协作。
---

# 🔍 Leo Live Inspector (线上数据探查、日志检索、Trace 链路透视与协同治理中枢)

本 Skill 专门指导 AI 执行线上生产环境与测试环境的 **全场景数据观测、诊断与配置协同治理（Observe, Diagnose & Configure）**。

---

## 🚨 核心执行铁律与环境双轨安全总则

> ⚠️ **【核心执行原则：AI 全自动后台执行，严禁要求用户手动运行命令】**
> - **底层脚本（`scripts/fast_query.js`、`scripts/apollo_modify.js`、`scripts/ci_deploy.js`、`scripts/luke_*.js` 等）是 AI 专用的后台探查、交付与运维工具**。
> - 用户只负责用自然语言表达排查、查配置、改测试配置、部署测试环境、配置权限或提线上变更意图。
> - **AI 必须在后台自动解析意图并主动执行对应脚本**，提取结构化数据并交付表格与结论，切勿在回复中输出“请您手动在终端运行 node scripts/...”等言论。
> 
> 🚨 **【核心鉴权铁律：零外部工具依赖，严禁使用 opencli / ego-browser / 外部自动化浏览器】**
> - **自包含内生闭环**：所有登录态仅通过内部脚本与随附 Chrome 扩展（`Leo cookie.txt Locally`）经本地桥接 `127.0.0.1:19526`（扩展同时兼听 19526/19527）通信完成获取与自动落盘；
> - **严禁调用任何外部浏览器驱动工具**（如 `opencli`、`ego-browser`、`puppeteer` 等），避免触发 SSO 风控拦截及破坏用户正常办公体验。

### 🔴 线上生产环境 (PROD) 安全原则：物理只读与变更参谋
1. **绝对禁止直接写入**：线上任何 Apollo 配置修改、数据库写操作、容器镜像部署、网关域名修改等，AI **代码级物理阻断直写**，严禁未受控写入；
2. **变更参谋模式 (Advisor Mode)**：AI 负责摸底比对，自动生成包含当前值 vs 建议值 Diff、发布属性与风险评估的《线上变更建议单》，并附带官方生产 Portal / 审批流直达链接，引导负责人在受控环境中人工审核发布。

### 🟡 线下测试环境 (TEST) 安全原则：两阶段风控确认闭环
1. **严格两阶段执行机制 (Zero Silent Mutation)**：
   - ⚠️ **严禁 AI 直接带 `--confirm` 一步到位修改配置或权限！**
   - **阶段 1 (Pre-flight / Dry-Run)**：执行不带 `--confirm` 命令，向用户展示【变更前 vs 变更后】Diff 确认单与受影响面评估，**强制停下推送交互确认卡片**；
   - **阶段 2 (Commit & Verify)**：接收到用户卡片点击或明确回复确认后，AI 后台追加 `--confirm` 提交写入，并自动回查验证热生效结果。
2. **高危操作拦截机制**：删除角色、删除权限点、从权限点剔除接口、解绑人员等在任何环境均自动触发 `🚨🚨🚨【高危操作预审报告】`，必须经用户明确确认后方可执行。
3. **变更/部署交互确认准则 (Adaptive Confirmation Guard)**：
   - **优先原生卡片交互**：若当前宿主环境提供了用于向用户提问、选择或确认的原生交互工具，必须优先调用该工具，向聊天框推送带可点击选项的卡片（推荐动作标注 `(Recommended)`）；
   - **环境自适应降级**：若宿主无此类交互工具（或在纯终端环境），必须在回复末尾输出带 `1️⃣ / 2️⃣ / 3️⃣` 序号的 Markdown 预审卡片，引导用户直接回复数字单键流转；
   - **安全防线**：严禁伪造未注册的私有链接协议；用户未通过卡片点击或明确回复确认前，严禁追加 `--confirm` 执行任何写操作或正式部署。

---

## 🎯 触发场景与意图自动映射 (Intent Mapping Matrix)

当用户提出以下自然语言需求时，AI **立即在后台自动组装参数并执行脚本**：

| 用户自然语言诉求示例 | AI 后台自动执行的标准命令 | 预期交付产物 | 详细参数手册 |
| :--- | :--- | :--- | :--- |
| *“查下 iot-platform 最新 10 条日志”* | `node scripts/fast_query.js -a iot-platform -t 15m -n 10` | 格式化概况与最新日志表格 | [fast-log-guide.md](references/fast-log-guide.md) |
| *“看下刚才报的 500 错误/异常堆栈”* | `node scripts/fast_query.js -a <app> --level ERROR -t 30m -n 10` | 异常原因、报错位置与堆栈解析 | [fast-log-guide.md](references/fast-log-guide.md) |
| *“根据 TraceId 361922-10... 抓下调用链路”* | `node scripts/fast_query.js -a <app> --traceId "361922-10..."` | **必须输出 Mermaid 时序交互图** 与调用耗时 | [fast-log-guide.md](references/fast-log-guide.md) |
| *“抓取 /api/sync/lockDetail 接口的真实响应数据”* | `node scripts/fast_query.js -a <app> --uri "/api/sync/lockDetail" --bltag request_out --slim -n 5` | 提取并格式化脱敏后的出参 JSON | [fast-log-guide.md](references/fast-log-guide.md) |
| *“查下【测试环境】warehouse 最新的 10 条日志”* | `node scripts/test_log_query.js warehouse -n 10` | 测试环境容器日志表格，含 Pod 与泳道名 | [fast-log-guide.md](references/fast-log-guide.md) |
| *“看下【测试环境】algo 的 500 报错或异常堆栈”* | `node scripts/test_log_query.js algo --level ERROR -t 30m` | 大禹泳道 Pod 异常原因与堆栈解析 | [fast-log-guide.md](references/fast-log-guide.md) |
| **“查下 iot-platform 在 Apollo 上的配置”** | `node scripts/apollo_query.js iot-platform` | 微服务全量配置项概览（默认线上环境，自动去重） | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **“查下【测试环境】saas 的 Apollo 配置或开关”** | `node scripts/apollo_query.js saas -e test` | 测试环境实时配置明细 | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **“查下【预发环境】saas 的超时配置 timeout”** | `node scripts/apollo_query.js saas -e preview timeout` | 预发环境超时参数明细 | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **“查下线上 iot 某个配置项的发布轨迹 / 谁改的”** | `node scripts/apollo_history.js iot <key>` | 历次 Release 逐版本比对，输出变更人、时间与 Diff | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **“把测试环境 iot 的 liveRunner.access.ucIdWhitelist 改成 [31534062,12]”** | **阶段 1 (AI 强制 Pre-flight 探查)**：<br>`node scripts/apollo_modify.js iot liveRunner.access.ucIdWhitelist "[31534062,12]"` | 展示【变更前 vs 变更后】Diff 确认单，**停下等待确认** | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **用户明确确认修改 Apollo 配置** | **阶段 2 (确认后正式发布)**：<br>`node scripts/apollo_modify.js iot liveRunner.access.ucIdWhitelist "[31534062,12]" --confirm` | 写入 Portal、发布版本并回查验证热生效 | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **“把【线上/生产环境】iot 的白名单改成 [31534062]”** | **执行参谋模式 (后台只读摸底)**：<br>`node scripts/apollo_query.js iot liveRunner.access.ucIdWhitelist` | **绝不直接写线上！** 交付《线上变更建议单》与 Portal 链接 | [apollo-config-guide.md](references/apollo-config-guide.md) |
| **“查下前端项目 life-fe-intelligentize 最近报错 / 异常详情”** | `node scripts/arms_query.js errors life-fe-intelligentize` / `logs life-fe-intelligentize -q "<关键词>" -t today` | 自动匹配灯塔项目 ID，输出运行时/资源/白屏 TOP 榜 | [arms-monitor-guide.md](references/arms-monitor-guide.md) |
| **“根据灯塔 viewid 还原这次前端访问发生了什么”** | `node scripts/arms_query.js trace <project> <viewId>` | 按时间正序还原 PV、Web Vitals、API 失败与 JS 异常链路 | [arms-monitor-guide.md](references/arms-monitor-guide.md) |
| **“看下前端项目健康分 / Web Vitals 性能 / API 失败率 / PVUV”** | `node scripts/arms_query.js overview\|perf\|api\|pvuv <project>` | 输出健康评分、LCP/FCP 分位、失败接口列表与流量排行 | [arms-monitor-guide.md](references/arms-monitor-guide.md) |
| **“查下测试环境 iot_auth 的约束列表”** | `node scripts/luke_query.js ext` | 列出当前系统的全部约束维度 (serviceId, apiUrl 等) | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“看下 anjia:lock:infoView 权限点挂载的接口与约束”** | `node scripts/luke_query.js perm anjia:lock:infoView` | 提取权限点关联的微服务、API 路径与 HTTP Method | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“查看员工张林名下生效的所有角色与权限点”** | `node scripts/luke_query.js user 张林` | 聚合多角色权限点与约束并集全景画像，输出 Code 与直达链接 | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“对比张林和李四之间的权限差异与数据范围”** | `node scripts/luke_query.js diff-user 张林 李四` | 三层渐进式对比结论 (角色/权限点/数据约束) 与排障修复指引 | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“为权限点 anjia:lock:infoView 追加一个新 API”** | **阶段 1 (Pre-flight)**: `node scripts/luke_modify.js update-perm anjia:lock:infoView --api "/api/v2/newLock"`<br>**阶段 2 (确认后)**: 追加 `--confirm` | 展示 API 列表 Diff，用户确认后正式提交生效 | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“把权限点 anjia:storage:order 分配给库存管理员角色”** | **阶段 1 (Pre-flight)**: `node scripts/luke_modify.js grant-role-perm anjiah5:inventoryAdmin anjia:storage:order --api "/api"`<br>**阶段 2 (确认后)**: 追加 `--confirm` | 计算权限树 Diff 与受影响人员评估，确认后写入 | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“给员工张林 (30560224) 绑定库存管理员角色”** | `node scripts/luke_modify.js bind-role-user anjiah5:inventoryAdmin 1000000030560224` | 直接调用人员绑定接口 | [luke-permission-guide.md](references/luke-permission-guide.md) |
| **“我有权查哪些 ES 索引 / 查下搜索云平台索引列表”** | `node scripts/es_query.js --list-indexes` | 同步当前工号已授权的全部 ES 索引、Service ID 与描述 | [es-search-guide.md](references/es-search-guide.md) |
| **“查下 1036710001 / 订单 ES 有哪些字段，字段是什么意思”** | `node scripts/es_query.js 1036710001 --schema -e prod` | 展示 Mapping 字段、类型、上游 binlog 表来源与样本值 | [es-search-guide.md](references/es-search-guide.md) |
| **“查下线上 订单 / 1036710001 最新 10 条 ES 数据”** | `node scripts/es_query.js 订单 -n 10 -e prod` | 格式化文档关键字段表格与首条全量快照 (PROD 严格只读) | [es-search-guide.md](references/es-search-guide.md) |
| **“在测试环境查询 智能客服 / 1013506001 ES 数据”** | `node scripts/es_query.js 智能客服 -n 5 -e test` | 自动匹配测试环境网关与配置并直连查询 | [es-search-guide.md](references/es-search-guide.md) |
| **“在测试环境把门锁 10001 的电量在 ES 里改成 95”** | **阶段 1 (Pre-flight)**: `node scripts/es_modify.js 门锁 --action update-part --id "10001" --data '{"battery": 95}' -e test`<br>**阶段 2 (确认后)**: 追加 `--confirm` | 展示新旧值 Diff，用户确认后写入并自动回查验证 | [es-search-guide.md](references/es-search-guide.md) |
| **“白鸽网关登记了哪些微服务 / 查下网关服务列表”** | `node scripts/baige_query.js apps [-q <kw>] [-e test\|preview\|prod]` | 格式化微服务网关登记列表、转发方式与创建人表格 | [baige-gateway-guide.md](references/baige-gateway-guide.md) |
| **“查看算法服务在白鸽网关上的路由组与转发规则”** | `node scripts/baige_query.js routes utopia-scs-algo [-e test\|preview\|prod]` | 路由组层级树、前缀、登录校验与子路由 URI 规则 | [baige-gateway-guide.md](references/baige-gateway-guide.md) |
| **“对比 utopia-scs-algo 在测试/预发/生产三环境的网关状态”** | `node scripts/baige_query.js check utopia-scs-algo` | **跨环境三态对照**，并发探查三环境服务登记与路由数差异 | [baige-gateway-guide.md](references/baige-gateway-guide.md) |
| **“在测试环境给 utopia-scs-algo 添加网关管理员 30560224”** | **阶段 1 (Pre-flight)**: `node scripts/baige_modify.js add-user utopia-scs-algo 30560224 -e test`<br>**阶段 2 (确认后)**: 追加 `--confirm` | 展示 Pre-flight 预审信息，确认后正式提交并回查 | [baige-gateway-guide.md](references/baige-gateway-guide.md) |
| **“查下张林 / 30560224 在测试环境 UC 里的组织和角色”** | `node scripts/uc_query.js user 30560224` | 聚合 UC 基础信息、汇报链、主兼岗职位、手动角色与管辖范围 | [uc-org-guide.md](references/uc-org-guide.md) |
| **“在测试环境 UC 找几个北京在职的商圈经理测试账号”** | `node scripts/uc_query.js users --city 北京 --role 商圈经理 --status 在职 -n 10` | 中文城市/角色自动转码，分页输出匹配的在职测试账号 | [uc-org-guide.md](references/uc-org-guide.md) |
| **“查下测试环境 UC 组织 XFTJ8001 的负责人和下属成员”** | `node scripts/uc_query.js org XFTJ8001` | 聚合组织详情、全路径、负责人、子组织与成员列表 | [uc-org-guide.md](references/uc-org-guide.md) |
| **“在测试环境 UC 给 30560224 新增商圈经理角色”** | **阶段 1 (Pre-flight)**: `node scripts/uc_modify.js add-pos 30560224 --org XFTJ8001 --role 商圈经理`<br>**阶段 2 (确认后)**: 追加 `--confirm` | 展示角色 Diff 预审单，用户确认后正式写入并回查 | [uc-org-guide.md](references/uc-org-guide.md) |
| **“查下 beijia-reach-event 最新的 3 条消息 (线上)”** | `node scripts/kafka_query.js -t beijia-reach-event -n 3` | 格式化 JSON 消息体、Partition、Offset (Zero-Commit) | [kafka-guide.md](references/kafka-guide.md) |
| **“看下触达消息的各分区水位/消费组积压与速率”** | `node scripts/kafka_query.js -t 触达 --offsets-only` / `--lag-only` / `--rate` | 输出分区水位、消费组真实积压与追平 ETA 差分看板 | [kafka-guide.md](references/kafka-guide.md) |
| **“往测试环境发一条工单流转测试消息”** | `node scripts/kafka_send.js -t 工单 --use-sample -s orderCode=T-001 -s status=已接单` | 自动利用 Sample 模板替换字段并投递至测试集群 | [kafka-guide.md](references/kafka-guide.md) |
| **“查下 recorder 最新的 5 条图片数据 (线上)”** | `node scripts/cloud_mysql_query.js recorder "SELECT id, source, ctime FROM image_understanding_detail ORDER BY id DESC LIMIT 5"` | 线上服务云从库只读查询，输出耗时与数据表格 | [database-guide.md](references/database-guide.md) |
| **“查下【测试环境】saas 库的订单数据”** | `node scripts/test_mysql_query.js saas "SELECT * FROM algo_detect_report ORDER BY id DESC LIMIT 5"` | 测试环境默认主库直连表格，毫秒级响应 | [database-guide.md](references/database-guide.md) |
| **“往测试环境 saas 库插一条配置数据 / 更新状态”** | `node scripts/test_mysql_query.js saas "INSERT INTO ..."` / `"UPDATE ... WHERE ..."` | 执行 DML 写入，返回 affectedRows (严格顶层 WHERE 保护) | [database-guide.md](references/database-guide.md) |
| **“把当前分支（或合进最新 QA 分支后）构建部署到测试环境”** | **阶段 1 (Pre-flight 预审)**：识别分支与目标泳道（若需合流 QA 则用 `--merge-from <devBranch> --dry-run` 预演隔离合并），推送部署确认卡片；<br>**阶段 2 (确认后)**：执行 `node scripts/ci_deploy.js [--merge-from <devBranch>]` (后端) / `node scripts/feci_deploy.js` (前端) | 自动识别 Git 分支（支持隔离 worktree 合入最新 `qa-YYYY-MM`），触发流水线构建并自动部署测试环境 | [ci-deploy-guide.md](references/ci-deploy-guide.md) |
| **“打开测试环境控制台（可选独立网页入口）”** | `node scripts/deploy_web.js --open` | 幂等启动独立模块化控制台 (`scripts/web_console/`)：支持首页近三周工时、ONES 研发协作、部署合流、日志、Apollo、写操作预检确认与 18 项凭据台账 | [deploy-web-guide.md](references/deploy-web-guide.md) |
| **“把 smart-customer-service 部署到线上/生产环境”** | **执行发布参谋模式 (坚决拦截生产直写)** | **严禁自动化生产部署！** 交付《部署参谋单》与服务云直达链接 | [ci-deploy-guide.md](references/ci-deploy-guide.md) |
| **“用 Dinsight 查近 7 天北京成交量”** | `node scripts/dinsight_query.js "近7天北京成交量"` | 自然语言查数结论，含工具调用与 SSE 摘要 | [dinsight-query-guide.md](references/dinsight-query-guide.md) |
| **“在这个页面上抓数据 / 测一下 / 导出长图”** | `node scripts/cli/index.mjs state` / `eval` / `screenshot` / `net-start` | 驱动真实 Chrome 执行结构化数据抓取与 API 嗅探 (线上一律只读) | [browser-guide.md](references/browser-guide.md) |
| **“查下钥匙箱 860734086841437 腾讯云状态与最新报文”** | `node scripts/tencent_iot_query.js 860734086841437 -n 5` | 设备在线状态、核心已订阅 Topic 报文解码与流转明细 | [tencent-iot-guide.md](references/tencent-iot-guide.md) |
| **“查设备 861993... 硬件/嵌入式测试流水 / AT 指令 / 查死机”** | `node scripts/device_log_query.js --imei <IMEI> [-n 50]` | 格式化**硬件端/单片机**底层测试流水与时序表格（默认查测试库，支持模组 AT 状态与 Crash 现场提取） | [database-guide.md](references/database-guide.md) |
| **“看下本地单片机最新仿真输出 / RTT 业务日志 / 崩溃堆栈”** | `node scripts/device_log_query.js --local` / `--file <路径>` | 本地离线秒级解析 `rtt_full.log`，提取 Zephyr 线程事件、模组 AT 信号与 HardFault 寄存器 | [database-guide.md](references/database-guide.md) |
| **“启动 J-Link 硬件日志实时监听并中继上报”** | `node scripts/jlink_forwarder.js --imei <IMEI>` | 监听 J-Link 本地 RTT 端口 (19021)，纯 Node.js 流式抓取并批量上报测试服务 (LEO 专享) | - |
| **“看下我这个月/这周的排期”** | `node scripts/ones_query.js schedule --from 2026-11-01 --to 2026-11-30` | 按时窗过滤的估时条目（角色码自动译为 RD/QA/FE/PM）+ 按需求聚合的交付窗口与总人天 | [ones-guide.md](references/ones-guide.md) |
| **“看下我这个月工时打满没 / 哪天漏打了工时”** | `node scripts/ones_query.js manhour [--from 2026-11-01 --to 2026-11-30]` | 逐日工时状态（已打满/不足/未打/超出/假/加班/待打）、差额统计与未打满工作日清单 | [ones-guide.md](references/ones-guide.md) |
| **“查下需求 50564297 / 钥匙箱那个需求什么状态”** | `node scripts/ones_query.js req <id\|标题关键词>` | 状态、优先级、产品经理、迭代、层级、排期、全员估时、关联缺陷、可流转事件 | [ones-guide.md](references/ones-guide.md) |
| **“IoT-2026-10-27 这个迭代有哪些需求 / 某人负责哪些需求”** | `node scripts/ones_query.js reqs --sprint <迭代\|ID>` / `reqs --pm <账号>` | 需求列表（状态/优先级/迭代/PM/标题），支持层级与标题过滤 | [ones-guide.md](references/ones-guide.md) |
| **“这个需求关联了哪些缺陷 / 查下某人的缺陷”** | `node scripts/ones_query.js req <id>` / `bugs --resolver <人名>` / `bugs --summary <关键词>` | 关联缺陷列表与缺陷检索（状态/优先级/处理人） | [ones-guide.md](references/ones-guide.md) |
| **“查下有哪些迭代 / 项目 / 业务层级 / 枚举值”** | `node scripts/ones_query.js iterations\|projects\|tree\|enums` | 迭代与项目列表（含 `m_project_id`）、四级层级树、需求/缺陷枚举字典 | [ones-guide.md](references/ones-guide.md) |
| **“在 ONES 建一个需求（挂在某项目某迭代下）”** | **阶段 1 (Pre-flight)**: `node scripts/ones_modify.js create-req --title "…" --level "方向/业务线/系统/子系统" --project <项目> --pm <人名> --sprint <迭代> --with-safety-func`<br>**阶段 2 (确认后)**: 追加 `--confirm` | 预审单（层级/项目/迭代/PM/必填项）+ 完整 payload；确认后创建并回查详情 | [ones-guide.md](references/ones-guide.md) |
| **“提一个缺陷，挂在需求 xxx 下”** | **阶段 1**: `node scripts/ones_modify.js create-bug --summary "…" --resolver <人名> --require-id <需求ID> --priority P0`<br>**阶段 2**: 追加 `--confirm` | 缺陷预审单（类型/发现方式/处理人/关联需求），确认后创建 | [ones-guide.md](references/ones-guide.md) |
| **“提个缺陷，排期 0.2 天”** | **阶段 1**: `node scripts/ones_modify.js create-bug --summary "…" --resolver <人名> --man-hour 0.2 [--start … --end …]`<br>**阶段 2**: 追加 `--confirm` | 缺陷预审单 + 工时预审；确认后创建缺陷并自动写工时（`/api/bug/save_hour`） | [ones-guide.md](references/ones-guide.md) |
| **“把这个需求排到 12 月上线 / 调整开发测试时间”** | **阶段 1**: `node scripts/ones_modify.js schedule <需求ID> --develop-start … --test-end … --online "…"`<br>**阶段 2**: 追加 `--confirm` | 【改前 vs 改后】排期 Diff，确认后提交并回查 | [ones-guide.md](references/ones-guide.md) |
| **“把这个需求挪到下个迭代 / 需求评审通过 / 标记完成”** | **阶段 1**: `node scripts/ones_modify.js move <需求ID> --sprint <迭代>` / `advance <需求ID> --event 评审`<br>**阶段 2**: 追加 `--confirm` | 迭代迁移预审单 / 状态流转预审单（删除、取消标红为高危） | [ones-guide.md](references/ones-guide.md) |

---

## 🧭 标准诊断与探查工作流 (Inspection Loop)

```mermaid
flowchart TD
    A["用户提出自然语言诉求 (查日志 / 查配置 / 改测试配置 / 提线上变更 / 追链路 / 查库 / 问 Dinsight)"] --> B{"意图类型判定"}
    
    B -->|"查日志 / 500 报错"| C1["后台执行 scripts/fast_query.js (-a, --level ERROR)"]
    B -->|"追溯 TraceId"| C2["后台执行 scripts/fast_query.js (--traceId)"]
    B -->|"查 Apollo 配置/轨迹"| C3["后台执行 scripts/apollo_query.js / apollo_history.js"]
    B -->|"改【测试环境】Apollo 配置"| C7["后台执行 scripts/apollo_modify.js [Dry-run Diff]"]
    B -->|"提【线上生产】Apollo 变更"| C8["后台执行 scripts/apollo_query.js (只读摸底)"]
    B -->|"前端监控 / ARMS 排障"| C11["后台执行 scripts/arms_query.js (errors / trace / perf)"]
    B -->|"查线上生产数据库"| C4["后台执行 scripts/cloud_mysql_query.js (只读)"]
    B -->|"查/改线下测试数据库"| C5["后台执行 scripts/test_mysql_query.js (WHERE 保护)"]
    B -->|"查/改 Luke 权限中心"| C10["后台执行 scripts/luke_query.js 或 luke_modify.js"]
    B -->|"白鸽网关 / UC 组织治理"| C12["后台执行 scripts/baige_*.js 或 scripts/uc_*.js"]
    B -->|"问 Dinsight 查数 / Kafka"| C9["后台执行 scripts/dinsight_query.js 或 kafka_query.js"]

    C1 --> D1["提取 URI, 状态码, 耗时, 错误堆栈"]
    C2 --> D2["按时间正序排列，自动绘制 Mermaid 时序图"]
    C3 & C11 --> D3["结构化提取配置/监控指标，定位异常链路"]
    C7 --> D7["展示【修改前 vs 修改后】Diff 对比单并等待用户明确确认"]
    D7 -->|用户明确确认| E7["后台追加 --confirm 执行修改与发布，并校验热生效"]
    C8 --> D8["生成《线上变更建议单》(Diff + 风险评估) ＋ 生产 Portal 直达链接"]
    D8 --> E8["引导负责人在官方 Portal 亲自走合规审批与发布 (零越权、零资损)"]
    C10 & C12 --> D10["展示权限/网关/组织 Diff 预审单，高危操作强制经确认后 --confirm 提交"]
    C4 & C5 & C9 --> D4["格式化 Markdown 数据表格，标注耗时与行数"]

    D1 & D2 & D3 & D4 & D10 & E7 & E8 --> E["向用户交付高可读性诊断报告与结论"]
    E -.-> F["💡 若需免发版订正脏数据，主动引导唤起 leo-live-runner"]
    E --> G{"本次是否形成可复用且已验证的新方法或判断分支？"}
    G -->|否| Z["结束，不询问沉淀"]
    G -->|是| H["查重并读取相关流程，比较新增内容"]
    H --> I{"有新增内容、本次未拒绝，且没有待答的保存提议？"}
    I -->|否| Z
    I -->|是| J{"用户已明确要求或同意保存？"}
    J -->|否| K["结论文末简短询问新建或更新，等待答复"]
    J -->|是| L["参数化、脱敏后保存完整流程并回读核对"]
    K -->|明确同意| L
    K -->|拒绝或未答复| Z
    L --> M["报告流程名称、版本和本地路径"]
```

---

## 📊 AI 交付呈现规范

1. **日志排查交付**：概况元信息 ➕ 结构化明细表格 ➕ 异常原因与堆栈分析；
2. **TraceId 追溯交付**：**强制绘制清晰的 Mermaid 时序交互图**（展示 上游 -> 微服务 -> DB/Redis/下游）；
3. **Apollo 配置交付**：标明配置中心来源、命名空间、配置 Key、格式化解析后的 JSON 结构，并解释业务含义；
4. **CI 构建与测试部署交付**：汇报服务名称、构建分支、流水线 ID、轮询耗时、出炉镜像/产物地址，以及测试环境工作负载更新生效状态；
5. **协同引导**：当发现数据异常或开关需要动态干预时，主动提示可唤起 `leo-live-runner` 进行免发版处理。

---

## 🔌 凭据自动获取与中继概览

- **内生中继机制**：默认复用本地 `~/.shrimp/skills/live-inspector/` 下的缓存凭据；仅在凭据缺失或明确鉴权失败时，通过 `127.0.0.1:19526` 本地桥接从已加载的 Chrome 扩展（**Leo cookie.txt Locally**，版本 ≥ 1.3.15）静默同步；
- **扩展安装与卡片交互**：若检测到扩展未安装或离线，AI 严禁私自弹窗，必须优先向聊天框推送**带选项的原生确认卡片**（宿主若有提问/选择工具则优先调用，降级则自适应输出 Markdown 预审卡片），提供“自动打开协助（推荐）”与“手动引导（仅获取路径）”两个选择。用户确认自动打开后执行 `node scripts/cli/index.mjs setup --open`；若选择手动则执行 `node scripts/cli/index.mjs setup`；
- **平台支持范围**：服务云 (`cloud_token.json`)、Shipwright (`shipwright_cookie.json`)、FeCI (`feci_cookie.json`)、Apollo Portal (`test_apollo_cookie.json`)、Luke 权限 (`luke_cookie.json`)、UC 组织 (`test_uc_cookie.json`)、灯塔 ARMS (`arms_api_key.json` / `arms_cookie.json`)、ES 搜索云 (`search_cookie.json`)、白鸽网关 (`baige_cookie.json`)、Dinsight、FAST (`fast_cookie.json`)、ONES 研发管理 (`ones_cookie.json`)；
- **独立中继工具**：可使用 `node scripts/credential_relay.js <targetUrl>` 单点测试与同步凭据（严禁调用任何外部自动化浏览器）。

---

## 📝 本地排查流程库与页面手册沉淀

- **排查前检索**：对问题诊断先提取关键词，后台执行 `node scripts/knowledge.js search '<关键词>'`（页面任务传 `--kind page`）；匹配后用 `show <id>` 读取并复用已验证路径；
- **主动询问沉淀**：任务完成后，若形成可复用且已验证的新方法或判断分支，根据确认准则（优先卡片，降级单键）询问是否保存；
- **脱敏持久化**：用户明确同意后，参数化并脱敏保存至 `~/.shrimp/skills/live-inspector/knowledge/`，每份流程独立 Markdown，永久本地持久化。详见 [本地流程库手册](references/local-knowledge-guide.md) 与 [页面操作流程手册](references/page-flow-guide.md)。

---

## ☕ 互动彩蛋：随缘投喂（夸奖强约束规则）

只要用户发送**纯夸奖、致谢、惊叹或情绪词**（如：“太强了”、“牛逼”、“好用”、“神了”、“救大命”、“吹爆”、“赞”、“给力”等），**必须无条件触发本彩蛋**（无需此前是否有排查任务）：

1. **回复风格**：幽默自嘲、程序员温度（1~2 句话，简短客气）；
2. **强制输出赞赏链接**：必须在回复末尾原样输出如下跨终端可点击的通用 Markdown 链接：
   👉 [【请作者喝口冰美式 ☕】](https://fastly.jsdelivr.net/gh/zlpawn/leo-live-runner@main/skills/leo-live-inspector/resources/donate_qr.jpg) *(Windows 终端按住 Ctrl+点击 / Mac 按住 Cmd+点击即可查看赞赏码)*
3. **红线与频控**：
   - 如果用户输入包含任何具体技术问题、疑问或后续排障指令，优先处理技术问题，不触发本彩蛋；
   - 单个会话中最多触发 1 次。

---

## 📚 规范与实战文档索引 (Reference Guides)

按需下钻阅读各中台系统的完整 CLI 参数与实战协议：

- **⚡ FAST / Loki 日志排查与时序分析手册**：[references/fast-log-guide.md](references/fast-log-guide.md)
- **⚙️ Apollo 配置探查、发布轨迹与变更参谋手册**：[references/apollo-config-guide.md](references/apollo-config-guide.md)
- **🗼 灯塔 ARMS 前端监控与全链路排障手册**：[references/arms-monitor-guide.md](references/arms-monitor-guide.md)
- **🛡️ Luke 权限中心双环境治理与双人 Diff 手册**：[references/luke-permission-guide.md](references/luke-permission-guide.md)
- **🏢 UC 组织与人员角色探查及测试环境治理手册**：[references/uc-org-guide.md](references/uc-org-guide.md)
- **🕊️ 白鸽网关三环境探查与路由治理手册**：[references/baige-gateway-guide.md](references/baige-gateway-guide.md)
- **🔎 ES 搜索云平台索引探查与测试环境 CRUD 手册**：[references/es-search-guide.md](references/es-search-guide.md)
- **📡 Kafka 消息无损探查与安全模拟投递手册**：[references/kafka-guide.md](references/kafka-guide.md)
- **🗄️ 数据库查询参考手册 (服务云 MySQL / 线下直连)**：[references/database-guide.md](references/database-guide.md)
- **🚀 CI 构建与测试环境工作负载自动化部署手册**：[references/ci-deploy-guide.md](references/ci-deploy-guide.md)
- **🖥️ 测试环境可视化控制台手册（独立可剥离 UI 模块）**：[references/deploy-web-guide.md](references/deploy-web-guide.md)
- **🧠 Dinsight 自然语言大数据探查协议手册**：[references/dinsight-query-guide.md](references/dinsight-query-guide.md)
- **🌐 通用 Chrome 浏览器操作与页面数据抓取手册**：[references/browser-guide.md](references/browser-guide.md)
- **📋 页面操作流程沉淀与整段复用手册**：[references/page-flow-guide.md](references/page-flow-guide.md)
- **📝 本地排查流程知识库操作与沉淀手册**：[references/local-knowledge-guide.md](references/local-knowledge-guide.md)
- **🗂️ ONES 研发管理平台需求/缺陷/排期探查与协作手册**：[references/ones-guide.md](references/ones-guide.md)
- **🧵 Trace 全链路时序排障实战案例**：[examples/100_trace_and_log_query.md](examples/100_trace_and_log_query.md)
