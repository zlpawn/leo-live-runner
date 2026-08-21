package com.example.sample;

import io.github.zlpawn.liverunner.autoconfigure.controller.LiveRunnerController;
import io.github.zlpawn.liverunner.autoconfigure.injector.SpringBeanInjector;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.model.LiveRunnerResponse;
import io.github.zlpawn.liverunner.core.model.ScriptExecuteResult;
import io.github.zlpawn.liverunner.core.model.ScriptHolder;
import io.github.zlpawn.liverunner.core.model.ScriptInfo;
import io.github.zlpawn.liverunner.core.security.AccessContext;
import io.github.zlpawn.liverunner.core.security.AccessResult;
import io.github.zlpawn.liverunner.core.security.LiveRunnerAccessValidator;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@SpringBootTest
public class SampleApplicationTest {

    @Autowired
    private LiveRunnerEngine engine;

    @Autowired
    private SpringBeanInjector injector;

    @Autowired
    private LiveRunnerController controller;

    @Autowired
    private LiveRunnerProperties properties;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    public void testMapSignature() throws Exception {
        String scriptKey = "test-map-sig";
        String scriptSource = ""
                + "package com.example.dynamic;\n"
                + "import com.example.sample.service.OrderService;\n"
                + "import org.slf4j.Logger;\n"
                + "import org.slf4j.LoggerFactory;\n"
                + "import java.util.Map;\n"
                + "public class TaskMap {\n"
                + "    private static final Logger log = LoggerFactory.getLogger(TaskMap.class);\n"
                + "    private OrderService orderService;\n"
                + "    public Object run(Map<String, Object> params) {\n"
                + "        Long orderId = ((Number) params.get(\"orderId\")).longValue();\n"
                + "        log.info(\"Processing order: {}\", orderId);\n"
                + "        orderService.updateOrderStatus(orderId, \"STATUS_PAID\");\n"
                + "        return orderService.getOrderStatus(orderId);\n"
                + "    }\n"
                + "}\n";

        ScriptHolder holder = engine.register(scriptKey, scriptSource, "Map Sig", injector);
        Assertions.assertNotNull(holder);

        Map<String, Object> params = new HashMap<>();
        params.put("orderId", 1001L);

        ScriptExecuteResult result = engine.invoke(scriptKey, params, 10);
        Assertions.assertTrue(result.isSuccess());
        Assertions.assertEquals("STATUS_PAID", result.getResult());
        engine.getRegistry().unregister(scriptKey);
    }

    @Test
    public void testSpecificStringParametersSignature() throws Exception {
        String scriptKey = "test-string-params-sig";
        String scriptSource = ""
                + "package com.example.dynamic;\n"
                + "import com.example.sample.service.OrderService;\n"
                + "import org.slf4j.Logger;\n"
                + "import org.slf4j.LoggerFactory;\n"
                + "public class TaskStringArgs {\n"
                + "    private static final Logger log = LoggerFactory.getLogger(TaskStringArgs.class);\n"
                + "    private OrderService orderService;\n"
                + "    public Object run(String orderId, String targetStatus) {\n"
                + "        log.info(\"Received orderId={}, targetStatus={}\", orderId, targetStatus);\n"
                + "        Long id = Long.parseLong(orderId);\n"
                + "        orderService.updateOrderStatus(id, targetStatus);\n"
                + "        return \"UPDATED_\" + orderId + \"_TO_\" + targetStatus;\n"
                + "    }\n"
                + "}\n";

        ScriptHolder holder = engine.register(scriptKey, scriptSource, "String Args Sig", injector);
        Assertions.assertNotNull(holder);

        Map<String, Object> params = new HashMap<>();
        params.put("orderId", "1002");
        params.put("targetStatus", "STATUS_COMPLETED");

        ScriptExecuteResult result = engine.invoke(scriptKey, params, 10);
        Assertions.assertTrue(result.isSuccess());
        Assertions.assertEquals("UPDATED_1002_TO_STATUS_COMPLETED", result.getResult());
        engine.getRegistry().unregister(scriptKey);
    }

