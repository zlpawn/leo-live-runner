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

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isSecurityCheckEnabled() {
        return securityCheckEnabled;
    }

    public void setSecurityCheckEnabled(boolean securityCheckEnabled) {
        this.securityCheckEnabled = securityCheckEnabled;
    }

    public int getDefaultTimeoutSeconds() {
        return defaultTimeoutSeconds;
    }

    public void setDefaultTimeoutSeconds(int defaultTimeoutSeconds) {
        this.defaultTimeoutSeconds = defaultTimeoutSeconds;
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
}
