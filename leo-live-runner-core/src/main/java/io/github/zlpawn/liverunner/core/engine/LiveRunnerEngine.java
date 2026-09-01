package io.github.zlpawn.liverunner.core.engine;

import io.github.zlpawn.liverunner.core.LiveLogger;
import io.github.zlpawn.liverunner.core.LiveRunnerClassLoader;
import io.github.zlpawn.liverunner.core.model.ScriptExecuteResult;
import io.github.zlpawn.liverunner.core.model.ScriptHolder;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import io.github.zlpawn.liverunner.core.security.CodeValidationResult;
import io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator;
import io.github.zlpawn.liverunner.core.security.LiveRunnerCodeValidator;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionHandle;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatch;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.function.Function;

/**
 * Core execution engine.
 * Handles dynamic compilation, registration, multi-method invocation, one-shot execution,
 * security sandbox verification, timeout control, and result packaging.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerEngine {
    private static final Logger log = LoggerFactory.getLogger(LiveRunnerEngine.class);

    private final ScriptRegistry registry;
    private final ExecutorService executorService;
    private final List<LiveRunnerCodeValidator> codeValidators = new CopyOnWriteArrayList<>();
    private volatile boolean securityCheckEnabled = true;
    private volatile ScriptExecutionWatch executionWatch;

    public LiveRunnerEngine(ScriptRegistry registry) {
        this(registry, createDefaultExecutor(), Collections.singletonList(new DefaultSecurityCheckerValidator()));
    }

    public LiveRunnerEngine(ScriptRegistry registry, ExecutorService executorService) {
        this(registry, executorService, Collections.singletonList(new DefaultSecurityCheckerValidator()));
    }

    public LiveRunnerEngine(ScriptRegistry registry, ExecutorService executorService, List<LiveRunnerCodeValidator> codeValidators) {
        this.registry = registry;
        this.executorService = executorService != null ? executorService : createDefaultExecutor();
        if (codeValidators != null && !codeValidators.isEmpty()) {
            this.codeValidators.addAll(codeValidators);
        } else {
            this.codeValidators.add(new DefaultSecurityCheckerValidator());
        }
    }

    private static ExecutorService createDefaultExecutor() {
        return new ThreadPoolExecutor(
                2,
                10,
                60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(200),
                r -> {
                    Thread t = new Thread(r, "LiveRunner-Worker-" + System.currentTimeMillis());
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.CallerRunsPolicy()
        );
    }

    /**
     * Register or update a dynamic script.
     * Performs multi-layer security sandbox checks before compilation.
     */
    public synchronized ScriptHolder register(String scriptKey, String scriptSource, String remark,
                                              Function<Object, Object> beanPostProcessor) throws Exception {
        if (scriptKey == null || scriptKey.trim().isEmpty()) {
            throw new IllegalArgumentException("scriptKey must not be empty");
        }
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            throw new IllegalArgumentException("scriptSource must not be empty");
        }

        // 1. Security Sandbox Check
        if (isSecurityCheckEnabled()) {
            checkCodeSecurity(scriptKey, scriptSource);
        }

        String md5 = calculateMd5(scriptSource);
        ScriptHolder existing = registry.get(scriptKey);

        if (existing != null && md5.equals(existing.getMd5())) {
            log.info("LiveRunner: Script [{}] already registered with identical MD5. Skipping re-compilation.", scriptKey);
            return existing;
        }

        int nextVersion = existing != null ? existing.getVersion() + 1 : 1;

        LiveRunnerClassLoader classLoader = new LiveRunnerClassLoader(Thread.currentThread().getContextClassLoader());
        Class<?> scriptClass = classLoader.parseClass(scriptSource);
        Object scriptInstance = scriptClass.getDeclaredConstructor().newInstance();

        if (beanPostProcessor != null) {
            scriptInstance = beanPostProcessor.apply(scriptInstance);
        }

        ScriptHolder holder = new ScriptHolder(scriptKey, nextVersion, md5, remark,
                classLoader, scriptClass, scriptInstance);

        registry.put(scriptKey, holder);
        return holder;
    }

    /**
     * One-shot compilation & execution with Security Sandbox verification.
     */
    public ScriptExecuteResult executeOneShot(String scriptSource, String methodName, Map<String, Object> params,
                                             int timeoutSeconds, Function<Object, Object> beanPostProcessor) {
        long startTime = System.currentTimeMillis();
        LiveLogger logger = new LiveLogger();

        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return ScriptExecuteResult.fail("scriptSource must not be empty", "", 0);
        }

        // 1. Security Sandbox Check
        if (isSecurityCheckEnabled()) {
            for (LiveRunnerCodeValidator validator : codeValidators) {
                CodeValidationResult checkRes = validator.validate("one-shot", scriptSource);
                if (checkRes != null && checkRes.isDenied()) {
                    long costMs = System.currentTimeMillis() - startTime;
                    logger.println("\n[SECURITY ERROR]: " + checkRes.getReason());
                    return ScriptExecuteResult.fail(checkRes.getReason(), logger.getLogs(), costMs);
                }
            }
        }

        int finalTimeout = timeoutSeconds > 0 ? timeoutSeconds : 60;
        LiveRunnerClassLoader tempClassLoader = null;
        Future<Object> future = null;
        ScriptExecutionHandle executionHandle = null;

        try {
            tempClassLoader = new LiveRunnerClassLoader(Thread.currentThread().getContextClassLoader());
            Class<?> scriptClass = tempClassLoader.parseClass(scriptSource);
            Object scriptInstance = scriptClass.getDeclaredConstructor().newInstance();

            if (beanPostProcessor != null) {
                scriptInstance = beanPostProcessor.apply(scriptInstance);
            }

            ScriptHolder tempHolder = new ScriptHolder("one-shot-temp", 1, calculateMd5(scriptSource),
                    "One-Shot Execution", tempClassLoader, scriptClass, scriptInstance);

            final ScriptExecutionHandle submittedHandle = executionWatch != null
                    ? executionWatch.start("one-shot", tempHolder.getMd5(), finalTimeout)
                    : null;
            executionHandle = submittedHandle;

            future = executorService.submit(() -> {
                try {
                    if (submittedHandle != null) {
                        submittedHandle.recordThreadName(Thread.currentThread().getName());
                    }
                    return tempHolder.invoke(methodName, params, logger);
                } finally {
                    tempHolder.destroy();
                    if (submittedHandle != null) {
                        submittedHandle.complete();
                    }
                }
            });

            Object result = future.get(finalTimeout, TimeUnit.SECONDS);
            long costMs = System.currentTimeMillis() - startTime;
            return ScriptExecuteResult.success(result, logger.getLogs(), costMs);
        } catch (TimeoutException e) {
            if (executionHandle != null) {
                executionHandle.markTimedOut();
            }
            if (future != null) {
                future.cancel(true);
            }
            if (executionHandle != null && future == null) {
                executionHandle.complete();
            }
            if (tempClassLoader != null) {
                tempClassLoader.unload();
            }
            long costMs = System.currentTimeMillis() - startTime;
            logger.println("\n[ERROR] Execution timeout after " + finalTimeout + " seconds. Cancelled.");
            return ScriptExecuteResult.fail("Execution Timeout (" + finalTimeout + "s)", logger.getLogs(), costMs);
        } catch (Throwable e) {
            if (executionHandle != null && future != null && !future.isDone()) {
                executionHandle.markTimedOut();
            }
            if (future != null) {
                future.cancel(true);
            }
            if (executionHandle != null && future == null) {
                executionHandle.complete();
            }
            if (tempClassLoader != null) {
                tempClassLoader.unload();
            }
            Throwable root = unwrapException(e);
            long costMs = System.currentTimeMillis() - startTime;

            StringWriter sw = new StringWriter();
            root.printStackTrace(new PrintWriter(sw));
            logger.println("\n[ERROR Exception]:\n" + sw);

            String errorMsg = root.getMessage() != null ? root.getMessage() : root.toString();
            return ScriptExecuteResult.fail(errorMsg, logger.getLogs(), costMs);
        }
    }

    /**
     * Invoke a previously registered script.
     */
    public ScriptExecuteResult invoke(String scriptKey, String methodName, Map<String, Object> params, int timeoutSeconds) {
        long startTime = System.currentTimeMillis();
        LiveLogger logger = new LiveLogger();

        ScriptHolder holder = registry.get(scriptKey);
        if (holder == null) {
            return ScriptExecuteResult.fail("Script [" + scriptKey + "] not found. Please register it first.",
                    "", 0);
        }

        int finalTimeout = timeoutSeconds > 0 ? timeoutSeconds : 60;

        final ScriptExecutionHandle executionHandle = executionWatch != null
                ? executionWatch.start(scriptKey, holder.getMd5(), finalTimeout)
                : null;
        Future<Object> future = executorService.submit(() -> {
            try {
                if (executionHandle != null) {
                    executionHandle.recordThreadName(Thread.currentThread().getName());
                }
                return holder.invoke(methodName, params, logger);
            } finally {
                if (executionHandle != null) {
                    executionHandle.complete();
                }
            }
        });

        try {
            Object result = future.get(finalTimeout, TimeUnit.SECONDS);
            long costMs = System.currentTimeMillis() - startTime;
            return ScriptExecuteResult.success(result, logger.getLogs(), costMs);
        } catch (TimeoutException e) {
            if (executionHandle != null) {
                executionHandle.markTimedOut();
            }
            future.cancel(true);
            long costMs = System.currentTimeMillis() - startTime;
            logger.println("\n[ERROR] Execution timeout after " + finalTimeout + " seconds. Cancelled.");
            return ScriptExecuteResult.fail("Execution Timeout (" + finalTimeout + "s)", logger.getLogs(), costMs);
        } catch (Throwable e) {
            Throwable root = unwrapException(e);
            long costMs = System.currentTimeMillis() - startTime;

            StringWriter sw = new StringWriter();
            root.printStackTrace(new PrintWriter(sw));
            logger.println("\n[ERROR Exception]:\n" + sw);

            String errorMsg = root.getMessage() != null ? root.getMessage() : root.toString();
            return ScriptExecuteResult.fail(errorMsg, logger.getLogs(), costMs);
        }
    }

    public ScriptExecuteResult invoke(String scriptKey, Map<String, Object> params, int timeoutSeconds) {
        return invoke(scriptKey, null, params, timeoutSeconds);
    }

    private void checkCodeSecurity(String scriptKey, String scriptSource) {
        for (LiveRunnerCodeValidator validator : codeValidators) {
            CodeValidationResult checkRes = validator.validate(scriptKey, scriptSource);
            if (checkRes != null && checkRes.isDenied()) {
                throw new SecurityException(checkRes.getReason());
            }
        }
    }

    private Throwable unwrapException(Throwable e) {
        Throwable current = e;
        while (current != null) {
            if (current instanceof ExecutionException && current.getCause() != null) {
                current = current.getCause();
            } else if (current instanceof InvocationTargetException && current.getCause() != null) {
                current = current.getCause();
            } else if (current.getClass().getName().contains("UndeclaredThrowableException") && current.getCause() != null) {
                current = current.getCause();
            } else {
                break;
            }
        }
        return current != null ? current : e;
    }

    private String calculateMd5(String source) {
        try {
            byte[] md5 = MessageDigest.getInstance("MD5").digest(source.getBytes(StandardCharsets.UTF_8));
            return new BigInteger(1, md5).toString(16);
        } catch (Exception e) {
            return String.valueOf(source.hashCode());
        }
    }

    private volatile java.util.function.BooleanSupplier securityCheckEnabledSupplier;

    public boolean isSecurityCheckEnabled() {
        return securityCheckEnabledSupplier != null ? securityCheckEnabledSupplier.getAsBoolean() : securityCheckEnabled;
    }

    public void setSecurityCheckEnabled(boolean securityCheckEnabled) {
        this.securityCheckEnabled = securityCheckEnabled;
        this.securityCheckEnabledSupplier = () -> securityCheckEnabled;
    }

    public void setSecurityCheckEnabled(java.util.function.BooleanSupplier securityCheckEnabledSupplier) {
        this.securityCheckEnabledSupplier = securityCheckEnabledSupplier != null ? securityCheckEnabledSupplier : () -> true;
    }

    public List<LiveRunnerCodeValidator> getCodeValidators() {
        return Collections.unmodifiableList(new ArrayList<>(codeValidators));
    }

    public void setCodeValidators(List<LiveRunnerCodeValidator> validators) {
        this.codeValidators.clear();
        if (validators != null) {
            this.codeValidators.addAll(validators);
        }
    }

    public ScriptExecutionWatch getExecutionWatch() {
        return executionWatch;
    }

    public void setExecutionWatch(ScriptExecutionWatch executionWatch) {
        this.executionWatch = executionWatch;
    }

    public ScriptRegistry getRegistry() {
        return registry;
    }

    public ExecutorService getExecutorService() {
        return executorService;
    }

    public void shutdown() {
        executorService.shutdown();
        registry.clear();
    }
}
