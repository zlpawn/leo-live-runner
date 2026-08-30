package io.github.zlpawn.liverunner.core.security;

import java.io.Serializable;

/**
 * Result object returned by {@link LiveRunnerCodeValidator}.
 *
 * @author Leo (zlpawn)
 */
public class CodeValidationResult implements Serializable {
    private static final long serialVersionUID = 1L;

    private final boolean allowed;
    private final String reason;

    private CodeValidationResult(boolean allowed, String reason) {
        this.allowed = allowed;
        this.reason = reason;
    }

    /**
     * Create an allowed result.
     */
    public static CodeValidationResult allow() {
        return new CodeValidationResult(true, null);
    }

    /**
     * Create a denied result with violation reason.
     */
    public static CodeValidationResult deny(String reason) {
        return new CodeValidationResult(false, reason);
    }

    public boolean isAllowed() {
        return allowed;
    }

    public boolean isDenied() {
        return !allowed;
    }

    public String getReason() {
        return reason;
    }

    @Override
    public String toString() {
        return "CodeValidationResult{" +
                "allowed=" + allowed +
                ", reason='" + reason + '\'' +
                '}';
    }
}
