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

    private final java.util.function.BooleanSupplier allowDangerousKeysSupplier;
    private final java.util.function.BooleanSupplier readOnlyModeSupplier;

    public RedisSafetyRule() {
        this(false, true);
    }

    public RedisSafetyRule(boolean allowDangerousKeys) {
        this(allowDangerousKeys, true);
    }

    public RedisSafetyRule(boolean allowDangerousKeys, boolean readOnlyMode) {
        this(() -> allowDangerousKeys, () -> readOnlyMode);
    }

    public RedisSafetyRule(boolean allowDangerousKeys, java.util.function.BooleanSupplier readOnlyModeSupplier) {
        this(() -> allowDangerousKeys, readOnlyModeSupplier);
    }

    public RedisSafetyRule(java.util.function.BooleanSupplier allowDangerousKeysSupplier, java.util.function.BooleanSupplier readOnlyModeSupplier) {
        this.allowDangerousKeysSupplier = allowDangerousKeysSupplier != null ? allowDangerousKeysSupplier : () -> false;
        this.readOnlyModeSupplier = readOnlyModeSupplier != null ? readOnlyModeSupplier : () -> true;
    }

    public boolean isAllowDangerousKeys() {
        return allowDangerousKeysSupplier != null && allowDangerousKeysSupplier.getAsBoolean();
    }

    public boolean isReadOnlyMode() {
        return readOnlyModeSupplier != null && readOnlyModeSupplier.getAsBoolean();
    }

    // Regex to match Redis write / modification methods
    private static final Pattern PATTERN_REDIS_WRITE =
            Pattern.compile("(\\.(set|setEx|setIfAbsent|delete|unlink|expire|expireAt|persist|hset|hSet|hdel|hDel|hMSet|hIncrBy|hIncrByFloat|lpush|rpush|lpop|rpop|lset|ltrim|zadd|zrem|zremrangeByRank|zremrangeByScore|zincrby|increment|decrement|add|remove|pop|move|rename|renameIfAbsent|getAndSet|getAndDelete|getAndExpire)\\s*\\()", Pattern.CASE_INSENSITIVE);

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
        return SecurityRuleType.REDIS_SAFETY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        // 1. Read-only mode check for mutation methods
        if (isReadOnlyMode()) {
            RuleResult writeResult = checkRedisWriteOperation(scriptSource);
            if (writeResult.isFailed()) {
                return writeResult;
            }
        }

        if (isAllowDangerousKeys()) {
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

    /**
     * Inspect script for any Redis write/mutation operations in read-only mode.
     */
    public static RuleResult checkRedisWriteOperation(String scriptSource) {
        if (scriptSource != null && PATTERN_REDIS_WRITE.matcher(scriptSource).find()) {
            return RuleResult.fail("Read-Only Violation: Redis write/mutation operations (set, delete, expire, hset, lpush, zadd, etc.) are strictly forbidden in read-only mode. Only read operations (get, mget, hget, lrange, zrange, etc.) are allowed.");
        }
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
