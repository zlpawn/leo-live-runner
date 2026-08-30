package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Pattern;

/**
 * Redis high-risk command and API protection rules.
 * Intercepts dangerous operations like FLUSHALL, FLUSHDB, KEYS *, SHUTDOWN, CONFIG SET, and SLAVEOF.
 *
 * @author Leo (zlpawn)
 */
public class RedisSafetyRule implements SecurityRule {

    public static final RedisSafetyRule INSTANCE = new RedisSafetyRule();

    private static final Pattern PATTERN_FLUSH =
            Pattern.compile("(FLUSHALL|FLUSHDB|flushAll\\s*\\(|flushDb\\s*\\()", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_KEYS =
            Pattern.compile("(\\bKEYS\\s+\\*|\\.keys\\s*\\()", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_SHUTDOWN =
            Pattern.compile("(\\bSHUTDOWN\\b|\\.shutdown\\s*\\()", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_CONFIG =
            Pattern.compile("\\bCONFIG\\s+(SET|REWRITE|RESETSTAT)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_REPLICATION =
            Pattern.compile("\\b(SLAVEOF|REPLICAOF)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_MONITOR =
            Pattern.compile("(\\bMONITOR\\b|\\.monitor\\s*\\()", Pattern.CASE_INSENSITIVE);

    @Override
    public String getName() {
        return "REDIS_SAFETY";
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        RuleResult r1 = checkFlushAllDb(scriptSource);
        if (r1.isFailed()) return r1;

        RuleResult r2 = checkKeysPattern(scriptSource);
        if (r2.isFailed()) return r2;

        RuleResult r3 = checkShutdown(scriptSource);
        if (r3.isFailed()) return r3;

        RuleResult r4 = checkConfigTampering(scriptSource);
        if (r4.isFailed()) return r4;

        RuleResult r5 = checkReplicationTampering(scriptSource);
        if (r5.isFailed()) return r5;

        RuleResult r6 = checkMonitor(scriptSource);
        if (r6.isFailed()) return r6;

        return RuleResult.pass();
    }

    // ─── Atomic Static Check Methods (Single Responsibility Principle) ───────

    public static RuleResult checkFlushAllDb(String scriptSource) {
        if (scriptSource != null && PATTERN_FLUSH.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Executing FLUSHALL / FLUSHDB is strictly forbidden to prevent Redis cache wipe.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkKeysPattern(String scriptSource) {
        if (scriptSource != null && PATTERN_KEYS.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Executing KEYS * or .keys() is forbidden because it blocks Redis single thread. Use SCAN instead.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkShutdown(String scriptSource) {
        if (scriptSource != null && PATTERN_SHUTDOWN.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Executing Redis SHUTDOWN command is strictly forbidden.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkConfigTampering(String scriptSource) {
        if (scriptSource != null && PATTERN_CONFIG.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Tampering with Redis CONFIG SET / REWRITE is strictly forbidden.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkReplicationTampering(String scriptSource) {
        if (scriptSource != null && PATTERN_REPLICATION.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Executing Redis SLAVEOF / REPLICAOF replication commands is strictly forbidden.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkMonitor(String scriptSource) {
        if (scriptSource != null && PATTERN_MONITOR.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Executing Redis MONITOR command is strictly forbidden in production.");
        }
        return RuleResult.pass();
    }
}
