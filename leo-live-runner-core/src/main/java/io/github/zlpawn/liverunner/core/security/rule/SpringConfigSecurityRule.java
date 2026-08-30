package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Pattern;

/**
 * Spring container and runtime environment configuration security rules.
 * Protects Spring Environment, PropertySources, BeanFactory, and System properties from
 * malicious modification or deletion by dynamic scripts.
 *
 * @author Leo (zlpawn)
 */
public class SpringConfigSecurityRule implements SecurityRule {

    public static final SpringConfigSecurityRule INSTANCE = new SpringConfigSecurityRule();

    private static final Pattern PATTERN_ENV_TAMPERING =
            Pattern.compile("getPropertySources\\s*\\(\\s*\\)\\s*\\.\\s*(remove|addFirst|addLast|replace|clear)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_BEAN_FACTORY_TAMPERING =
            Pattern.compile("(destroySingleton|removeBeanDefinition|destroyBean|destroySingletons)\\s*\\(", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_SYSTEM_PROPERTIES =
            Pattern.compile("System\\s*\\.\\s*(setProperty|clearProperty)\\s*\\(|System\\s*\\.\\s*getProperties\\s*\\(\\s*\\)\\s*\\.\\s*(put|remove|clear|setProperty)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PATTERN_CONTEXT_LIFECYCLE =
            Pattern.compile("(ConfigurableApplicationContext|AbstractApplicationContext)\\s*\\.[^;]*\\.(close|stop|refresh)\\s*\\(", Pattern.CASE_INSENSITIVE);

    @Override
    public String getName() {
        return SecurityRuleType.SPRING_CONFIG_SECURITY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        RuleResult r1 = checkEnvironmentTampering(scriptSource);
        if (r1.isFailed()) return r1;

        RuleResult r2 = checkBeanFactoryTampering(scriptSource);
        if (r2.isFailed()) return r2;

        RuleResult r3 = checkSystemPropertiesTampering(scriptSource);
        if (r3.isFailed()) return r3;

        RuleResult r4 = checkContextLifecycle(scriptSource);
        if (r4.isFailed()) return r4;

        return RuleResult.pass();
    }

    // ─── Atomic Static Check Methods (Single Responsibility Principle) ───────

    public static RuleResult checkEnvironmentTampering(String scriptSource) {
        if (scriptSource != null && PATTERN_ENV_TAMPERING.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Dynamic scripts are forbidden from modifying Spring PropertySources / Environment configuration.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkBeanFactoryTampering(String scriptSource) {
        if (scriptSource != null && PATTERN_BEAN_FACTORY_TAMPERING.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Dynamic scripts are forbidden from destroying or removing Spring Bean definitions.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkSystemPropertiesTampering(String scriptSource) {
        if (scriptSource != null && PATTERN_SYSTEM_PROPERTIES.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Tampering with System.setProperty / clearProperty is strictly forbidden in Live Runner.");
        }
        return RuleResult.pass();
    }

    public static RuleResult checkContextLifecycle(String scriptSource) {
        if (scriptSource != null && PATTERN_CONTEXT_LIFECYCLE.matcher(scriptSource).find()) {
            return RuleResult.fail("Security Violation: Closing or stopping Spring ApplicationContext is strictly forbidden.");
        }
        return RuleResult.pass();
    }
}
