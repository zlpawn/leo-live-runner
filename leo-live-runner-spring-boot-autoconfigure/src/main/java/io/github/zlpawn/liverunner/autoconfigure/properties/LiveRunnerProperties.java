package io.github.zlpawn.liverunner.autoconfigure.properties;

import io.github.zlpawn.liverunner.core.annotation.LiveConfigDoc;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration properties for Leo Live Runner.
 *
 * @author Leo (zlpawn)
 */
@ConfigurationProperties(prefix = "leo.live-runner")
@LiveConfigDoc(group = "全局基础配置")
public class LiveRunnerProperties {

    /**
     * Whether to enable the Live Runner engine and endpoints.
     * Default is true (Enabled out of the box).
     */
    @LiveConfigDoc(desc = "是否启用 LiveRunner 引擎及所有 HTTP 端点", dynamic = false, group = "全局基础配置")
    private boolean enabled = true;

    /**
     * Whether to enforce AST security checks and high-risk API blacklisting.
     * Default is true (Security sandbox enabled by default to protect JVM & OS).
     */
    @LiveConfigDoc(desc = "全局 AST 代码安全沙箱与高危语法校验总开关", dynamic = true, group = "安全沙箱与只读控制")
    private boolean securityCheckEnabled = true;

    /**
     * Default execution timeout in seconds.
     */
    @LiveConfigDoc(desc = "脚本单次执行的默认 HTTP 熔断超时时间", unit = "seconds", dynamic = false, group = "执行超时与日志")
    private int defaultTimeoutSeconds = 60;

    /**
     * Max log buffer size in KB for LiveLogger (HTTP response buffering).
     * Default is 64 KB (adequate for ~1000 lines of logs / stack traces).
     */
    @LiveConfigDoc(desc = "LiveLogger 运行时日志缓冲区最大内存容量", unit = "KB", dynamic = false, group = "执行超时与日志")
    private int maxLogBufferSizeKb = 64;

    /**
     * Core worker thread pool size for script execution.
     */
    @LiveConfigDoc(desc = "脚本执行工作线程池核心线程数（支持动态伸缩）", unit = "threads", dynamic = true, group = "工作线程池配置")
    private int corePoolSize = 2;

    /**
     * Max worker thread pool size for script execution.
     */
    @LiveConfigDoc(desc = "脚本执行工作线程池最大线程数（支持动态伸缩）", unit = "threads", dynamic = true, group = "工作线程池配置")
    private int maxPoolSize = 10;

    /**
     * Task queue capacity for worker thread pool.
     */
    @LiveConfigDoc(desc = "脚本执行等待队列容量（支持动态伸缩）", unit = "capacity", dynamic = true, group = "工作线程池配置")
    private int queueCapacity = 200;

    /**
     * Keep-alive time in seconds for idle non-core worker threads.
     */
    @LiveConfigDoc(desc = "非核心空闲工作线程的最大存活保活时间", unit = "seconds", dynamic = true, group = "工作线程池配置")
    private int keepAliveSeconds = 60;

    /**
     * Thread name prefix for worker threads.
     */
    @LiveConfigDoc(desc = "工作线程名称前缀", dynamic = false, group = "工作线程池配置")
    private String threadNamePrefix = "LiveRunner-Worker-";

    /**
     * Rejection policy when thread pool and queue are saturated.
     */
    @LiveConfigDoc(desc = "线程池与队列饱和时的任务拒绝策略（CALLER_RUNS / ABORT / DISCARD）", dynamic = false, group = "工作线程池配置")
    private RejectionPolicyType rejectionPolicy = RejectionPolicyType.CALLER_RUNS;

    /**
     * Stuck-task detection for scripts remaining active after HTTP timeout.
     */
    @LiveConfigDoc(group = "卡死任务监控")
    private StuckTask stuckTask = new StuckTask();

    /**
     * Granular security rules configuration.
     */
    @LiveConfigDoc(group = "安全沙箱与只读控制")
    private Security security = new Security();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isSecurityCheckEnabled() {
        return securityCheckEnabled && security.isEnabled();
    }

    public void setSecurityCheckEnabled(boolean securityCheckEnabled) {
        this.securityCheckEnabled = securityCheckEnabled;
        this.security.setEnabled(securityCheckEnabled);
    }

    public int getDefaultTimeoutSeconds() {
        return defaultTimeoutSeconds;
    }

    public void setDefaultTimeoutSeconds(int defaultTimeoutSeconds) {
        this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    }

    public int getMaxLogBufferSizeKb() {
        return maxLogBufferSizeKb;
    }

    public void setMaxLogBufferSizeKb(int maxLogBufferSizeKb) {
        this.maxLogBufferSizeKb = maxLogBufferSizeKb;
    }

    public int getCorePoolSize() {
        return corePoolSize;
    }

    public void setCorePoolSize(int corePoolSize) {
        this.corePoolSize = corePoolSize;
    }

