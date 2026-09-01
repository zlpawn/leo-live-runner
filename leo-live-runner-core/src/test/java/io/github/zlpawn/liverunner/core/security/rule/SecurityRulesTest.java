package io.github.zlpawn.liverunner.core.security.rule;

import io.github.zlpawn.liverunner.core.security.CodeValidationResult;
import io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

public class SecurityRulesTest {

    @Test
    public void testSystemSecurityRule() {
        // System.exit
        RuleResult r1 = SystemSecurityRule.INSTANCE.check("public class Test { void run() { System.exit(0); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertFalse(r1.isPassed());
        Assertions.assertTrue(r1.getReason().contains("System.exit"));

        // Runtime.exec
        RuleResult r2 = SystemSecurityRule.INSTANCE.check("public class Test { void run() { Runtime.getRuntime().exec(\"ls\"); } }");
        Assertions.assertTrue(r2.isFailed());

        // ProcessBuilder
        RuleResult r3 = SystemSecurityRule.INSTANCE.check("public class Test { void run() { new ProcessBuilder(\"cmd\").start(); } }");
        Assertions.assertTrue(r3.isFailed());

        // Unsafe
        RuleResult r4 = SystemSecurityRule.INSTANCE.check("import sun.misc.Unsafe; public class Test {}");
        Assertions.assertTrue(r4.isFailed());

        // Safe code
        RuleResult rSafe = SystemSecurityRule.INSTANCE.check("public class Test { public String run() { return \"HELLO\"; } }");
        Assertions.assertTrue(rSafe.isPassed());
        Assertions.assertFalse(rSafe.isFailed());
    }

    @Test
    public void testThreadSecurityRule() {
        // Thread.stop()
        RuleResult r1 = ThreadSecurityRule.INSTANCE.check("public class Test { void run() { Thread.currentThread().stop(); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertTrue(r1.getReason().contains("Thread.stop()"));

        // Thread.suspend()
        RuleResult r2 = ThreadSecurityRule.INSTANCE.check("public class Test { void run() { Thread.currentThread().suspend(); } }");
        Assertions.assertTrue(r2.isFailed());

        // Safe thread usage
        RuleResult rSafe = ThreadSecurityRule.INSTANCE.check("public class Test { void run() { Thread.sleep(100); } }");
        Assertions.assertTrue(rSafe.isPassed());
    }

    @Test
    public void testSpringConfigSecurityRule() {
        // Tamper Environment PropertySources
        RuleResult r1 = SpringConfigSecurityRule.INSTANCE.check("public class Test { void run(org.springframework.core.env.ConfigurableEnvironment env) { env.getPropertySources().remove(\"bootstrap\"); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertTrue(r1.getReason().contains("PropertySources"));

        // Tamper BeanFactory / destroy bean
        RuleResult r2 = SpringConfigSecurityRule.INSTANCE.check("public class Test { void run(org.springframework.beans.factory.support.DefaultListableBeanFactory bf) { bf.destroySingleton(\"myService\"); } }");
        Assertions.assertTrue(r2.isFailed());
        Assertions.assertTrue(r2.getReason().contains("destroying or removing Spring Bean"));

        // System.setProperty
        RuleResult r3 = SpringConfigSecurityRule.INSTANCE.check("public class Test { void run() { System.setProperty(\"app.env\", \"prod\"); } }");
        Assertions.assertTrue(r3.isFailed());

        // Safe Spring bean usage
        RuleResult rSafe = SpringConfigSecurityRule.INSTANCE.check("public class Test { private OrderService orderService; public void run() { orderService.query(); } }");
        Assertions.assertTrue(rSafe.isPassed());
    }

    @Test
    public void testRedisSafetyRule() {
        // FLUSHALL / FLUSHDB
        RuleResult r1 = RedisSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.data.redis.core.StringRedisTemplate redis) { redis.getConnectionFactory().getConnection().flushAll(); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertTrue(r1.getReason().contains("FLUSHALL"));

        // KEYS *
        RuleResult r2 = RedisSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.data.redis.core.StringRedisTemplate redis) { redis.keys(\"*\"); } }");
        Assertions.assertTrue(r2.isFailed());
        Assertions.assertTrue(r2.getReason().contains("KEYS *"));

        // CONFIG SET
        RuleResult r3 = RedisSafetyRule.INSTANCE.check("public class Test { void run() { String cmd = \"CONFIG SET maxmemory 100mb\"; } }");
        Assertions.assertTrue(r3.isFailed());

        // SHUTDOWN
        RuleResult r4 = RedisSafetyRule.INSTANCE.check("public class Test { void run() { String cmd = \"SHUTDOWN\"; } }");
        Assertions.assertTrue(r4.isFailed());

        // Safe Redis usage (get / set)
        RuleResult rSafe = RedisSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.data.redis.core.StringRedisTemplate redis) { redis.opsForValue().get(\"order_1001\"); } }");
        Assertions.assertTrue(rSafe.isPassed());
    }

    @Test
    public void testSqlSafetyRuleDml() {
        SqlSafetyRule writeAllowedRule = new SqlSafetyRule(false, false);

        // DELETE without WHERE (in write-allowed mode)
        RuleResult r1 = writeAllowedRule.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.update(\"DELETE FROM t_order\"); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertTrue(r1.getReason().contains("DELETE statement on table [t_order] must explicitly include a WHERE clause"));

        // UPDATE without WHERE (in write-allowed mode)
        RuleResult r2 = writeAllowedRule.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.update(\"UPDATE t_account SET balance = 0\"); } }");
        Assertions.assertTrue(r2.isFailed());
        Assertions.assertTrue(r2.getReason().contains("UPDATE statement on table [t_account] must explicitly include a WHERE clause"));

        // 1=1 SQL Injection
        RuleResult r3 = writeAllowedRule.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.update(\"UPDATE t_account SET balance = 0 WHERE 1=1\"); } }");
        Assertions.assertTrue(r3.isFailed());
        Assertions.assertTrue(r3.getReason().contains("tautological SQL injection pattern"));

        // Valid DELETE with WHERE (in write-allowed mode)
        RuleResult r4 = writeAllowedRule.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.update(\"DELETE FROM t_order WHERE id = 1001\"); } }");
        Assertions.assertTrue(r4.isPassed());

        // Valid UPDATE with WHERE (in write-allowed mode)
        RuleResult r5 = writeAllowedRule.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.update(\"UPDATE t_account SET balance = balance - 100 WHERE id = 1\"); } }");
        Assertions.assertTrue(r5.isPassed());

        // Under default read-only instance, all UPDATE/DELETE are blocked
        RuleResult rReadOnly = SqlSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.update(\"UPDATE t_account SET balance = 0 WHERE id = 1\"); } }");
        Assertions.assertTrue(rReadOnly.isFailed());
        Assertions.assertTrue(rReadOnly.getReason().contains("Read-Only Violation"));
    }

    @Test
    public void testSqlDdlSafetyRule() {
        // DROP TABLE
        RuleResult r1 = SqlDdlSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.execute(\"DROP TABLE t_user\"); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertTrue(r1.getReason().contains("DROP DATABASE/TABLE/INDEX"));

        // TRUNCATE TABLE
        RuleResult r2 = SqlDdlSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.execute(\"TRUNCATE TABLE t_log\"); } }");
        Assertions.assertTrue(r2.isFailed());
        Assertions.assertTrue(r2.getReason().contains("TRUNCATE TABLE"));

        // ALTER TABLE
        RuleResult r3 = SqlDdlSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.execute(\"ALTER TABLE t_user ADD COLUMN age INT\"); } }");
        Assertions.assertTrue(r3.isFailed());
        Assertions.assertTrue(r3.getReason().contains("ALTER TABLE"));

        // GRANT privileges
        RuleResult r4 = SqlDdlSafetyRule.INSTANCE.check("public class Test { void run(org.springframework.jdbc.core.JdbcTemplate jt) { jt.execute(\"GRANT ALL PRIVILEGES ON *.* TO 'root'@'%'\"); } }");
        Assertions.assertTrue(r4.isFailed());
    }

    @Test
    public void testAstSandboxSecurityRule() {
        // System.exit
        RuleResult r1 = AstSandboxSecurityRule.INSTANCE.check("public class Test { void run() { System.exit(0); } }");
        Assertions.assertTrue(r1.isFailed());
        Assertions.assertTrue(r1.getReason().contains("AST Sandbox Violation"));

        // Runtime.getRuntime().exec
        RuleResult r2 = AstSandboxSecurityRule.INSTANCE.check("public class Test { void run() { Runtime.getRuntime().exec(\"calc\"); } }");
        Assertions.assertTrue(r2.isFailed());
        Assertions.assertTrue(r2.getReason().contains("AST Sandbox Violation"));

        // ProcessBuilder
        RuleResult r3 = AstSandboxSecurityRule.INSTANCE.check("public class Test { void run() { new ProcessBuilder(\"cmd\").start(); } }");
        Assertions.assertTrue(r3.isFailed());
        Assertions.assertTrue(r3.getReason().contains("AST Sandbox Violation"));

        // Import Unsafe
        RuleResult r4 = AstSandboxSecurityRule.INSTANCE.check("import sun.misc.Unsafe;\npublic class Test { void run() {} }");
        Assertions.assertTrue(r4.isFailed());
        Assertions.assertTrue(r4.getReason().contains("AST Sandbox Violation"));

        // Safe code
        RuleResult rSafe = AstSandboxSecurityRule.INSTANCE.check("public class Test { public String run() { return \"SAFE_RESULT\"; } }");
        Assertions.assertTrue(rSafe.isPassed());
        Assertions.assertFalse(rSafe.isFailed());
    }

    @Test
    public void testDefaultSecurityCheckerValidatorRuleManagement() {
        DefaultSecurityCheckerValidator validator = new DefaultSecurityCheckerValidator();
        Assertions.assertEquals(9, validator.getRules().size());

        // Remove a rule using String
        boolean removed = validator.removeRule("SQL_DDL_SAFETY");
        Assertions.assertTrue(removed);
        Assertions.assertEquals(8, validator.getRules().size());

        // Remove a rule using SecurityRuleType enum
        boolean removedEnum = validator.removeRule(SecurityRuleType.AST_SANDBOX_SECURITY);
        Assertions.assertTrue(removedEnum);
        Assertions.assertEquals(7, validator.getRules().size());

        // Add custom rule
        validator.addRule(new SecurityRule() {
            @Override
            public String getName() {
                return "CUSTOM_COMPANY_RULE";
            }

            @Override
            public RuleResult check(String scriptSource) {
                if (scriptSource != null && scriptSource.contains("t_salary")) {
                    return RuleResult.fail("Operating on t_salary table is strictly forbidden.");
                }
                return RuleResult.pass();
            }
        });

        CodeValidationResult res = validator.validate("test", "public class Task { void run() { String table = \"t_salary\"; } }");
        Assertions.assertTrue(res.isDenied());
        Assertions.assertTrue(res.getReason().contains("Operating on t_salary"));
    }
}
