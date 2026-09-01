package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SQL DML safety inspection rules (inspired by Alibaba Druid WallFilter).
 * 1. Requires WHERE clause on DELETE statements.
 * 2. Requires WHERE clause on UPDATE statements.
 * 3. Blocks 1=1, '1'='1', OR 1=1 tautology SQL injection patterns.
 * 4. Checks SELECT queries without WHERE or LIMIT.
 *
 * @author Leo (zlpawn)
 */
public class SqlSafetyRule implements SecurityRule {

    public static final SqlSafetyRule INSTANCE = new SqlSafetyRule();

    private final java.util.function.BooleanSupplier allowMissingWhereSupplier;
    private final java.util.function.BooleanSupplier readOnlyModeSupplier;

    public SqlSafetyRule() {
        this(false, true);
    }

    public SqlSafetyRule(boolean allowMissingWhere) {
        this(allowMissingWhere, true);
    }

    public SqlSafetyRule(boolean allowMissingWhere, boolean readOnlyMode) {
        this(() -> allowMissingWhere, () -> readOnlyMode);
    }

    public SqlSafetyRule(boolean allowMissingWhere, java.util.function.BooleanSupplier readOnlyModeSupplier) {
        this(() -> allowMissingWhere, readOnlyModeSupplier);
    }

    public SqlSafetyRule(java.util.function.BooleanSupplier allowMissingWhereSupplier, java.util.function.BooleanSupplier readOnlyModeSupplier) {
        this.allowMissingWhereSupplier = allowMissingWhereSupplier != null ? allowMissingWhereSupplier : () -> false;
        this.readOnlyModeSupplier = readOnlyModeSupplier != null ? readOnlyModeSupplier : () -> true;
    }

    public boolean isAllowMissingWhere() {
        return allowMissingWhereSupplier != null && allowMissingWhereSupplier.getAsBoolean();
    }

    public boolean isReadOnlyMode() {
        return readOnlyModeSupplier != null && readOnlyModeSupplier.getAsBoolean();
    }

    // Regex to match raw SQL write operations (INSERT, UPDATE, DELETE, REPLACE, MERGE, UPSERT)
    private static final Pattern PATTERN_SQL_WRITE =
            Pattern.compile("(?i)\\b(INSERT\\s+(INTO|IGNORE)?|UPDATE\\s+[a-zA-Z0-9_`]+\\s+SET|DELETE\\s+FROM|REPLACE\\s+INTO|MERGE\\s+INTO|UPSERT\\s+INTO)\\b", Pattern.CASE_INSENSITIVE);

    // Regex to match common DAO / Mapper / JdbcTemplate write methods
    private static final Pattern PATTERN_CODE_SQL_WRITE =
            Pattern.compile("(\\.(insert|update|delete|deleteById|updateById|save|saveBatch|saveOrUpdate|batchUpdate)\\s*\\()", Pattern.CASE_INSENSITIVE);

    // Regex to match raw SQL DELETE statements
    private static final Pattern PATTERN_DELETE =
            Pattern.compile("(?i)\\bDELETE\\s+FROM\\s+([a-zA-Z0-9_`]+)(?:\\s+WHERE\\b|\\s*(?:;|\"|'|\\)))?", Pattern.CASE_INSENSITIVE);

    // Regex to match raw SQL UPDATE statements
    private static final Pattern PATTERN_UPDATE =
            Pattern.compile("(?i)\\bUPDATE\\s+([a-zA-Z0-9_`]+)\\s+SET\\s+([^\";']+)", Pattern.CASE_INSENSITIVE);

    // Regex for tautological SQL injection bypasses
    private static final Pattern PATTERN_SQL_INJECTION =
            Pattern.compile("(?i)\\b(OR\\s+)?(?:1\\s*=\\s*1|'1'\\s*=\\s*'1'|'a'\\s*=\\s*'a'|0\\s*=\\s*0|true\\s*=\\s*true)\\b", Pattern.CASE_INSENSITIVE);

    // Regex for SELECT without WHERE or LIMIT
    private static final Pattern PATTERN_SELECT_NO_WHERE_LIMIT =
            Pattern.compile("(?i)\\bSELECT\\s+.+?\\s+FROM\\s+([a-zA-Z0-9_`]+)(?!.*\\b(WHERE|LIMIT)\\b)", Pattern.CASE_INSENSITIVE);