    @Test
    public void testSingleMethodClassWithoutRunName() {
        MockHttpServletRequest request = new MockHttpServletRequest();

        Map<String, Object> registerBody = new HashMap<>();
        registerBody.put("scriptKey", "single-custom-method");
        registerBody.put("scriptSource", ""
                + "package com.example.dynamic;\n"
                + "public class SingleActionTask {\n"
                + "    public Object customAction(String name) {\n"
                + "        return \"HELLO_\" + name;\n"
                + "    }\n"
                + "}\n");
        registerBody.put("remark", "Single method without run name");

        controller.register(request, registerBody);

        Map<String, Object> params = new HashMap<>();
        params.put("name", "LEO");
        ResponseEntity<LiveRunnerResponse<Object>> res = controller.invoke(request, "single-custom-method", null, 10, params);

        Assertions.assertEquals(HttpStatus.OK, res.getStatusCode());
        Assertions.assertEquals(200, res.getBody().getCode());
        Assertions.assertEquals("HELLO_LEO", res.getBody().getData());
        Assertions.assertEquals("SUCCESS", res.getBody().getMsg());

        controller.unregister(request, "single-custom-method");
    }

    @Test
    public void testMultiMethodSecondaryPathInvocation() {
        MockHttpServletRequest request = new MockHttpServletRequest();

        Map<String, Object> registerBody = new HashMap<>();
        registerBody.put("scriptKey", "order-api-multi");
        registerBody.put("scriptSource", ""
                + "package com.example.dynamic;\n"
                + "import com.example.sample.service.OrderService;\n"
                + "import org.slf4j.Logger;\n"
                + "import org.slf4j.LoggerFactory;\n"
                + "public class OrderApiController {\n"
                + "    private static final Logger log = LoggerFactory.getLogger(OrderApiController.class);\n"
                + "    private OrderService orderService;\n"
                + "    public Object query(String orderId) {\n"
                + "        return \"QUERY_\" + orderService.getOrderStatus(Long.parseLong(orderId));\n"
                + "    }\n"
                + "    public Object update(String orderId, String status) {\n"
                + "        log.info(\"Updating order: {} to {}\", orderId, status);\n"
                + "        orderService.updateOrderStatus(Long.parseLong(orderId), status);\n"
                + "        return \"UPDATE_SUCCESS\";\n"
                + "    }\n"
                + "    public Object cancel(String orderId) {\n"
                + "        orderService.updateOrderStatus(Long.parseLong(orderId), \"CANCELLED\");\n"
                + "        return \"CANCEL_SUCCESS\";\n"
                + "    }\n"
                + "}\n");
        registerBody.put("remark", "Multi-method API Controller");

        controller.register(request, registerBody);

        // 1. Invoke /invoke/order-api-multi/update
        Map<String, Object> updateParams = new HashMap<>();
        updateParams.put("orderId", "1002");
        updateParams.put("status", "STATUS_PROCESSING");
        ResponseEntity<LiveRunnerResponse<Object>> updateRes = controller.invoke(request, "order-api-multi", "update", 10, updateParams);
        Assertions.assertEquals("UPDATE_SUCCESS", updateRes.getBody().getData());
        Assertions.assertEquals("SUCCESS", updateRes.getBody().getMsg());

        // 2. Invoke /invoke/order-api-multi/query
        Map<String, Object> queryParams = new HashMap<>();
        queryParams.put("orderId", "1002");
        ResponseEntity<LiveRunnerResponse<Object>> queryRes = controller.invoke(request, "order-api-multi", "query", 10, queryParams);
        Assertions.assertEquals("QUERY_STATUS_PROCESSING", queryRes.getBody().getData());

        // 3. Invoke /invoke/order-api-multi/cancel
        ResponseEntity<LiveRunnerResponse<Object>> cancelRes = controller.invoke(request, "order-api-multi", "cancel", 10, queryParams);
        Assertions.assertEquals("CANCEL_SUCCESS", cancelRes.getBody().getData());

        controller.unregister(request, "order-api-multi");
    }