    public int getMaxPoolSize() {
        return maxPoolSize;
    }

    public void setMaxPoolSize(int maxPoolSize) {
        this.maxPoolSize = maxPoolSize;
    }

    public int getQueueCapacity() {
        return queueCapacity;
    }

    public void setQueueCapacity(int queueCapacity) {
        this.queueCapacity = queueCapacity;
    }

    public int getKeepAliveSeconds() {
        return keepAliveSeconds;
    }

    public void setKeepAliveSeconds(int keepAliveSeconds) {
        this.keepAliveSeconds = keepAliveSeconds;
    }

    public String getThreadNamePrefix() {
        return threadNamePrefix;
    }

    public void setThreadNamePrefix(String threadNamePrefix) {
        this.threadNamePrefix = threadNamePrefix;
    }

    public RejectionPolicyType getRejectionPolicy() {
        return rejectionPolicy;
    }

    public void setRejectionPolicy(RejectionPolicyType rejectionPolicy) {
        this.rejectionPolicy = rejectionPolicy;
    }

    public StuckTask getStuckTask() {
        return stuckTask;
    }

    public void setStuckTask(StuckTask stuckTask) {
        this.stuckTask = stuckTask != null ? stuckTask : new StuckTask();
    }

    public boolean isReadOnlyMode() {
        return security != null && security.isReadOnlyMode();
    }

    public void setReadOnlyMode(boolean readOnlyMode) {
        if (this.security != null) {
            this.security.setReadOnlyMode(readOnlyMode);
        }
    }

    public Security getSecurity() {
        return security;
    }

    public void setSecurity(Security security) {
        if (security != null) {
            this.security = security;
        }
    }

    /**
     * Nested security sandbox configuration properties.
     */
    @LiveConfigDoc(group = "安全沙箱与只读控制")
    public static class Security {
        @LiveConfigDoc(desc = "安全沙箱拦截总开关", dynamic = true, group = "安全沙箱与只读控制")
        private boolean enabled = true;

        @LiveConfigDoc(desc = "只读保护模式：开启后仅允许 SELECT 查询，严格拦截所有 INSERT/UPDATE/DELETE/Redis写/MQ发送与第三方HTTP写操作", dynamic = true, group = "安全沙箱与只读控制")
        private boolean readOnlyMode = true;

        @LiveConfigDoc(desc = "禁止动态脚本自动注入的 Spring Bean 黑名单名称列表（支持逗号分隔）", dynamic = true, group = "容器注入安全规则")
        private java.util.List<String> deniedBeans = new java.util.ArrayList<>();

        @LiveConfigDoc(desc = "动态脚本允许导入与访问的 Java 类包白名单（默认为 [*] 允许所有合法包）", dynamic = false, group = "容器注入安全规则")
        private java.util.List<String> allowedPackages = new java.util.ArrayList<>(java.util.Collections.singletonList("*"));

        @LiveConfigDoc(group = "SQL 安全规则")
        private SqlSecurity sql = new SqlSecurity();

        @LiveConfigDoc(group = "Redis 安全规则")
        private RedisSecurity redis = new RedisSecurity();

        @LiveConfigDoc(group = "系统底层安全规则")
        private SystemSecurity system = new SystemSecurity();

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public boolean isReadOnlyMode() {
            return readOnlyMode;
        }

        public void setReadOnlyMode(boolean readOnlyMode) {
            this.readOnlyMode = readOnlyMode;
        }

        public java.util.List<String> getDeniedBeans() {
            return deniedBeans;
        }

        public void setDeniedBeans(java.util.List<String> deniedBeans) {
            this.deniedBeans = deniedBeans != null ? deniedBeans : new java.util.ArrayList<>();
        }

        public java.util.List<String> getAllowedPackages() {
            return allowedPackages;
        }

        public void setAllowedPackages(java.util.List<String> allowedPackages) {
            this.allowedPackages = allowedPackages != null ? allowedPackages : new java.util.ArrayList<>();
        }

        public SqlSecurity getSql() {
            return sql;
        }

        public void setSql(SqlSecurity sql) {
            if (sql != null) this.sql = sql;
        }

        public RedisSecurity getRedis() {
            return redis;
        }

        public void setRedis(RedisSecurity redis) {
            if (redis != null) this.redis = redis;
        }

        public SystemSecurity getSystem() {
            return system;
        }

        public void setSystem(SystemSecurity system) {
            if (system != null) this.system = system;
        }
    }

    @LiveConfigDoc(group = "卡死任务监控")
    public static class StuckTask {
        @LiveConfigDoc(desc = "是否开启超时后仍在运行的卡死任务后台检测与告警追踪", dynamic = false, group = "卡死任务监控")
        private boolean detectionEnabled = true;

