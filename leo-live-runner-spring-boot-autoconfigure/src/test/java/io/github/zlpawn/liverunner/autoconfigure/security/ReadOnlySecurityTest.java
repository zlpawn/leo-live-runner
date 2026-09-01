package io.github.zlpawn.liverunner.autoconfigure.security;

import io.github.zlpawn.liverunner.autoconfigure.injector.SpringBeanInjector;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import io.github.zlpawn.liverunner.core.security.CodeValidationResult;
import io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator;
import io.github.zlpawn.liverunner.core.security.rule.SecurityRule;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationContext;
import org.springframework.context.support.GenericApplicationContext;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ReadOnlySecurityTest {

    private DefaultSecurityCheckerValidator readOnlyValidator;
    private DefaultSecurityCheckerValidator writeAllowedValidator;

    @BeforeEach
    void setUp() {
        // 1. Default validator (read-only mode enabled)
        List<SecurityRule> readOnlyRules = DefaultSecurityCheckerValidator.createDefaultRules(
                true, false, false, false, false
        );
        readOnlyValidator = new DefaultSecurityCheckerValidator(readOnlyRules);

        // 2. Write-allowed validator (read-only mode disabled)
        List<SecurityRule> writeAllowedRules = DefaultSecurityCheckerValidator.createDefaultRules(
                false, false, false, false, false
        );
        writeAllowedValidator = new DefaultSecurityCheckerValidator(writeAllowedRules);
    }

    // ─── 1. SQL Read-Only Tests ─────────────────────────────────────────────

    @Test
    void testSqlSelectAllowedInReadOnlyMode() {
        String selectScript = "def sql = 'SELECT id, username, email FROM sys_user WHERE status = 1 LIMIT 10';\n" +
                "return jdbcTemplate.queryForList(sql);";
        CodeValidationResult res = readOnlyValidator.validate("testSelect", selectScript);
        assertTrue(res.isAllowed(), "SELECT queries must be allowed in read-only mode");
    }

    @Test
    void testSqlInsertBlockedInReadOnlyMode() {
        String insertScript = "def sql = 'INSERT INTO sys_user (username) VALUES (\"leo\")';\n" +
                "jdbcTemplate.execute(sql);";
        CodeValidationResult res = readOnlyValidator.validate("testInsert", insertScript);
        assertFalse(res.isAllowed(), "INSERT statements must be blocked in read-only mode");
        assertTrue(res.getReason().contains("Read-Only Violation"), "Error message should mention read-only violation");
    }

    @Test
    void testSqlUpdateBlockedInReadOnlyMode() {
        String updateScript = "def sql = 'UPDATE sys_user SET status = 0 WHERE id = 100';\n" +
                "jdbcTemplate.update(sql);";
        CodeValidationResult res = readOnlyValidator.validate("testUpdate", updateScript);
        assertFalse(res.isAllowed(), "UPDATE statements must be blocked in read-only mode");

        // When read-only mode is disabled, UPDATE with WHERE should be allowed
        CodeValidationResult writeRes = writeAllowedValidator.validate("testUpdate", updateScript);
        assertTrue(writeRes.isAllowed(), "UPDATE with WHERE should be allowed when read-only mode is disabled");
    }

    @Test
    void testSqlDeleteBlockedInReadOnlyMode() {
        String deleteScript = "def sql = 'DELETE FROM sys_user WHERE id = 100';\n" +
                "jdbcTemplate.update(sql);";
        CodeValidationResult res = readOnlyValidator.validate("testDelete", deleteScript);
        assertFalse(res.isAllowed(), "DELETE statements must be blocked in read-only mode");
    }

    @Test
    void testOrmMethodsBlockedInReadOnlyMode() {
        String ormScript = "userMapper.updateById(user);";
        CodeValidationResult res = readOnlyValidator.validate("testOrm", ormScript);
        assertFalse(res.isAllowed(), "ORM write methods like updateById must be blocked in read-only mode");
    }

    // ─── 2. Redis Read-Only Tests ───────────────────────────────────────────

    @Test
    void testRedisGetAllowedInReadOnlyMode() {
        String redisGetScript = "return redisTemplate.opsForValue().get('user:100');";
        CodeValidationResult res = readOnlyValidator.validate("testRedisGet", redisGetScript);
        assertTrue(res.isAllowed(), "Redis GET must be allowed in read-only mode");
    }

    @Test
    void testRedisMgetAndHgetAllAllowedInReadOnlyMode() {
        String redisReadScript = "def val = redisTemplate.opsForHash().get('cache:key', 'field');\n" +
                "def list = redisTemplate.opsForList().range('list:key', 0, 10);\n" +
                "return val;";
        CodeValidationResult res = readOnlyValidator.validate("testRedisReads", redisReadScript);
        assertTrue(res.isAllowed(), "Redis read operations must be allowed in read-only mode");
    }

    @Test
    void testRedisSetBlockedInReadOnlyMode() {
        String redisSetScript = "redisTemplate.opsForValue().set('user:100', 'active');";
        CodeValidationResult res = readOnlyValidator.validate("testRedisSet", redisSetScript);
        assertFalse(res.isAllowed(), "Redis SET must be blocked in read-only mode");
    }

    @Test
    void testRedisDeleteAndExpireBlockedInReadOnlyMode() {
        String redisDelScript = "redisTemplate.delete('user:100');";
        CodeValidationResult res1 = readOnlyValidator.validate("testRedisDel", redisDelScript);
        assertFalse(res1.isAllowed(), "Redis DELETE must be blocked in read-only mode");

        String redisExpireScript = "redisTemplate.expire('user:100', 3600, TimeUnit.SECONDS);";
        CodeValidationResult res2 = readOnlyValidator.validate("testRedisExpire", redisExpireScript);
        assertFalse(res2.isAllowed(), "Redis EXPIRE must be blocked in read-only mode");
    }

    // ─── 3. Message Queue Read-Only Tests ────────────────────────────────────

    @Test
    void testKafkaSendBlockedInReadOnlyMode() {
        String kafkaScript = "kafkaTemplate.send('topic-user-events', 'user_updated');";
        CodeValidationResult res = readOnlyValidator.validate("testKafkaSend", kafkaScript);
        assertFalse(res.isAllowed(), "Kafka message sending must be blocked in read-only mode");
        assertTrue(res.getReason().contains("Kafka"), "Violation message should mention Kafka/MQ");
    }

    @Test
    void testRocketMqSendBlockedInReadOnlyMode() {
        String rocketScript = "rocketMQTemplate.syncSend('topic_order', orderEvent);";
        CodeValidationResult res = readOnlyValidator.validate("testRocketSend", rocketScript);
        assertFalse(res.isAllowed(), "RocketMQ sending must be blocked in read-only mode");
    }

    @Test
    void testRabbitMqSendBlockedInReadOnlyMode() {
        String rabbitScript = "rabbitTemplate.convertAndSend('exchange', 'routingKey', msg);";
        CodeValidationResult res = readOnlyValidator.validate("testRabbitSend", rabbitScript);
        assertFalse(res.isAllowed(), "RabbitMQ sending must be blocked in read-only mode");
    }

    // ─── 4. HTTP / Feign Read-Only Tests ────────────────────────────────────

    @Test
    void testHttpGetAllowedInReadOnlyMode() {
        String httpGetScript = "return restTemplate.getForObject('https://api.example.com/users/100', String.class);";
        CodeValidationResult res = readOnlyValidator.validate("testHttpGet", httpGetScript);
        assertTrue(res.isAllowed(), "HTTP GET must be allowed in read-only mode");
    }

    @Test
    void testHttpPostQueryAllowedInReadOnlyMode() {
        // Real-world POST queries with query keywords (e.g. queryList, getBattery, search)
        String postQueryScript = "return restTemplate.postForObject('https://api.example.com/queryWorkOrderList', queryReq, List.class);";
        CodeValidationResult res = readOnlyValidator.validate("testHttpPostQuery", postQueryScript);
        assertTrue(res.isAllowed(), "POST query with query semantics must be allowed in read-only mode");

        String postSearchScript = "return orderClient.searchOrders(searchReq);";
        CodeValidationResult res2 = readOnlyValidator.validate("testPostSearch", postSearchScript);
        assertTrue(res2.isAllowed(), "searchOrders POST query must be allowed");
    }

    @Test
    void testHttpPostWriteBlockedInReadOnlyMode() {
        String postWriteScript = "restTemplate.postForObject('https://api.example.com/orders/create', orderDto, Void.class);";
        CodeValidationResult res = readOnlyValidator.validate("testHttpPostWrite", postWriteScript);
        assertFalse(res.isAllowed(), "HTTP POST write mutation must be blocked in read-only mode");
    }

    @Test
    void testHttpPutAndDeleteBlockedInReadOnlyMode() {
        String putScript = "restTemplate.put('https://api.example.com/orders/100', updateReq);";
        CodeValidationResult res1 = readOnlyValidator.validate("testHttpPut", putScript);
        assertFalse(res1.isAllowed(), "HTTP PUT must be blocked in read-only mode");

        String deleteScript = "restTemplate.delete('https://api.example.com/orders/100');";
        CodeValidationResult res2 = readOnlyValidator.validate("testHttpDelete", deleteScript);
        assertFalse(res2.isAllowed(), "HTTP DELETE must be blocked in read-only mode");
    }

    // ─── 5. Anti-Tampering (LiveRunner Self-Protection) Tests ────────────────

    @Test
    void testAntiTamperingInScriptSource() {
        String tamperScript = "applicationContext.getBean(LiveRunnerProperties.class).setSecurityCheckEnabled(false);";
        CodeValidationResult res = readOnlyValidator.validate("testTamper", tamperScript);
        assertFalse(res.isAllowed(), "Accessing or tampering with LiveRunner internal properties must be blocked");
    }

    @Test
    void testAntiTamperingInBeanInjection() {
        GenericApplicationContext context = new GenericApplicationContext();
        LiveRunnerProperties props = new LiveRunnerProperties();
        context.registerBean("liveRunnerProperties", LiveRunnerProperties.class, () -> props);
        context.refresh();

        SpringBeanInjector injector = new SpringBeanInjector(context, props);

        // Dummy class attempting to inject LiveRunner internal properties
        class MaliciousScript {
            private LiveRunnerProperties liveRunnerProperties;
        }

        MaliciousScript script = new MaliciousScript();
        assertThrows(SecurityException.class, () -> {
            injector.injectAndWrap(script);
        }, "Injecting LiveRunner internal bean must throw SecurityException");
    }

    // ─── 6. Dynamic Configuration / Apollo Environment Real-time Tests ───────

    @Test
    void testDynamicApolloEnvironmentConfigChange() {
        org.springframework.mock.env.MockEnvironment mockEnv = new org.springframework.mock.env.MockEnvironment();
        LiveRunnerProperties props = new LiveRunnerProperties();

        // 1. Initial state: read-only mode is true by default
        java.util.function.BooleanSupplier readOnlySupplier = () -> {
            Boolean envVal = mockEnv.getProperty("leo.live-runner.security.read-only-mode", Boolean.class);
            if (envVal == null) {
                envVal = mockEnv.getProperty("leo.live-runner.security.readOnlyMode", Boolean.class);
            }
            if (envVal != null) {
                return envVal;
            }
            return props.isReadOnlyMode();
        };

        List<SecurityRule> rules = DefaultSecurityCheckerValidator.createDefaultRules(
                readOnlySupplier, false, false, false, false
        );
        DefaultSecurityCheckerValidator dynamicValidator = new DefaultSecurityCheckerValidator(rules);

        String updateSqlScript = "jdbcTemplate.update('UPDATE t_account SET balance = 500 WHERE id = 1');";

        // In default state -> update is blocked
        assertFalse(dynamicValidator.validate("test", updateSqlScript).isAllowed());

        // 2. User changes configuration in Apollo to false in real-time
        mockEnv.setProperty("leo.live-runner.security.read-only-mode", "false");

        // Real-time evaluation -> update is immediately allowed without restarting or rebinding
        assertTrue(dynamicValidator.validate("test", updateSqlScript).isAllowed());

        // 3. User switches back to true in Apollo in real-time
        mockEnv.setProperty("leo.live-runner.security.read-only-mode", "true");

        // Real-time evaluation -> update is immediately blocked again
        assertFalse(dynamicValidator.validate("test", updateSqlScript).isAllowed());
    }
}
