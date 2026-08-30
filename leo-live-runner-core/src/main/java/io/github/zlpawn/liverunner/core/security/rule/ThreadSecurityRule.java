package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Pattern;

/**
 * Thread management security rules.
 * Intercepts dangerous thread operations like Thread.stop, suspend, resume to avoid deadlock and corrupted state.
 *
 * @author Leo (zlpawn)
 */
public class ThreadSecurityRule implements SecurityRule {

    public static final ThreadSecurityRule INSTANCE = new ThreadSecurityRule();

    private static final Pattern PATTERN_THREAD_STOP =
            Pattern.compile("Thread\\s*\\.\\s*(currentThread\\s*\\(\\s*\\)\\s*\\.\\s*)?stop\\s*\\(", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_THREAD_SUSPEND_RESUME =
            Pattern.compile("Thread\\s*\\.\\s*(currentThread\\s*\\(\\s*\\)\\s*\\.\\s*)?(suspend|resume)\\s*\\(", Pattern.CASE_INSENSITIVE);

    @Override
    public String getName() {
        return "THREAD_SECURITY";
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        RuleResult r1 = checkThreadStop(scriptSource);
        if (r1.isFailed()) return r1;

        RuleResult r2 = checkThreadSuspendResume(scriptSource);
        if (r2.isFailed()) return r2;

        return RuleResult.pass();
    }

    // ─── Atomic Static Check Methods (Single Responsibility Principle) ───────

    public static RuleResult checkThreadStop(String scriptSource) {
        if (scriptSource != null && PATTERN_THREAD_STOP.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Invoking Thread.stop() is strictly forbidden to prevent JVM monitor locks corruption.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkThreadSuspendResume(String scriptSource) {
        if (scriptSource != null && PATTERN_THREAD_SUSPEND_RESUME.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Invoking Thread.suspend() or Thread.resume() is strictly forbidden to prevent deadlock.");
        }
        return RuleResult.pass();
    }
}
