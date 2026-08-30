package io.github.zlpawn.liverunner.autoconfigure.controller;

import io.github.zlpawn.liverunner.autoconfigure.injector.SpringBeanInjector;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.autoconfigure.util.AccessContextBuilder;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.model.LiveRunnerResponse;
import io.github.zlpawn.liverunner.core.model.ScriptExecuteResult;
import io.github.zlpawn.liverunner.core.model.ScriptHolder;
import io.github.zlpawn.liverunner.core.model.ScriptInfo;
import io.github.zlpawn.liverunner.core.security.AccessContext;
import io.github.zlpawn.liverunner.core.security.AccessResult;
import io.github.zlpawn.liverunner.core.security.LiveRunnerAccessValidator;
import io.github.zlpawn.liverunner.core.pool.ResizableLinkedBlockingQueue;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * RESTful endpoint controller for Live Runner operations.
 *
 * Supported Endpoints:
 * - POST /execute: One-Shot Execute (Direct compilation & execution, perfect for multi-pod clusters)
 * - POST /register: Register/Inject dynamic script
 * - POST /invoke/{scriptKey}: Single-method/default method invocation
 * - POST /invoke/{scriptKey}/{methodName}: Multi-method sub-path invocation
 * - GET /list: List loaded scripts
 * - DELETE /unregister/{scriptKey}: Unregister & unload
 *
 * Security:
 * Enforces access control via pluggable {@link LiveRunnerAccessValidator} chain.
 *
 * @author Leo (zlpawn)
 */
@RestController
@RequestMapping("/internal/live-runner")
public class LiveRunnerController {

    private final LiveRunnerEngine engine;
    private final SpringBeanInjector injector;
    private final LiveRunnerProperties properties;
    private final List<LiveRunnerAccessValidator> accessValidators;

    public LiveRunnerController(LiveRunnerEngine engine,
                                SpringBeanInjector injector,
                                LiveRunnerProperties properties,
                                List<LiveRunnerAccessValidator> accessValidators) {
        this.engine = engine;
        this.injector = injector;
        this.properties = properties;
        this.accessValidators = accessValidators != null ? new ArrayList<>(accessValidators) : new ArrayList<>();
        AnnotationAwareOrderComparator.sort(this.accessValidators);
    }

    /**
     * 1. One-Shot Execute (Compile, Inject, Execute, and Unload in a single HTTP request).
     */
    @PostMapping("/execute")
    @SuppressWarnings("unchecked")
    public ResponseEntity<LiveRunnerResponse<Object>> executeOneShot(
            HttpServletRequest request,
            @RequestParam(value = "method", required = false) String methodName,
            @RequestParam(value = "timeout", required = false) Integer timeoutSeconds,
            @RequestBody Map<String, Object> body) {

        String scriptSource = (String) body.get("scriptSource");
        Map<String, Object> params = (Map<String, Object>) body.get("params");
        if (params == null) {
            params = new HashMap<>();
        }

        AccessContext context = AccessContextBuilder.build(request, "execute", null, methodName, params);
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        int finalTimeout = timeoutSeconds != null ? timeoutSeconds : properties.getDefaultTimeoutSeconds();
        ScriptExecuteResult result = engine.executeOneShot(scriptSource, methodName, params, finalTimeout, injector::injectAndWrap);

        if (result.isSuccess()) {
            return ResponseEntity.ok(LiveRunnerResponse.success(result.getResult(), "SUCCESS", result.getCostMs()));
        } else {
            String errorMsg = result.getError() != null ? result.getError() : "Execution failed";
            return ResponseEntity.ok(LiveRunnerResponse.fail(500, errorMsg, result.getCostMs()));
        }
    }

    /**
     * 2. Register or update dynamic script (Injection only, does not execute).
     */
    @PostMapping("/register")
    public ResponseEntity<LiveRunnerResponse<Map<String, Object>>> register(
            HttpServletRequest request,
            @RequestBody Map<String, Object> body) {

        String scriptKey = (String) body.get("scriptKey");
        String scriptSource = (String) body.get("scriptSource");
        String remark = (String) body.get("remark");

        AccessContext context = AccessContextBuilder.build(request, "register", scriptKey, null, body);
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        try {
            long startTime = System.currentTimeMillis();
            ScriptHolder holder = engine.register(scriptKey, scriptSource, remark, injector::injectAndWrap);
            long cost = System.currentTimeMillis() - startTime;

            Map<String, Object> data = new HashMap<>();
            data.put("scriptKey", holder.getScriptKey());
            data.put("version", holder.getVersion());
            data.put("md5", holder.getMd5());
            data.put("availableMethods", holder.getAvailableMethods());
            data.put("compileCostMs", cost);

            return ResponseEntity.ok(LiveRunnerResponse.success(data, "SUCCESS", cost));
        } catch (Throwable e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(LiveRunnerResponse.fail(500, "Failed to register script: " + e.getMessage(), 0));
        }
    }