    @Override
    public String getName() {
        return SecurityRuleType.SQL_DML_SAFETY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        // 1. In read-only mode: block all mutation operations (INSERT, UPDATE, DELETE, etc.)
        if (isReadOnlyMode()) {
            RuleResult writeResult = checkSqlWriteOperation(scriptSource);
            if (writeResult.isFailed()) {
                return writeResult;
            }
        }

        // 2. Base SQL injection check
        RuleResult r1 = checkSqlInjectionAlwaysTrue(scriptSource);
        if (r1.isFailed()) return r1;

        // 3. If not in readOnlyMode (and allowMissingWhere=false), enforce WHERE clause
        if (!isReadOnlyMode() && !isAllowMissingWhere()) {
            RuleResult r2 = checkDeleteMissingWhere(scriptSource);
            if (r2.isFailed()) return r2;

            RuleResult r3 = checkUpdateMissingWhere(scriptSource);
            if (r3.isFailed()) return r3;
        }

        return RuleResult.pass();
    }

    /**
     * Inspect script for any SQL or ORM write/mutation operations in read-only mode.
     */
    public static RuleResult checkSqlWriteOperation(String scriptSource) {
        if (scriptSource == null) return RuleResult.pass();

        if (PATTERN_SQL_WRITE.matcher(scriptSource).find() || PATTERN_CODE_SQL_WRITE.matcher(scriptSource).find()) {
            return RuleResult.fail("Read-Only Violation: SQL write operations (INSERT, UPDATE, DELETE, REPLACE) are strictly forbidden in read-only mode. Only SELECT queries are allowed.");
        }
        return RuleResult.pass();
    }

    // ─── Atomic Static Check Methods (Single Responsibility Principle) ───────

    /**
     * Inspect DELETE statements to ensure a WHERE clause is explicitly present.
     */
    public static RuleResult checkDeleteMissingWhere(String scriptSource) {
        if (scriptSource == null) return RuleResult.pass();

        // Scan for DELETE FROM
        Matcher matcher = Pattern.compile("(?i)\\bDELETE\\s+FROM\\s+([a-zA-Z0-9_`]+)([^;\"']*)").matcher(scriptSource);
        while (matcher.find()) {
            String clauseAfterTable = matcher.group(2);
            if (clauseAfterTable == null || !clauseAfterTable.toUpperCase().contains("WHERE")) {
                return RuleResult.fail("SQL Safety Violation: DELETE statement on table [" + matcher.group(1) +
                        "] must explicitly include a WHERE clause to prevent full table truncation.");
            }
        }
        return RuleResult.pass();
    }

    /**
     * Inspect UPDATE statements to ensure a WHERE clause is explicitly present.
     */
    public static RuleResult checkUpdateMissingWhere(String scriptSource) {
        if (scriptSource == null) return RuleResult.pass();

        // Scan for UPDATE <table> SET <assignments>
        Matcher matcher = Pattern.compile("(?i)\\bUPDATE\\s+([a-zA-Z0-9_`]+)\\s+SET\\s+([^;\"']*)").matcher(scriptSource);
        while (matcher.find()) {
            String clauseAfterSet = matcher.group(2);
            if (clauseAfterSet == null || !clauseAfterSet.toUpperCase().contains("WHERE")) {
                return RuleResult.fail("SQL Safety Violation: UPDATE statement on table [" + matcher.group(1) +
                        "] must explicitly include a WHERE clause to prevent full table modification.");
            }
        }
        return RuleResult.pass();
    }

    /**
     * Inspect SQL text for tautological injection bypasses like 1=1 or OR 1=1.
     */
    public static RuleResult checkSqlInjectionAlwaysTrue(String scriptSource) {
        if (scriptSource != null && PATTERN_SQL_INJECTION.matcher(scriptSource).find()) {
            return RuleResult.fail("SQL Safety Violation: Detected tautological SQL injection pattern (e.g. 1=1, '1'='1', OR 1=1).");
        }
        return RuleResult.pass();
    }

    /**
     * Inspect SELECT queries without WHERE or LIMIT clause.
     */
    public static RuleResult checkSelectMissingLimitAndWhere(String scriptSource) {
        if (scriptSource == null) return RuleResult.pass();

        Matcher matcher = Pattern.compile("(?i)\\bSELECT\\s+([^;\"']+)\\s+FROM\\s+([a-zA-Z0-9_`]+)([^;\"']*)").matcher(scriptSource);
        while (matcher.find()) {
            String rest = matcher.group(3);
            String upper = rest != null ? rest.toUpperCase() : "";
            if (!upper.contains("WHERE") && !upper.contains("LIMIT")) {
                return RuleResult.fail("SQL Safety Warning: SELECT query on table [" + matcher.group(2) +
                        "] has no WHERE filter and no LIMIT pagination specified.");
            }
        }
        return RuleResult.pass();
    }
}
