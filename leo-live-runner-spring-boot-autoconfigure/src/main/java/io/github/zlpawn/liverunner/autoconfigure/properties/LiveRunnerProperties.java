package io.github.zlpawn.liverunner.autoconfigure.properties;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration properties for Leo Live Runner.
 *
 * @author Leo (zlpawn)
 */
@ConfigurationProperties(prefix = "leo.live-runner")
public class LiveRunnerProperties {

    /**
     * Whether to enable the Live Runner engine and endpoints.
     * Default is true (Enabled out of the box).
     */
    private boolean enabled = true;

    /**
     * Whether to enforce AST security checks and high-risk API blacklisting.
     * Default is true (Security sandbox enabled by default to protect JVM & OS).
     */
    private boolean securityCheckEnabled = true;

    /**
     * Default execution timeout in seconds.
     */
    private int defaultTimeoutSeconds = 60;

    /**
     * Max log buffer size in KB for LiveLogger (HTTP response buffering).
     * Default is 64 KB (adequate for ~1000 lines of logs / stack traces).
     */
    private int maxLogBufferSizeKb = 64;

    /**
     * Core worker thread pool size for script execution.
     */
    private int corePoolSize = 2;

    /**
     * Max worker thread pool size for script execution.
     */
    private int maxPoolSize = 10;

    /**
     * Task queue capacity for worker thread pool.
     */
    private int queueCapacity = 200;

    /**
     * Keep-alive time in seconds for idle non-core worker threads.
     */
    private int keepAliveSeconds = 60;

    /**
     * Thread name prefix for worker threads.
     */
    private String threadNamePrefix = "LiveRunner-Worker-";

    /**
     * Rejection policy when thread pool and queue are saturated.
     */
    private RejectionPolicyType rejectionPolicy = RejectionPolicyType.CALLER_RUNS;

    /**
     * Granular security rules configuration.
     */
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
    public static class Security {
        private boolean enabled = true;
        private java.util.List<String> deniedBeans = new java.util.ArrayList<>();
        private java.util.List<String> allowedPackages = new java.util.ArrayList<>(java.util.Collections.singletonList("*"));
        private SqlSecurity sql = new SqlSecurity();
        private RedisSecurity redis = new RedisSecurity();
        private SystemSecurity system = new SystemSecurity();

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
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

    public static class SqlSecurity {
        private boolean allowDdl = false;
        private boolean allowMissingWhere = false;
        private int maxAffectedRows = 500;
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

    public static class RedisSecurity {
        private boolean allowDangerousKeys = false;

        public boolean isAllowDangerousKeys() {
            return allowDangerousKeys;
        }

        public void setAllowDangerousKeys(boolean allowDangerousKeys) {
            this.allowDangerousKeys = allowDangerousKeys;
        }
    }

    public static class SystemSecurity {
        private boolean allowProcessExec = false;
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
