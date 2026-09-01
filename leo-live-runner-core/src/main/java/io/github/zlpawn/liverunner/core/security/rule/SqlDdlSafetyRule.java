package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Pattern;

/**
 * SQL DDL and schema/privilege safety inspection rules (inspired by Alibaba Druid WallFilter).
 * Strictly forbids dynamic scripts from performing DROP, TRUNCATE, ALTER, or GRANT/REVOKE operations in production.
 *
 * @author Leo (zlpawn)
 */
public class SqlDdlSafetyRule implements SecurityRule {

    public static final SqlDdlSafetyRule INSTANCE = new SqlDdlSafetyRule();

    private final java.util.function.BooleanSupplier allowDdlSupplier;

    public SqlDdlSafetyRule() {
        this(false);
    }

    public SqlDdlSafetyRule(boolean allowDdl) {
        this(() -> allowDdl);
    }

    public SqlDdlSafetyRule(java.util.function.BooleanSupplier allowDdlSupplier) {
        this.allowDdlSupplier = allowDdlSupplier != null ? allowDdlSupplier : () -> false;
    }

    public boolean isAllowDdl() {
        return allowDdlSupplier != null && allowDdlSupplier.getAsBoolean();
    }

    private static final Pattern PATTERN_DROP =
            Pattern.compile("(?i)\\bDROP\\s+(DATABASE|SCHEMA|TABLE|INDEX|VIEW|TRIGGER|PROCEDURE|FUNCTION)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_TRUNCATE =
            Pattern.compile("(?i)\\bTRUNCATE\\s+(TABLE\\s+)?([a-zA-Z0-9_`]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_ALTER =
            Pattern.compile("(?i)\\b(ALTER\\s+(TABLE|DATABASE|SCHEMA)|RENAME\\s+TABLE)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_PRIVILEGES =
            Pattern.compile("(?i)\\b(GRANT\\s+.+\\s+TO|REVOKE\\s+.+\\s+FROM|(CREATE|DROP|ALTER)\\s+USER)\\b", Pattern.CASE_INSENSITIVE);

    @Override
    public String getName() {
        return SecurityRuleType.SQL_DDL_SAFETY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty() || isAllowDdl()) {
            return RuleResult.pass();
        }

        RuleResult r1 = checkDropOperations(scriptSource);
        if (r1.isFailed()) return r1;

        RuleResult r2 = checkTruncateOperations(scriptSource);
        if (r2.isFailed()) return r2;

        RuleResult r3 = checkAlterOperations(scriptSource);
        if (r3.isFailed()) return r3;

        RuleResult r4 = checkGrantRevokeOperations(scriptSource);
        if (r4.isFailed()) return r4;

        return RuleResult.pass();
    }

    // ─── Atomic Static Check Methods (Single Responsibility Principle) ───────

    public static RuleResult checkDropOperations(String scriptSource) {
        if (scriptSource != null && PATTERN_DROP.matcher(scriptSource).find()) {
            return RuleResult.fail("SQL DDL Violation: Executing DROP DATABASE/TABLE/INDEX is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkTruncateOperations(String scriptSource) {
        if (scriptSource != null && PATTERN_TRUNCATE.matcher(scriptSource).find()) {
            return RuleResult.fail("SQL DDL Violation: Executing TRUNCATE TABLE is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkAlterOperations(String scriptSource) {
        if (scriptSource != null && PATTERN_ALTER.matcher(scriptSource).find()) {
            return RuleResult.fail("SQL DDL Violation: Executing ALTER TABLE or RENAME TABLE is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkGrantRevokeOperations(String scriptSource) {
        if (scriptSource != null && PATTERN_PRIVILEGES.matcher(scriptSource).find()) {
            return RuleResult.fail("SQL DDL Violation: Modifying database user privileges via GRANT/REVOKE/CREATE USER is strictly forbidden.");
        }
        return RuleResult.pass();
    }
}
