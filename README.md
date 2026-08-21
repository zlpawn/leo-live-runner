# 🚀 Leo Live Runner (`leo-live-runner`)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![JDK](https://img.shields.io/badge/JDK-8%20|%2011%20|%2017%20|%2021-green.svg)]()
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-2.x%20|%203.x-brightgreen.svg)]()
[![Maven Central](https://img.shields.io/badge/Maven%20Central-io.github.zlpawn-orange.svg)](https://central.sonatype.com/)

> **生产级轻量热补丁与动态 API 执行引擎** —— 专为 Spring Boot 2.x / 3.x 应用打造。  
> 告别繁琐的发版流程，支持在运行时**动态注入 Java 逻辑**、**无缝装配宿主 Spring Bean**、**原生支持 `@Transactional` 事务 AOP 自动代理与异常回滚**、**提供一键即写即跑（One-Shot）与多方法动态 API**，并具备**全生命周期隔离与 Metaspace 内存自动卸载**能力。

---

## 🌟 核心特性

- 🎯 **业务代码零侵入**：老项目只需在 `pom.xml` 中引入单行 Starter 依赖，无需编写或改造任何 Java 业务类。
- 🛡️ **原生 `@Transactional` 事务支持**：动态类或方法直接打上 `@Transactional` 注解，引擎自动通过 Spring CGLIB 生成事务 AOP 代理，抛出异常自动 100% 事务回滚，杜绝脏数据！
- ⚡ **生产级集群双模式支持**：
  - **模式 A：一键即写即跑（`POST /execute`，推荐 ⭐⭐⭐⭐⭐）**：一次请求同时携带源码与参数，当场编译、执行、卸载并回显日志，天然免疫负载均衡（SLB）多 Pod 分发问题！
  - **模式 B：动态 API 注册与调用（`POST /register` + `POST /invoke/...`）**：预热编译并驻留内存，支持通过二级路径 `/invoke/{scriptKey}/{methodName}` 进行高频多方法调用。
- 🔀 **智能路由与多方法支持**：
  - **单方法自动绑定**：类中只有一个 public 方法时，直接通过 `/invoke/{scriptKey}` 调用；
  - **多方法子路径路由**：类中包含多个 public 方法（如 `query`, `update`, `cancel`）时，支持直接通过 `/invoke/{scriptKey}/{methodName}` 分别调用。
- 🧠 **智能参数映射**：动态方法支持**任意参数签名**（例如 `run(String orderId, String status, LiveLogger log)` 或 `run(Long id, Integer count)`），引擎自动将 JSON 字段智能映射并完成类型转换。
- 🛡️ **生产级防护（对标 XXL-JOB GLUE 架构）**：
  - **类隔离与彻底卸载**：Per-Script 独立 `LiveRunnerClassLoader`，支持主动销毁并释放 JVM Metaspace 内存；
  - **超时强制熔断**：独立 Worker 线程池 + `Future` 超时控制，杜绝死循环阻塞业务容器；
  - **日志回显捕获**：提供内置 `LiveLogger` 收集器，执行耗时与日志随 HTTP 响应实时回传。
- 🔄 **Spring Boot 2.x & 3.x 双向全兼容**：
  - 零硬编码包名，原生适配 `javax.annotation.*` 与 `jakarta.annotation.*`；
  - 同时提供 `spring.factories` 与 `AutoConfiguration.imports` 双装配规范。
- 📦 **纯正 Maven 多模块架构**：符合 Spring 官方规范，开箱即用，支持直接一键发布至 **Maven Central 中央仓库**。

---

## 🏗️ 架构设计

```mermaid
flowchart TD
    subgraph 接入层 (业务老项目)
        A[老项目 pom.xml<br/>引入 leo-live-runner-spring-boot-starter] --> B[自动装配 LiveRunnerAutoConfiguration]
    end

    subgraph 核心引擎层 (Core Engine)
        B --> C[SpringBeanInjector: 自动反射注入 Spring Bean]
        C --> C1[AOP 事务增强: 自动检测 @Transactional 并生成 CGLIB 代理]
        B --> D[LiveRunnerEngine: 动态编译与多方法调度]
        D --> E[ScriptRegistry: 脚本注册表与状态跟踪]
        D --> F[LiveRunnerClassLoader: Per-Script 隔离加载与卸载]
    end

    subgraph 对外 RESTful 端点
        G1["POST /internal/live-runner/execute<br/>(🔥 一键即写即跑, 多 Pod 集群首选)"] --> D
        G2["POST /internal/live-runner/register<br/>(注册并常驻内存)"] --> D
        H1["POST /internal/live-runner/invoke/{key}<br/>(单方法/默认方法调用)"] --> D
        H2["POST /internal/live-runner/invoke/{key}/{methodName}<br/>(二级子路径多方法调用)"] --> D
        I[GET /internal/live-runner/list<br/>查看已加载脚本与指标] --> E
        J[DELETE /internal/live-runner/unregister/{key}<br/>卸载 Class 释放元空间] --> E
    end
```

---

## 🚀 快速接入

### 1. 老项目引入 Maven 依赖
```xml
<dependency>
    <groupId>io.github.zlpawn</groupId>
    <artifactId>leo-live-runner-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

### 2. 配置文件开启 Token 校验（可选）
`application.yml`:
```yaml
leo:
  live-runner:
    enabled: true                          # 默认已开启 (开箱即用)
    token-check-enabled: false             # Token 校验默认关闭，生产环境建议配置为 true
    token: "LeoLiveRunnerSecretToken@2026"  # 生产环境专属密钥
    default-timeout-seconds: 60           # 默认执行超时时间 (秒)
```

---

## 📡 RESTful API 规范

### 1. 【生产首选】一键即写即跑 + 原生 `@Transactional` 事务演示
> 直接带上 `@Transactional` 注解，遇到异常自动 100% 回滚，彻底杜绝数据修复中的脏数据！

* **URL**: `POST http://localhost:8080/internal/live-runner/execute`
* **Body (JSON)**:
```json
{
  "scriptSource": "package com.leo.dynamic;\nimport io.github.zlpawn.liverunner.core.LiveLogger;\nimport org.springframework.jdbc.core.JdbcTemplate;\nimport org.springframework.transaction.annotation.Transactional;\npublic class OrderRepairTask {\n    private JdbcTemplate jdbcTemplate;\n    @Transactional(rollbackFor = Exception.class)\n    public Object run(String orderId, LiveLogger log) {\n        log.println(\">>> Step 1: 扣减金额...\");\n        jdbcTemplate.update(\"UPDATE t_account SET balance = balance - 100 WHERE id = 1\");\n        log.println(\">>> Step 2: 模拟业务异常触发回滚...\");\n        if (true) { throw new RuntimeException(\"扣款失败，触发事务回滚\"); }\n        return \"SUCCESS\";\n    }\n}",
  "params": {
    "orderId": "1001"
  }
}
```

* **响应 JSON (统一扁平企业结构)**:
```json
{
  "code": 500,
  "success": false,
  "data": null,
  "msg": ">>> Step 1: 扣减金额...\n>>> Step 2: 模拟业务异常触发回滚...\n[ERROR Exception]:\njava.lang.RuntimeException: 扣款失败，触发事务回滚\n\tat com.leo.dynamic.OrderRepairTask.run...\n",
  "costMs": 25
}
```

---

### 2. 注册为常驻动态 API (`POST /internal/live-runner/register`)

#### 场景：多方法动态 Controller 服务族
```java
package com.leo.dynamic;

import com.example.sample.service.OrderService;
import io.github.zlpawn.liverunner.core.LiveLogger;

public class OrderApiController {
    private OrderService orderService;

    public Object query(String orderId) {
        return orderService.getOrderStatus(Long.parseLong(orderId));
    }

    public Object update(String orderId, String status, LiveLogger log) {
        log.println("Updating order: " + orderId + " to " + status);
        orderService.updateOrderStatus(Long.parseLong(orderId), status);
        return "UPDATE_SUCCESS";
    }

    public Object cancel(String orderId) {
        orderService.updateOrderStatus(Long.parseLong(orderId), "CANCELLED");
        return "CANCEL_SUCCESS";
    }
}
```

* **分别调用各二级子方法**：
  * **调用 query**：`POST /internal/live-runner/invoke/order-api/query` $\rightarrow$ `{"orderId": "1001"}`
  * **调用 update**：`POST /internal/live-runner/invoke/order-api/update` $\rightarrow$ `{"orderId": "1001", "status": "PAID"}`
  * **调用 cancel**：`POST /internal/live-runner/invoke/order-api/cancel` $\rightarrow$ `{"orderId": "1001"}`

---

### 3. 查看内存中已注册脚本 (`GET /internal/live-runner/list`)
* **Response**:
```json
{
  "code": 200,
  "success": true,
  "data": [
    {
      "scriptKey": "order-api",
      "version": 1,
      "md5": "e10adc3949ba59abbe56e057f20f883e",
      "remark": "订单动态服务",
      "registerTime": "2026-08-20T23:00:00.000+08:00",
      "lastInvokeTime": "2026-08-20T23:05:12.000+08:00",
      "invokeCount": 42
    }
  ],
  "msg": "SUCCESS",
  "costMs": 0
}
```

---

### 4. 彻底卸载与释放内存 (`DELETE /internal/live-runner/unregister/{scriptKey}`)
* **URL**: `DELETE http://localhost:8080/internal/live-runner/unregister/order-api`
* **Response**:
```json
{
  "code": 200,
  "success": true,
  "data": null,
  "msg": "Script unregistered and ClassLoader unloaded.",
  "costMs": 0
}
```

---

## 🌍 发布到 Maven Central 中央仓库指南

本项目已预置最新版 `central-publishing-maven-plugin` 与 GPG 签名配置，支持直接一键发布至 Maven 中央仓库（Sonatype Central Portal）。

👉 **完整发布实操手册**：[Maven Central 详细发布指南 (docs/maven-central-publish-guide.md)](docs/maven-central-publish-guide.md)

### 快速三步发布简述：
1. **命名空间认证**：在 [Sonatype Central](https://central.sonatype.com/) 认证 Namespace `io.github.zlpawn`；
2. **配置令牌与 GPG**：在 `~/.m2/settings.xml` 配置 Central Token 并准备好 GPG 秘钥；
3. **一键构建签名与发布**：
   ```bash
   mvn clean deploy
   ```

---

## 📜 开源协议

本项目基于 [Apache License 2.0](LICENSE) 协议开源。
