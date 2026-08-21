package io.github.zlpawn.liverunner.core.security;

import java.io.Serializable;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Result object returned by {@link LiveRunnerAccessValidator}.
 * Encapsulates authorization decision, HTTP status code, message, and optional extra metadata.
 *
 * @author Leo (zlpawn)
 */
public class AccessResult implements Serializable {
    private static final long serialVersionUID = 1L;

    private final boolean allowed;
    private final int code;
    private final String message;
    private final Map<String, Object> extras;

    public AccessResult(boolean allowed, int code, String message) {
        this(allowed, code, message, Collections.emptyMap());
    }

    public AccessResult(boolean allowed, int code, String message, Map<String, Object> extras) {
        this.allowed = allowed;
        this.code = code;
        this.message = message != null ? message : (allowed ? "SUCCESS" : "Access Denied");
        this.extras = extras != null ? new HashMap<>(extras) : Collections.emptyMap();
    }

    /**
     * Create an allowed result (HTTP 200).
     */
    public static AccessResult allow() {
        return new AccessResult(true, 200, "SUCCESS");
    }

    /**
     * Create an allowed result with custom message.
     */
    public static AccessResult allow(String message) {
        return new AccessResult(true, 200, message);
    }

    /**
     * Create a denied result with default HTTP 403 Forbidden.
     */
    public static AccessResult deny(String message) {
        return new AccessResult(false, 403, message);
    }

    /**
     * Create a denied result with specific HTTP status code (e.g. 401, 403, 429).
     */
    public static AccessResult deny(int code, String message) {
        return new AccessResult(false, code, message);
    }

    public boolean isAllowed() {
        return allowed;
    }

    public int getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }

    public Map<String, Object> getExtras() {
        return Collections.unmodifiableMap(extras);
    }

    @Override
    public String toString() {
        return "AccessResult{" +
                "allowed=" + allowed +
                ", code=" + code +
                ", message='" + message + '\'' +
                '}';
    }
}
