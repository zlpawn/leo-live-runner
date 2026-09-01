package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * HTTP and OpenFeign client write operation safety inspection rules.
 * When in read-only mode, intercepts HTTP write mutations (PUT, DELETE, PATCH, and write POSTs),
 * while allowing GET queries and complex JSON POST queries (e.g., queryList, getBattery, search).
 *
 * @author Leo (zlpawn)
 */
public class HttpSafetyRule implements SecurityRule {

    public static final HttpSafetyRule INSTANCE = new HttpSafetyRule();

    private final java.util.function.BooleanSupplier readOnlyModeSupplier;

    public HttpSafetyRule() {
        this(true);
    }

    public HttpSafetyRule(boolean readOnlyMode) {
        this(() -> readOnlyMode);
    }

    public HttpSafetyRule(java.util.function.BooleanSupplier readOnlyModeSupplier) {
        this.readOnlyModeSupplier = readOnlyModeSupplier != null ? readOnlyModeSupplier : () -> true;
    }

    public boolean isReadOnlyMode() {
        return readOnlyModeSupplier != null && readOnlyModeSupplier.getAsBoolean();
    }

    // Explicit HTTP mutation methods / annotations (PUT, DELETE, PATCH, HttpPost, etc.)
    private static final Pattern PATTERN_STRICT_HTTP_WRITES = Pattern.compile(
            "(\\.(put|delete|patchForObject|patch)\\s*\\()|" +
            "(new\\s+(HttpPost|HttpPut|HttpDelete|HttpPatch)\\s*\\()|" +
            "(\\bHttpMethod\\s*\\.\\s*(PUT|DELETE|PATCH)\\b)|" +
            "(setRequestMethod\\s*\\(\\s*\"(PUT|DELETE|PATCH)\"\\s*\\))|" +
            "(@(PutMapping|DeleteMapping|PatchMapping)\\b)",
            Pattern.CASE_INSENSITIVE
    );

    // POST calls and annotations
    private static final Pattern PATTERN_HTTP_POST = Pattern.compile(
            "(\\.(postForObject|postForEntity|postForLocation)\\s*\\([^)]*\\)|" +
            "\\.(post)\\s*\\(|" +
            "new\\s+Request\\.Builder\\s*\\([^)]*\\)\\s*\\.\\s*post\\s*\\(|" +
            "@PostMapping(\\s*\\([^)]*\\))?|" +
            "setRequestMethod\\s*\\(\\s*\"POST\"\\s*\\)|" +
            "\\bHttpMethod\\s*\\.\\s*POST\\b)",
            Pattern.CASE_INSENSITIVE
    );

    // Query semantic keywords that designate a POST as a safe read-only query
    private static final Pattern PATTERN_QUERY_KEYWORDS = Pattern.compile(
            "(query|find|search|list|count|select|obtain|detail|summary|fetch|page|report|view)",
            Pattern.CASE_INSENSITIVE
    );

    @Override
    public String getName() {
        return SecurityRuleType.HTTP_SAFETY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty() || !isReadOnlyMode()) {
            return RuleResult.pass();
        }

        return checkHttpWriteOperation(scriptSource);
    }

    public static RuleResult checkHttpWriteOperation(String scriptSource) {
        if (scriptSource == null) {
            return RuleResult.pass();
        }

        // 1. Strict write methods (PUT, DELETE, PATCH, etc.)
        if (PATTERN_STRICT_HTTP_WRITES.matcher(scriptSource).find()) {
            return RuleResult.fail("Read-Only Violation: HTTP write operations (PUT, DELETE, PATCH) are strictly forbidden in read-only mode.");
        }

        // 2. Inspect POST invocations: check if they have query semantics in the invocation line/snippet
        Matcher postMatcher = PATTERN_HTTP_POST.matcher(scriptSource);
        while (postMatcher.find()) {
            int start = Math.max(0, postMatcher.start() - 50);
            int end = Math.min(scriptSource.length(), postMatcher.end() + 80);
            String snippet = scriptSource.substring(start, end);
            if (!PATTERN_QUERY_KEYWORDS.matcher(snippet).find()) {
                return RuleResult.fail("Read-Only Violation: HTTP POST write operation detected. In read-only mode, only GET and query-designated POST requests (query/find/search/list/detail/page) are allowed.");
            }
        }

        return RuleResult.pass();
    }
}