        @LiveConfigDoc(desc = "任务超时后的宽限等待时间，超过此宽限期仍未结束则判定为卡死任务", unit = "seconds", dynamic = false, group = "卡死任务监控")
        private int graceSeconds = 60;

        @LiveConfigDoc(desc = "卡死任务后台定时扫描检查的执行周期", unit = "seconds", dynamic = false, group = "卡死任务监控")
        private int checkIntervalSeconds = 10;

        @LiveConfigDoc(desc = "内存中保留的历史卡死任务快照记录最大数量", unit = "records", dynamic = false, group = "卡死任务监控")
        private int maxRecordedStuckTasks = 100;

        public boolean isDetectionEnabled() {
            return detectionEnabled;
        }

        public void setDetectionEnabled(boolean detectionEnabled) {
            this.detectionEnabled = detectionEnabled;
        }

        public int getGraceSeconds() {
            return graceSeconds;
        }

        public void setGraceSeconds(int graceSeconds) {
            this.graceSeconds = Math.max(1, graceSeconds);
        }

        public int getCheckIntervalSeconds() {
            return checkIntervalSeconds;
        }

        public void setCheckIntervalSeconds(int checkIntervalSeconds) {
            this.checkIntervalSeconds = Math.max(1, checkIntervalSeconds);
        }

        public int getMaxRecordedStuckTasks() {
            return maxRecordedStuckTasks;
        }

        public void setMaxRecordedStuckTasks(int maxRecordedStuckTasks) {
            this.maxRecordedStuckTasks = Math.max(1, maxRecordedStuckTasks);
        }
    }

    @LiveConfigDoc(group = "SQL 安全规则")
    public static class SqlSecurity {
        @LiveConfigDoc(desc = "是否允许执行 DROP DATABASE/TABLE/INDEX、TRUNCATE、ALTER TABLE 等 DDL 结构变更语句", dynamic = true, group = "SQL 安全规则")
        private boolean allowDdl = false;

        @LiveConfigDoc(desc = "非只读模式下，是否允许执行不带 WHERE 条件的全表 UPDATE / DELETE 语句", dynamic = true, group = "SQL 安全规则")
        private boolean allowMissingWhere = false;

        @LiveConfigDoc(desc = "SQL 单次更新/删除操作允许影响的最大行数阈值", unit = "rows", dynamic = false, group = "SQL 安全规则")
        private int maxAffectedRows = 500;

        @LiveConfigDoc(desc = "SQL 单次查询允许返回的最大行数限制", unit = "rows", dynamic = false, group = "SQL 安全规则")
        private int maxQueryRows = 500;

        public boolean isAllowDdl() {
            return allowDdl;
        }

        public void setAllowDdl(boolean allowDdl) {
            this.allowDdl = allowDdl;
        }

        public boolean isAllowMissingWhere() {
            return allowMissingWhere;
        }

        public void setAllowMissingWhere(boolean allowMissingWhere) {
            this.allowMissingWhere = allowMissingWhere;
        }

        public int getMaxAffectedRows() {
            return maxAffectedRows;
        }

        public void setMaxAffectedRows(int maxAffectedRows) {
            this.maxAffectedRows = maxAffectedRows;
        }

        public int getMaxQueryRows() {
            return maxQueryRows;
        }

        public void setMaxQueryRows(int maxQueryRows) {
            this.maxQueryRows = maxQueryRows;
        }
    }

    @LiveConfigDoc(group = "Redis 安全规则")
    public static class RedisSecurity {
        @LiveConfigDoc(desc = "是否允许执行 KEYS *、FLUSHALL、FLUSHDB、CONFIG 等阻塞单线程或清空库的高危 Redis 命令", dynamic = true, group = "Redis 安全规则")
        private boolean allowDangerousKeys = false;

        public boolean isAllowDangerousKeys() {
            return allowDangerousKeys;
        }

        public void setAllowDangerousKeys(boolean allowDangerousKeys) {
            this.allowDangerousKeys = allowDangerousKeys;
        }
    }

    @LiveConfigDoc(group = "系统底层安全规则")
    public static class SystemSecurity {
        @LiveConfigDoc(desc = "是否允许通过 Runtime.getRuntime().exec 或 ProcessBuilder 执行操作系统 Shell 命令行", dynamic = true, group = "系统底层安全规则")
        private boolean allowProcessExec = false;

        @LiveConfigDoc(desc = "是否允许执行 System.exit 终止当前 JVM 进程", dynamic = false, group = "系统底层安全规则")
        private boolean allowSystemExit = false;

        public boolean isAllowProcessExec() {
            return allowProcessExec;
        }

        public void setAllowProcessExec(boolean allowProcessExec) {
            this.allowProcessExec = allowProcessExec;
        }

        public boolean isAllowSystemExit() {
            return allowSystemExit;
        }

        public void setAllowSystemExit(boolean allowSystemExit) {
            this.allowSystemExit = allowSystemExit;
        }
    }
}
