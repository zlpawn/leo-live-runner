package io.github.zlpawn.liverunner.autoconfigure.controller;

import io.github.zlpawn.liverunner.autoconfigure.injector.SpringBeanInjector;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.autoconfigure.util.AccessContextBuilder;
import io.github.zlpawn.liverunner.autoconfigure.util.LiveRunnerConfigMetadataResolver;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.model.LiveRunnerConfigItem;
import io.github.zlpawn.liverunner.core.model.LiveRunnerResponse;
import io.github.zlpawn.liverunner.core.model.LiveRunnerStatusItem;
import io.github.zlpawn.liverunner.core.model.ScriptExecuteResult;
import io.github.zlpawn.liverunner.core.model.ScriptHolder;
import io.github.zlpawn.liverunner.core.model.ScriptInfo;
import io.github.zlpawn.liverunner.core.security.AccessContext;
import io.github.zlpawn.liverunner.core.security.AccessResult;
import io.github.zlpawn.liverunner.core.security.LiveRunnerAccessValidator;
import io.github.zlpawn.liverunner.core.pool.ResizableLinkedBlockingQueue;
import io.github.zlpawn.liverunner.core.watch.ScriptTaskSnapshot;
import io.github.zlpawn.liverunner.core.watch.ScriptWatchSnapshot;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.Collections;
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
 * - GET /config: Full runtime metrics and dynamic configuration status
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
    private final Environment env;
    private final LiveRunnerConfigMetadataResolver configMetadataResolver = new LiveRunnerConfigMetadataResolver();

    public LiveRunnerController(LiveRunnerEngine engine,
                                SpringBeanInjector injector,
                                LiveRunnerProperties properties,
                                List<LiveRunnerAccessValidator> accessValidators) {
        this(engine, injector, properties, accessValidators, null);
    }

    public LiveRunnerController(LiveRunnerEngine engine,
                                SpringBeanInjector injector,
                                LiveRunnerProperties properties,
                                List<LiveRunnerAccessValidator> accessValidators,
                                Environment env) {
        this.engine = engine;
        this.injector = injector;
        this.properties = properties;
        this.env = env;
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
     * 7. Query all configurable properties as a structured list of LiveRunnerConfigItem entities.
     * Automatically discovered and resolved from @LiveConfigDoc metadata annotations on LiveRunnerProperties.
     * Dynamic properties reflect real-time Apollo / Environment values.
     */
    @GetMapping("/config")
    public ResponseEntity<LiveRunnerResponse<List<LiveRunnerConfigItem>>> getConfig(HttpServletRequest request) {
        AccessContext context = AccessContextBuilder.build(request, "config", null, null, new HashMap<>());
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        List<LiveRunnerConfigItem> list = configMetadataResolver.resolveConfigItems(properties, env);
        return ResponseEntity.ok(LiveRunnerResponse.success(list, "SUCCESS", 0));
    }

    /**
     * 8. Query lightweight live runtime metrics with full metadata descriptions and units.
     * Performance-optimized: Pure O(1) in-memory primitive reads without expensive JVM/OS/GC operations.
     */
    @GetMapping("/status")
    public ResponseEntity<LiveRunnerResponse<Map<String, Object>>> getStatus(HttpServletRequest request) {
        AccessContext context = AccessContextBuilder.build(request, "status", null, null, new HashMap<>());
        AccessResult auth = checkAccess(context);
        if (!auth.isAllowed()) {
            return ResponseEntity.status(auth.getCode())
                    .body(LiveRunnerResponse.fail(auth.getCode(), auth.getMessage(), 0));
        }

        Map<String, Object> data = new HashMap<>();

        // 1. Lightweight health summary
        boolean effectiveReadOnly = resolveBooleanProperty("leo.live-runner.security.read-only-mode", "leo.live-runner.security.readOnlyMode", properties.isReadOnlyMode());
        int activeThreads = 0;
        int poolSize = 0;
        int queueSize = 0;
        if (engine.getExecutorService() instanceof ThreadPoolExecutor) {
            ThreadPoolExecutor exec = (ThreadPoolExecutor) engine.getExecutorService();
            activeThreads = exec.getActiveCount();
            poolSize = exec.getPoolSize();
            queueSize = exec.getQueue().size();
        }
        int stuckCount = engine.getExecutionWatch() != null ? engine.getExecutionWatch().snapshot().getActiveStuckTaskCount() : 0;

        String summary = String.format("LiveRunner 运行正常 | [模式: %s] | [工作线程: %d活跃/%d池大小, 排队: %d] | [卡死任务: %d]",
                effectiveReadOnly ? "严格只读模式(仅允许查询)" : "允许写入模式(已放开限制)",
                activeThreads, poolSize, queueSize, stuckCount);
        data.put("statusSummary", summary);

        // 2. Structured metric list with description and unit
        List<LiveRunnerStatusItem> metrics = new ArrayList<>();

        if (engine.getExecutorService() instanceof ThreadPoolExecutor) {
            ThreadPoolExecutor exec = (ThreadPoolExecutor) engine.getExecutorService();
            metrics.add(new LiveRunnerStatusItem("threadPool.activeCount", exec.getActiveCount(), "当前正在执行脚本的活跃工作线程数", "threads", "工作线程池监控"));
            metrics.add(new LiveRunnerStatusItem("threadPool.poolSize", exec.getPoolSize(), "当前工作线程池实际物理线程总数", "threads", "工作线程池监控"));
            metrics.add(new LiveRunnerStatusItem("threadPool.corePoolSize", exec.getCorePoolSize(), "工作线程池核心常驻线程数", "threads", "工作线程池监控"));
            metrics.add(new LiveRunnerStatusItem("threadPool.maximumPoolSize", exec.getMaximumPoolSize(), "工作线程池允许创建的最大线程数", "threads", "工作线程池监控"));
            metrics.add(new LiveRunnerStatusItem("threadPool.queueSize", exec.getQueue().size(), "当前排队等待执行的脚本任务数", "tasks", "工作线程池监控"));
            metrics.add(new LiveRunnerStatusItem("threadPool.queueRemainingCapacity", exec.getQueue().remainingCapacity(), "任务等待队列剩余可用空位", "tasks", "工作线程池监控"));
            if (exec.getQueue() instanceof ResizableLinkedBlockingQueue) {
                metrics.add(new LiveRunnerStatusItem("threadPool.queueCapacity", ((ResizableLinkedBlockingQueue<?>) exec.getQueue()).getCapacity(), "任务等待队列总容量限制", "capacity", "工作线程池监控"));
            }
            metrics.add(new LiveRunnerStatusItem("threadPool.completedTaskCount", exec.getCompletedTaskCount(), "服务启动以来累计已完成执行的脚本任务总数", "tasks", "工作线程池监控"));
        }

        if (engine.getExecutionWatch() != null) {
            ScriptWatchSnapshot snapshot = engine.getExecutionWatch().snapshot();
            metrics.add(new LiveRunnerStatusItem("stuckTask.activeStuckTaskCount", snapshot.getActiveStuckTaskCount(), "当前超时后仍在后台运行的卡死任务数量", "tasks", "卡死任务监控"));
            metrics.add(new LiveRunnerStatusItem("stuckTask.totalTimedOutTaskCount", snapshot.getTotalTimedOutTaskCount(), "历史累计超时的脚本任务总数", "tasks", "卡死任务监控"));
            metrics.add(new LiveRunnerStatusItem("stuckTask.totalStuckTaskCount", snapshot.getTotalStuckTaskCount(), "历史累计判定为卡死的脚本任务总数", "tasks", "卡死任务监控"));

            List<Map<String, Object>> stuckTasks = new ArrayList<>();
            for (ScriptTaskSnapshot task : snapshot.getStuckTasks()) {
                Map<String, Object> item = new HashMap<>();
                item.put("taskId", task.getTaskId());
                item.put("scriptKey", task.getScriptKey());
                item.put("scriptMd5", task.getScriptMd5());
                item.put("threadName", task.getThreadName());
                item.put("timeoutSeconds", task.getTimeoutSeconds());
                item.put("elapsedSeconds", task.getElapsedSeconds());
                stuckTasks.add(item);
            }
            data.put("stuckTasks", stuckTasks);
        } else {
            data.put("stuckTasks", Collections.emptyList());
        }

        metrics.add(new LiveRunnerStatusItem("registry.loadedScriptCount", engine.getRegistry() != null ? engine.getRegistry().size() : 0, "当前内存中已注册常驻的动态脚本总数", "scripts", "脚本注册表"));

        data.put("metrics", metrics);

        return ResponseEntity.ok(LiveRunnerResponse.success(data, "SUCCESS", 0));
    }

    private boolean resolveBooleanProperty(String kebabKey, String camelKey, boolean defaultValue) {
        if (env != null) {
            Boolean val = env.getProperty(kebabKey, Boolean.class);
            if (val == null && camelKey != null) {
                val = env.getProperty(camelKey, Boolean.class);
            }
            if (val != null) {
                return val;
            }
        }
        return defaultValue;
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
