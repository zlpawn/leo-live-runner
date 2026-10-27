# 业务流程场景索引

每个场景一份独立文档，互不干扰。

| 场景 | 文档 | 一句话说明 |
|---|---|---|
| Task 1 | [task1-auto-install.md](task1-auto-install.md) | 全自动下单 → 租务管家通知（Link Push / 短信） |
| Task 2 | [task2-sign-install.md](task2-sign-install.md) | 出房签约 → 在途安装单提醒（Link Push / 短信） |
| Task 3 | [task3-dispatch.md](task3-dispatch.md) | 社区服务单 → 派单通知（服务者 Push / 短信 / 自研维修强制短信） |
| Task 4 | [task4-customer-service.md](task4-customer-service.md) | 自研门锁维修单 → 客服跟进短信（限额轮转） |
| Task 5 | [task5-low-battery.md](task5-low-battery.md) | 门锁低电量 → 管家短信（城市白名单拦截） |

## 每个场景的统一结构

```
验证目标   → 开关/配置、入口、预期分支
precheck   → 前置检查清单（能力调用 + 失败提示）
seed       → 最小补齐 + 已知可用组合
trigger    → 触发方式（HTTP / Kafka）
assert     → 断言（日志 / 落库 / 缓存三类证据 + 负向断言）
cleanup    → 清理顺序
常见问题   → 现象 → 根因 → 处理
```

## 场景组合速查

| 想验证 | 用哪个 | 关键前置 |
|---|---|---|
| 管家收不到/收到安装提醒 | Task 1 | 上海合同 + lock_install 权益 + 商品在白名单 |
| 签约时管家收不到在途单提醒 | Task 2 | 在途安装单（status=4）+ 收房合同有处理人 |
| 派单走 Push 还是短信 | Task 3 | 真实门锁工单（家服建单） |
| 客服短信限额/轮转 | Task 4 | hui_ju 门锁 + 客服跟进开城 |
| 管家低电量被拦截 | Task 5 | 城市白名单配置 |