    @Test
    public void testOneShotExecuteForMultiPodCluster() {
        MockHttpServletRequest request = new MockHttpServletRequest();

        Map<String, Object> executeBody = new HashMap<>();
        executeBody.put("scriptSource", ""
                + "package com.example.dynamic;\n"
                + "import com.example.sample.service.OrderService;\n"
                + "import org.slf4j.Logger;\n"
                + "import org.slf4j.LoggerFactory;\n"
                + "public class OneShotTask {\n"
                + "    private static final Logger log = LoggerFactory.getLogger(OneShotTask.class);\n"
                + "    private OrderService orderService;\n"
                + "    public Object run(String orderId) {\n"
                + "        log.info(\"OneShot execution for orderId={}\", orderId);\n"
                + "        orderService.updateOrderStatus(Long.parseLong(orderId), \"ONE_SHOT_SUCCESS\");\n"
                + "        return orderService.getOrderStatus(Long.parseLong(orderId));\n"
                + "    }\n"
                + "}\n");

        Map<String, Object> params = new HashMap<>();
        params.put("orderId", "1003");
        executeBody.put("params", params);

        ResponseEntity<LiveRunnerResponse<Object>> res = controller.executeOneShot(request, null, 10, executeBody);
        Assertions.assertEquals(HttpStatus.OK, res.getStatusCode());
        Assertions.assertEquals(200, res.getBody().getCode());
        Assertions.assertTrue(res.getBody().isSuccess());
        Assertions.assertEquals("ONE_SHOT_SUCCESS", res.getBody().getData());
        Assertions.assertEquals("SUCCESS", res.getBody().getMsg());
    }

    @Test
    public void testTransactionalAnnotationAutomaticRollback() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        jdbcTemplate.update("UPDATE t_account SET balance = 1000 WHERE id = 1");

        // 1. Script with @Transactional that throws exception -> must rollback to 1000!
        Map<String, Object> failBody = new HashMap<>();
        failBody.put("scriptSource", ""
                + "package com.example.dynamic;\n"
                + "import org.slf4j.Logger;\n"
                + "import org.slf4j.LoggerFactory;\n"
                + "import org.springframework.jdbc.core.JdbcTemplate;\n"
                + "import org.springframework.transaction.annotation.Transactional;\n"
                + "public class TxFailTask {\n"
                + "    private static final Logger log = LoggerFactory.getLogger(TxFailTask.class);\n"
                + "    private JdbcTemplate jdbcTemplate;\n"
                + "    @Transactional(rollbackFor = Exception.class)\n"
                + "    public Object run() {\n"
                + "        log.info(\"Step 1: Deducing balance by 500...\");\n"
                + "        jdbcTemplate.update(\"UPDATE t_account SET balance = balance - 500 WHERE id = 1\");\n"
                + "        log.info(\"Step 2: Simulating unexpected exception to trigger rollback...\");\n"
                + "        throw new IllegalStateException(\"Triggering intentional transaction rollback\");\n"
                + "    }\n"
                + "}\n");

        ResponseEntity<LiveRunnerResponse<Object>> failRes = controller.executeOneShot(request, null, 10, failBody);
        Assertions.assertEquals(500, failRes.getBody().getCode());
        Assertions.assertFalse(failRes.getBody().isSuccess());
        Assertions.assertTrue(failRes.getBody().getMsg().contains("Triggering intentional transaction rollback"));

        Integer balanceAfterFail = jdbcTemplate.queryForObject("SELECT balance FROM t_account WHERE id = 1", Integer.class);
        Assertions.assertEquals(1000, balanceAfterFail, "@Transactional must have rolled back the deduction!");

        // 2. Script with @Transactional that succeeds -> balance commits to 800!
        Map<String, Object> successBody = new HashMap<>();
        successBody.put("scriptSource", ""
                + "package com.example.dynamic;\n"
                + "import org.slf4j.Logger;\n"
                + "import org.slf4j.LoggerFactory;\n"
                + "import org.springframework.jdbc.core.JdbcTemplate;\n"
                + "import org.springframework.transaction.annotation.Transactional;\n"
                + "public class TxSuccessTask {\n"
                + "    private static final Logger log = LoggerFactory.getLogger(TxSuccessTask.class);\n"
                + "    private JdbcTemplate jdbcTemplate;\n"
                + "    @Transactional(rollbackFor = Exception.class)\n"
                + "    public Object run() {\n"
                + "        log.info(\"Deducing balance by 200...\");\n"
                + "        jdbcTemplate.update(\"UPDATE t_account SET balance = balance - 200 WHERE id = 1\");\n"
                + "        return \"TX_COMMITTED\";\n"
                + "    }\n"
                + "}\n");

