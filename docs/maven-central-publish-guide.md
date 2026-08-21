# 📦 Maven 中央仓库 (Maven Central) 完整发布指南

本指南详细记录如何将 `leo-live-runner` 开源组件发布至 **Maven 中央仓库（Maven Central / Sonatype Central Portal）**，供全球 Java 开发者直接通过 Maven / Gradle 依赖引入。

---

## 🌟 0. 发布架构说明

从 2024 年起，Sonatype 官方已全面启用 **[Sonatype Central Portal (新版控制台)](https://central.sonatype.com/)**，彻底取代了旧版的 OSSRH Jira 工单系统。

本项目根 `pom.xml` 已针对新版 Central Portal 完成了全套现代化插件集成：
- ✅ `maven-source-plugin`（源码包打包）；
- ✅ `maven-javadoc-plugin`（API 文档打包）；
- ✅ `maven-gpg-plugin`（GPG 数字防篡改签名）；
- ✅ `central-publishing-maven-plugin`（官方直推插件，支持 `autoPublish` 自动校验发布）。

---

## 🚀 第一步：注册 Sonatype Central 账号与命名空间所有权认证

1. **登录平台**：
   访问 [https://central.sonatype.com/](https://central.sonatype.com/)，推荐直接使用 **GitHub 账号 (`zlpawn`) 快捷登录**。
2. **认证 Namespace（命名空间）**：
   - 导航到 **“View Account” -> “Namespaces” -> “Add Namespace”**；
   - 输入命名空间：`io.github.zlpawn`；
   - 点击 **“Verify Namespace”**；
   - 平台会给出一个临时验证码（如 `verification-key: abcd1234efgh`）；
   - 按照提示在你的 GitHub (`https://github.com/zlpawn`) 账号下创建一个名为该验证码的**临时公开空仓库**；
   - 返回页面点击 **“Confirm”**，系统会在 10 秒内自动校验通过；
   - 校验通过后即可删除该临时仓库。

---

## 🔑 第二步：生成发布令牌并在本地配置 `settings.xml`

1. **获取 Token**：
   - 在 [Sonatype Central Portal](https://central.sonatype.com/) 右上角点击头像 -> **“View Account” -> “Generate User Token”**；
   - 复制生成的 `User Name` 和 `Password`。
2. **配置本地 Maven `settings.xml`**：
   打开本地 Maven 配置文件（通常位于 `~/.m2/settings.xml` 或 `D:/maven/conf/settings.xml`），在 `<servers>` 节点中添加：

```xml
<servers>
    <!-- Server ID 必须与 pom.xml 中的 publishingServerId 保持一致: central -->
    <server>
        <id>central</id>
        <username>你的Sonatype_Token_Username</username>
        <password>你的Sonatype_Token_Password</password>
    </server>
</servers>
```

---

## 🛡️ 第三步：生成 GPG 秘钥并分发公钥（数字签名要求）

Maven Central 强制要求所有发布的 Jar 包必须具有 GPG 签名。

### 1. 检查或安装 GPG
在终端运行：
```powershell
gpg --version
```
> 若未安装，Windows 可通过 `winget install GnuPG.GnuPG` 或下载 [Gpg4win](https://www.gpg4win.org/) 安装。

### 2. 生成 GPG 密钥对
```powershell
gpg --gen-key
```
* 按照提示输入真实姓名（如 `Leo`）和邮箱（如 `zlpawn@gmail.com`）；
* 设置一个安全的 **Passphrase（密码）** 并牢记。

### 3. 查看公钥 ID
```powershell
gpg --list-keys --keyid-format LONG
```
输出示例：
```text
pub   rsa3072/8A7B6C5D4E3F2A1B 2026-08-21 [SC]
uid                 [ultimate] Leo <zlpawn@gmail.com>
```
其中 `8A7B6C5D4E3F2A1B` 即为你的 **GPG 密钥 ID (Key ID)**。

### 4. 将公钥分发至公共密钥服务器（必须）
```powershell
gpg --keyserver keyserver.ubuntu.com --send-keys 8A7B6C5D4E3F2A1B
```

---

## 📤 第四步：一键打包、签名并推送到中央仓库

在工程根目录（`D:\Java Project\Leo\leo-live-runner`）执行标准部署命令：

```powershell
mvn clean deploy
```

> 💡 **提示**：
> 1. 执行期间系统会弹出 GPG 密码输入框，输入刚才设置的 Passphrase 即可；
> 2. `central-publishing-maven-plugin` 会自动依次执行：
>    - 编译各子模块；
>    - 生成 `-sources.jar` 源码包与 `-javadoc.jar` 文档包；
>    - 对所有产物执行 GPG 签名（生成 `.asc` 文件）；
>    - 自动打包上传至 Sonatype Central Portal。

---

## 🔍 第五步：查看审核状态与全球同步

1. **登录控制台查看**：
   访问 [https://central.sonatype.com/publishing/deployments](https://central.sonatype.com/publishing/deployments) 查看上传批次状态：
   - **`VALIDATING`**：系统正在自动校验 POM 元数据、GPG 签名与 Javadoc 合规性；
   - **`PUBLISHED`**：校验通过，已成功发布！
2. **全球 CDN 索引生效时间**：
   - 发布成功后约 **15 ~ 30 分钟** 内，组件将同步至全球 Maven 节点；
   - 届时可在 [Maven Central Search](https://central.sonatype.com/search?q=leo-live-runner) 检索到。

---

## 💻 第六步：开发者引用示例

发布完成后，任何微服务工程即可直接在其 `pom.xml` 中引入：

```xml
<dependency>
    <groupId>io.github.zlpawn</groupId>
    <artifactId>leo-live-runner-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

---

## ❓ 常见问题排查 (FAQ)

### Q1: 提示 `GPG signing failed: gpg: signing failed: Inappropriate ioctl for device` 或密码错误？
* **解决办法**：确保本地已启动 `gpg-agent`，或在命令行临时设置环境变量：
  ```powershell
  $env:GPG_TTY=$(tty)
  ```

### Q2: 提示 `Central Portal 校验失败: Missing Javadoc or Sources`？
* **解决办法**：本项目已在根 `pom.xml` 中预置了 `maven-source-plugin` 与 `maven-javadoc-plugin`，直接运行 `mvn clean deploy` 会自动生成，无需额外干预。

### Q3: 后续版本迭代发布（如 `1.0.1`）？
* 每次发版只需在根 `pom.xml` 修改 `<version>1.0.1</version>`，然后再次运行 `mvn clean deploy` 即可！
