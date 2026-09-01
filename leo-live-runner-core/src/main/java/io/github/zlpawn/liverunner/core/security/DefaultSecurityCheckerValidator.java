package io.github.zlpawn.liverunner.core.security;

import io.github.zlpawn.liverunner.core.security.rule.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Default rule container implementation of {@link LiveRunnerCodeValidator}.
 * Loads all standard security rules out of the box (System, Thread, Spring Config, Redis, SQL DML, SQL DDL).
 * Allows dynamic addition and removal of security rules.
 *
 * @author Leo (zlpawn)
 */
public class DefaultSecurityCheckerValidator implements LiveRunnerCodeValidator {

    private final List<SecurityRule> rules = new CopyOnWriteArrayList<>();

    public DefaultSecurityCheckerValidator() {
        this(Arrays.asList(
                SystemSecurityRule.INSTANCE,
                AstSandboxSecurityRule.INSTANCE,
                ThreadSecurityRule.INSTANCE,
                SpringConfigSecurityRule.INSTANCE,
                RedisSafetyRule.INSTANCE,
                SqlSafetyRule.INSTANCE,
                SqlDdlSafetyRule.INSTANCE,
                MqSafetyRule.INSTANCE,
                HttpSafetyRule.INSTANCE
        ));
    }

    public DefaultSecurityCheckerValidator(List<SecurityRule> initialRules) {
        if (initialRules != null) {
            this.rules.addAll(initialRules);
        }
    }

    public static List<SecurityRule> createDefaultRules(boolean allowDdl, boolean allowMissingWhere, boolean allowDangerousKeys, boolean allowProcessExec) {
        return createDefaultRules(true, allowDdl, allowMissingWhere, allowDangerousKeys, allowProcessExec);
    }

    public static List<SecurityRule> createDefaultRules(boolean readOnlyMode, boolean allowDdl, boolean allowMissingWhere, boolean allowDangerousKeys, boolean allowProcessExec) {
        return createDefaultRules(() -> readOnlyMode, allowDdl, allowMissingWhere, allowDangerousKeys, allowProcessExec);
    }

    public static List<SecurityRule> createDefaultRules(java.util.function.BooleanSupplier readOnlyModeSupplier, boolean allowDdl, boolean allowMissingWhere, boolean allowDangerousKeys, boolean allowProcessExec) {
        return createDefaultRules(readOnlyModeSupplier, () -> allowDdl, () -> allowMissingWhere, () -> allowDangerousKeys, () -> allowProcessExec);
    }

    public static List<SecurityRule> createDefaultRules(
            java.util.function.BooleanSupplier readOnlyModeSupplier,
            java.util.function.BooleanSupplier allowDdlSupplier,
            java.util.function.BooleanSupplier allowMissingWhereSupplier,
            java.util.function.BooleanSupplier allowDangerousKeysSupplier,
            java.util.function.BooleanSupplier allowProcessExecSupplier) {
        return Arrays.asList(
                new SystemSecurityRule(allowProcessExecSupplier),
                new AstSandboxSecurityRule(allowProcessExecSupplier),
                ThreadSecurityRule.INSTANCE,
                SpringConfigSecurityRule.INSTANCE,
                new RedisSafetyRule(allowDangerousKeysSupplier, readOnlyModeSupplier),
                new SqlSafetyRule(allowMissingWhereSupplier, readOnlyModeSupplier),
                new SqlDdlSafetyRule(allowDdlSupplier),
                new MqSafetyRule(readOnlyModeSupplier),
                new HttpSafetyRule(readOnlyModeSupplier)
        );
    }

    public void reloadRules(List<SecurityRule> newRules) {
        this.rules.clear();
        if (newRules != null) {
            this.rules.addAll(newRules);
        }
    }

    @Override
    public CodeValidationResult validate(String scriptKey, String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return CodeValidationResult.allow();
        }

        for (SecurityRule rule : rules) {
            RuleResult result = rule.check(scriptSource);
            if (result != null && result.isFailed()) {
                return CodeValidationResult.deny("Security Violation [" + rule.getName() + "]: " + result.getReason());
            }
        }

        return CodeValidationResult.allow();
    }

    /**
     * Add a custom security rule to the validator.
     */
    public DefaultSecurityCheckerValidator addRule(SecurityRule rule) {
        if (rule != null) {
            this.rules.add(rule);
        }
        return this;
    }

    /**
     * Remove a security rule by name.
     */
    public boolean removeRule(String ruleName) {
        if (ruleName == null) return false;
        return this.rules.removeIf(r -> ruleName.equalsIgnoreCase(r.getName()));
    }

    /**
     * Remove a security rule by rule type enum.
     */
    public boolean removeRule(SecurityRuleType ruleType) {
        if (ruleType == null) return false;
        return removeRule(ruleType.getCode());
    }

    /**
     * Get an unmodifiable view of current active rules.
     */
    public List<SecurityRule> getRules() {
        return Collections.unmodifiableList(new ArrayList<>(this.rules));
    }

    /**
     * Clear all rules.
     */
    public void clearRules() {
        this.rules.clear();
    }
}