        ResponseEntity<LiveRunnerResponse<Object>> successRes = controller.executeOneShot(request, null, 10, successBody);
        Assertions.assertEquals(200, successRes.getBody().getCode());
        Assertions.assertTrue(successRes.getBody().isSuccess());
        Assertions.assertEquals("TX_COMMITTED", successRes.getBody().getData());
        Assertions.assertEquals("SUCCESS", successRes.getBody().getMsg());

        Integer balanceAfterSuccess = jdbcTemplate.queryForObject("SELECT balance FROM t_account WHERE id = 1", Integer.class);
        Assertions.assertEquals(800, balanceAfterSuccess, "Balance should be committed to 800!");
    }

    @Test
    public void testSecuritySandboxBlocksDangerousOperations() {
        MockHttpServletRequest request = new MockHttpServletRequest();

        // 1. Attempt System.exit(0)
        Map<String, Object> exitBody = new HashMap<>();
        exitBody.put("scriptSource", "public class EvilTask { public void run() { System.exit(0); } }");
        ResponseEntity<LiveRunnerResponse<Object>> exitRes = controller.executeOneShot(request, null, 10, exitBody);
        Assertions.assertEquals(500, exitRes.getBody().getCode());
        Assertions.assertFalse(exitRes.getBody().isSuccess());
        Assertions.assertTrue(exitRes.getBody().getMsg().contains("Security Violation"));

        // 2. Attempt Runtime.getRuntime().exec(...)
        Map<String, Object> execBody = new HashMap<>();
        execBody.put("scriptSource", "public class EvilExec { public void run() { Runtime.getRuntime().exec(\"calc\"); } }");
        ResponseEntity<LiveRunnerResponse<Object>> execRes = controller.executeOneShot(request, null, 10, execBody);
        Assertions.assertEquals(500, execRes.getBody().getCode());
        Assertions.assertFalse(execRes.getBody().isSuccess());
        Assertions.assertTrue(execRes.getBody().getMsg().contains("Security Violation"));

        // 3. Attempt ProcessBuilder
        Map<String, Object> pbBody = new HashMap<>();
        pbBody.put("scriptSource", "public class EvilPb { public void run() { new ProcessBuilder(\"cmd\").start(); } }");
        ResponseEntity<LiveRunnerResponse<Object>> pbRes = controller.executeOneShot(request, null, 10, pbBody);
        Assertions.assertEquals(500, pbRes.getBody().getCode());
        Assertions.assertFalse(pbRes.getBody().isSuccess());
        Assertions.assertTrue(pbRes.getBody().getMsg().contains("Security Violation"));
    }

    @Test
    public void testCustomAccessValidatorSpiChain() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Custom-Admin", "secret_pass");

        // 1. Custom Validator that denies unauthorized request
        LiveRunnerAccessValidator denyValidator = context -> {
            String token = context.getHeader("X-Custom-Admin");
            if (!"secret_pass".equals(token)) {
                return AccessResult.deny(401, "Custom Auth Denied: Invalid X-Custom-Admin token");
            }
            return AccessResult.allow();
        };

        LiveRunnerController secureController = new LiveRunnerController(engine, injector, properties,
                Collections.singletonList(denyValidator));

        // Attempt without header -> Denied with 401
        MockHttpServletRequest unauthRequest = new MockHttpServletRequest();
        ResponseEntity<LiveRunnerResponse<List<ScriptInfo>>> denyRes = secureController.list(unauthRequest);
        Assertions.assertEquals(HttpStatus.UNAUTHORIZED, denyRes.getStatusCode());
        Assertions.assertEquals(401, denyRes.getBody().getCode());
        Assertions.assertTrue(denyRes.getBody().getMsg().contains("Custom Auth Denied"));

        // Attempt with header -> Allowed with 200
        ResponseEntity<LiveRunnerResponse<List<ScriptInfo>>> allowRes = secureController.list(request);
        Assertions.assertEquals(HttpStatus.OK, allowRes.getStatusCode());
        Assertions.assertEquals(200, allowRes.getBody().getCode());
    }
}
