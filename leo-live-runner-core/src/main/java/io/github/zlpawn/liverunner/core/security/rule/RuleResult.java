package io.github.zlpawn.liverunner.core.security.rule;

import java.io.Serializable;

/**
 * Result object for a single {@link SecurityRule} evaluation.
 * Designed with explicit {@code isPassed()} and {@code isFailed()} methods to eliminate negation confusion.
 *
 * @author Leo (zlpawn)
 */
public class RuleResult implements Serializable {
    private static final long serialVersionUID = 1L;

    private final boolean passed;
    private final String reason;

    private RuleResult(boolean passed, String reason) {
        this.passed = passed;
        this.reason = reason;
    }

    /**
     * Create a passed rule result.
     */
    public static RuleResult pass() {
        return new RuleResult(true, null);
    }

    /**
     * Create a failed rule result with violation reason.
     */
    public static RuleResult fail(String reason) {
        return new RuleResult(false, reason);
    }

    public boolean isPassed() {
        return passed;
    }

    /**
     * Semantic failure check without boolean negation (!).
     */
    public boolean isFailed() {
        return !passed;
    }

    public String getReason() {
        return reason;
    }

    @Override
    public String toString() {
        return "RuleResult{" +
                "passed=" + passed +
                ", reason='" + reason + '\'' +
                '}';
    }
}
