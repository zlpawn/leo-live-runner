package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Pattern;

/**
 * System and JVM level security rules.
 * Intercepts System.exit, OS command execution, ProcessBuilder, Unsafe memory manipulation,
 * and security manager tampering.
 *
 * @author Leo (zlpawn)
 */
public class SystemSecurityRule implements SecurityRule {

    public static final SystemSecurityRule INSTANCE = new SystemSecurityRule();

    private final boolean allowProcessExec;

    public SystemSecurityRule() {
        this(false);
    }

    public SystemSecurityRule(boolean allowProcessExec) {
        this.allowProcessExec = allowProcessExec;
    }

    private static final Pattern PATTERN_SYSTEM_EXIT =
            Pattern.compile("System\\s*\\.\\s*exit", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_RUNTIME_EXEC =
            Pattern.compile("Runtime\\s*\\.\\s*getRuntime\\s*\\(\\s*\\)\\s*\\.\\s*exec", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_PROCESS_BUILDER =
            Pattern.compile("ProcessBuilder", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_UNSAFE =
            Pattern.compile("(sun\\.misc\\.Unsafe|jdk\\.internal\\.misc\\.Unsafe)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_SET_SECURITY_MANAGER =
            Pattern.compile("System\\s*\\.\\s*setSecurityManager", Pattern.CASE_INSENSITIVE);

    @Override
    public String getName() {
        return "SYSTEM_SECURITY";
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        RuleResult r1 = checkSystemExit(scriptSource);
        if (r1.isFailed()) return r1;

        if (!allowProcessExec) {
            RuleResult r2 = checkCommandExecution(scriptSource);
            if (r2.isFailed()) return r2;

            RuleResult r3 = checkProcessBuilder(scriptSource);
            if (r3.isFailed()) return r3;
        }

        RuleResult r4 = checkUnsafe(scriptSource);
        if (r4.isFailed()) return r4;

        RuleResult r5 = checkSecurityManager(scriptSource);
        if (r5.isFailed()) return r5;

        return RuleResult.pass();
    }

    // ─── Atomic Static Check Methods (Single Responsibility Principle) ───────

    public static RuleResult checkSystemExit(String scriptSource) {
        if (scriptSource != null && PATTERN_SYSTEM_EXIT.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Calling System.exit is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkCommandExecution(String scriptSource) {
        if (scriptSource != null && PATTERN_RUNTIME_EXEC.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Executing OS commands via Runtime.getRuntime().exec is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkProcessBuilder(String scriptSource) {
        if (scriptSource != null && PATTERN_PROCESS_BUILDER.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Spawning processes via ProcessBuilder is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkUnsafe(String scriptSource) {
        if (scriptSource != null && PATTERN_UNSAFE.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Accessing low-level Unsafe APIs is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkSecurityManager(String scriptSource) {
        if (scriptSource != null && PATTERN_SET_SECURITY_MANAGER.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Tampering with System SecurityManager is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }
}
