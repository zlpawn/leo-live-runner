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
                ThreadSecurityRule.INSTANCE,
                SpringConfigSecurityRule.INSTANCE,
                RedisSafetyRule.INSTANCE,
                SqlSafetyRule.INSTANCE,
                SqlDdlSafetyRule.INSTANCE
        ));
    }

    public DefaultSecurityCheckerValidator(List<SecurityRule> initialRules) {
        if (initialRules != null) {
            this.rules.addAll(initialRules);
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
