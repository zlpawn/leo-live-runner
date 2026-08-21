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
     * Whether to enforce token authentication on HTTP endpoints.
     * Default is false (Token check is disabled by default, opt-in for production).
     */
    private boolean tokenCheckEnabled = false;

    /**
     * Whether to enforce AST security checks and high-risk API blacklisting.
     * Default is true (Security sandbox enabled by default to protect JVM & OS).
     */
    private boolean securityCheckEnabled = true;

    /**
     * Secret authentication token required in HTTP Header (X-Live-Token) when tokenCheckEnabled=true.
     */
    private String token = "LeoLiveRunnerSecretToken@2026";

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

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isTokenCheckEnabled() {
        return tokenCheckEnabled;
    }

    public void setTokenCheckEnabled(boolean tokenCheckEnabled) {
        this.tokenCheckEnabled = tokenCheckEnabled;
    }

    public boolean isSecurityCheckEnabled() {
        return securityCheckEnabled;
    }

    public void setSecurityCheckEnabled(boolean securityCheckEnabled) {
        this.securityCheckEnabled = securityCheckEnabled;
    }

    public String getToken() {
        return token;
    }

    public void setToken(String token) {
        this.token = token;
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
}
