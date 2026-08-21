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
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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