    /**
     * 3. Invoke dynamic script.
     */
    @PostMapping(value = {"/invoke/{scriptKey}", "/invoke/{scriptKey}/{methodName}"})
    public ResponseEntity<LiveRunnerResponse<Object>> invoke(
            HttpServletRequest request,
            @PathVariable("scriptKey") String scriptKey,
            @PathVariable(value = "methodName", required = false) String methodName,
            @RequestParam(value = "timeout", required = false) Integer timeoutSeconds,
            @RequestBody(required = false) Map<String, Object> params) {

        Map<String, Object> finalParams = params != null ? params : new HashMap<>();
        AccessContext context = AccessContextBuilder.build(request, "invoke", scriptKey, methodName, finalParams);
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        int finalTimeout = timeoutSeconds != null ? timeoutSeconds : properties.getDefaultTimeoutSeconds();
        ScriptExecuteResult result = engine.invoke(scriptKey, methodName, finalParams, finalTimeout);

        if (result.isSuccess()) {
            return ResponseEntity.ok(LiveRunnerResponse.success(result.getResult(), "SUCCESS", result.getCostMs()));
        } else {
            String errorMsg = result.getError() != null ? result.getError() : "Execution failed";
            return ResponseEntity.ok(LiveRunnerResponse.fail(500, errorMsg, result.getCostMs()));
        }
    }

    /**
     * 4. List all registered dynamic scripts in memory.
     */
    @GetMapping("/list")
    public ResponseEntity<LiveRunnerResponse<List<ScriptInfo>>> list(HttpServletRequest request) {
        AccessContext context = AccessContextBuilder.build(request, "list", null, null, new HashMap<>());
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        List<ScriptInfo> scripts = engine.getRegistry().listAll();
        return ResponseEntity.ok(LiveRunnerResponse.success(scripts, "SUCCESS", 0));
    }

    /**
     * 5. Unregister and unload a dynamic script (releases ClassLoader and Metaspace).
     */
    @DeleteMapping("/unregister/{scriptKey}")
    public ResponseEntity<LiveRunnerResponse<Void>> unregister(
            HttpServletRequest request,
            @PathVariable("scriptKey") String scriptKey) {

        AccessContext context = AccessContextBuilder.build(request, "unregister", scriptKey, null, new HashMap<>());
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        boolean removed = engine.getRegistry().unregister(scriptKey);
        if (removed) {
            return ResponseEntity.ok(LiveRunnerResponse.success(null, "SUCCESS", 0));
        } else {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(LiveRunnerResponse.fail(404, "Script not found", 0));
        }
    }

    /**
     * 6. Query currently active security rules and code validators.
     */
    @GetMapping("/security-rules")
    public ResponseEntity<LiveRunnerResponse<List<Map<String, Object>>>> listSecurityRules(HttpServletRequest request) {
        AccessContext context = AccessContextBuilder.build(request, "security-rules", null, null, new HashMap<>());
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        List<Map<String, Object>> result = new ArrayList<>();
        for (io.github.zlpawn.liverunner.core.security.LiveRunnerCodeValidator validator : engine.getCodeValidators()) {
            Map<String, Object> valMap = new HashMap<>();
            valMap.put("validatorClass", validator.getClass().getName());
            valMap.put("validatorSimpleName", validator.getClass().getSimpleName());
            if (validator instanceof io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator) {
                io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator defaultVal =
                        (io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator) validator;
                List<String> ruleNames = new ArrayList<>();
                for (io.github.zlpawn.liverunner.core.security.rule.SecurityRule rule : defaultVal.getRules()) {
                    ruleNames.add(rule.getName());
                }
                valMap.put("activeRules", ruleNames);
            }
            result.add(valMap);
        }

        return ResponseEntity.ok(LiveRunnerResponse.success(result, "SUCCESS", 0));
    }

