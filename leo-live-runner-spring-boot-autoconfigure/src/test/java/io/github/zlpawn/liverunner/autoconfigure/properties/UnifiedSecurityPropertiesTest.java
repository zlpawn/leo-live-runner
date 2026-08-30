package io.github.zlpawn.liverunner.autoconfigure.properties;

import io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator;
import io.github.zlpawn.liverunner.core.security.rule.SecurityRule;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class UnifiedSecurityPropertiesTest {

    @Test
    void testDefaultSecurityPropertiesValues() {
        LiveRunnerProperties properties = new LiveRunnerProperties();

        assertTrue(properties.isEnabled());
        assertTrue(properties.isSecurityCheckEnabled());
        assertEquals(60, properties.getDefaultTimeoutSeconds());

        // Thread pool defaults
        assertEquals(2, properties.getCorePoolSize());
        assertEquals(10, properties.getMaxPoolSize());
        assertEquals(200, properties.getQueueCapacity());
        assertEquals(60, properties.getKeepAliveSeconds());
        assertEquals(RejectionPolicyType.CALLER_RUNS, properties.getRejectionPolicy());

        // Security defaults
        LiveRunnerProperties.Security sec = properties.getSecurity();
        assertNotNull(sec);
        assertTrue(sec.isEnabled());
        assertNotNull(sec.getDeniedBeans());
        assertTrue(sec.getDeniedBeans().isEmpty(), "deniedBeans must default to empty list []");
        assertEquals(1, sec.getAllowedPackages().size());
        assertEquals("*", sec.getAllowedPackages().get(0));

        // SQL defaults (allow-xxx: false, limits: 500)
        LiveRunnerProperties.SqlSecurity sql = sec.getSql();
        assertNotNull(sql);
        assertFalse(sql.isAllowDdl(), "allowDdl must default to false");
        assertFalse(sql.isAllowMissingWhere(), "allowMissingWhere must default to false");
        assertEquals(500, sql.getMaxAffectedRows());
        assertEquals(500, sql.getMaxQueryRows());

        // Redis defaults (allow-xxx: false)
        LiveRunnerProperties.RedisSecurity redis = sec.getRedis();
        assertNotNull(redis);
        assertFalse(redis.isAllowDangerousKeys(), "allowDangerousKeys must default to false");

        // System defaults (allow-xxx: false)
        LiveRunnerProperties.SystemSecurity sys = sec.getSystem();
        assertNotNull(sys);
        assertFalse(sys.isAllowProcessExec(), "allowProcessExec must default to false");
        assertFalse(sys.isAllowSystemExit(), "allowSystemExit must default to false");
    }

    @Test
    void testRuleGenerationFromProperties() {
        LiveRunnerProperties properties = new LiveRunnerProperties();
        properties.getSecurity().getSql().setAllowDdl(true);
        properties.getSecurity().getSql().setAllowMissingWhere(true);
        properties.getSecurity().getRedis().setAllowDangerousKeys(true);
        properties.getSecurity().getSystem().setAllowProcessExec(true);

        List<SecurityRule> rules = DefaultSecurityCheckerValidator.createDefaultRules(
                properties.getSecurity().getSql().isAllowDdl(),
                properties.getSecurity().getSql().isAllowMissingWhere(),
                properties.getSecurity().getRedis().isAllowDangerousKeys(),
                properties.getSecurity().getSystem().isAllowProcessExec()
        );

        DefaultSecurityCheckerValidator validator = new DefaultSecurityCheckerValidator(rules);

        // Should pass DDL and missing where when allowed
        assertTrue(validator.validate("test", "DROP TABLE user;").isAllowed());
        assertTrue(validator.validate("test", "DELETE FROM user;").isAllowed());
        assertTrue(validator.validate("test", "redis.flushAll();").isAllowed());
        assertTrue(validator.validate("test", "Runtime.getRuntime().exec(\"ls\");").isAllowed());
    }
}