    /**
     * 7. Query all current dynamic configurations and live thread pool runtime metrics.
     */
    @GetMapping("/config")
    public ResponseEntity<LiveRunnerResponse<Map<String, Object>>> getConfig(HttpServletRequest request) {
        AccessContext context = AccessContextBuilder.build(request, "config", null, null, new HashMap<>());
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        Map<String, Object> data = new HashMap<>();

        // 1. General configs
        data.put("enabled", properties.isEnabled());
        data.put("securityCheckEnabled", properties.isSecurityCheckEnabled());
        data.put("defaultTimeoutSeconds", properties.getDefaultTimeoutSeconds());

        // 2. Thread pool dynamic configs
        Map<String, Object> poolConfig = new HashMap<>();
        poolConfig.put("corePoolSize", properties.getCorePoolSize());
        poolConfig.put("maxPoolSize", properties.getMaxPoolSize());
        poolConfig.put("queueCapacity", properties.getQueueCapacity());
        poolConfig.put("keepAliveSeconds", properties.getKeepAliveSeconds());
        poolConfig.put("threadNamePrefix", properties.getThreadNamePrefix());
        poolConfig.put("rejectionPolicy", properties.getRejectionPolicy().name());
        data.put("threadPoolConfig", poolConfig);

        // 3. Thread pool live runtime metrics
        if (engine.getExecutorService() instanceof ThreadPoolExecutor) {
            ThreadPoolExecutor exec = (ThreadPoolExecutor) engine.getExecutorService();
            Map<String, Object> poolMetrics = new HashMap<>();
            poolMetrics.put("activeCount", exec.getActiveCount());
            poolMetrics.put("poolSize", exec.getPoolSize());
            poolMetrics.put("corePoolSize", exec.getCorePoolSize());
            poolMetrics.put("maximumPoolSize", exec.getMaximumPoolSize());
            poolMetrics.put("largestPoolSize", exec.getLargestPoolSize());
            poolMetrics.put("taskCount", exec.getTaskCount());
            poolMetrics.put("completedTaskCount", exec.getCompletedTaskCount());
            poolMetrics.put("queueSize", exec.getQueue().size());
            poolMetrics.put("queueRemainingCapacity", exec.getQueue().remainingCapacity());
            if (exec.getQueue() instanceof ResizableLinkedBlockingQueue) {
                poolMetrics.put("queueCapacity", ((ResizableLinkedBlockingQueue<?>) exec.getQueue()).getCapacity());
            }
            data.put("threadPoolRuntime", poolMetrics);
        }

        // 4. Granular security configs
        Map<String, Object> securityConfig = new HashMap<>();
        LiveRunnerProperties.Security sec = properties.getSecurity();
        if (sec != null) {
            securityConfig.put("enabled", sec.isEnabled());
            securityConfig.put("deniedBeans", sec.getDeniedBeans());
            securityConfig.put("allowedPackages", sec.getAllowedPackages());

            Map<String, Object> sqlConfig = new HashMap<>();
            sqlConfig.put("allowDdl", sec.getSql().isAllowDdl());
            sqlConfig.put("allowMissingWhere", sec.getSql().isAllowMissingWhere());
            sqlConfig.put("maxAffectedRows", sec.getSql().getMaxAffectedRows());
            sqlConfig.put("maxQueryRows", sec.getSql().getMaxQueryRows());
            securityConfig.put("sql", sqlConfig);

            Map<String, Object> redisConfig = new HashMap<>();
            redisConfig.put("allowDangerousKeys", sec.getRedis().isAllowDangerousKeys());
            securityConfig.put("redis", redisConfig);

            Map<String, Object> systemConfig = new HashMap<>();
            systemConfig.put("allowProcessExec", sec.getSystem().isAllowProcessExec());
            systemConfig.put("allowSystemExit", sec.getSystem().isAllowSystemExit());
            securityConfig.put("system", systemConfig);
        }
        data.put("security", securityConfig);

        return ResponseEntity.ok(LiveRunnerResponse.success(data, "SUCCESS", 0));
    }

    private AccessResult checkAccess(AccessContext context) {
        if (!properties.isEnabled()) {
            return AccessResult.deny(403, "Live Runner is disabled by configuration (leo.live-runner.enabled=false).");
        }
        for (LiveRunnerAccessValidator validator : accessValidators) {
            AccessResult res = validator.validate(context);
            if (res != null && !res.isAllowed()) {
                return res;
            }
        }
        return AccessResult.allow();
    }
}
