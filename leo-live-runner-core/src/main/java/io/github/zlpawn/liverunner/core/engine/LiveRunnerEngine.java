package io.github.zlpawn.liverunner.core.engine;

import io.github.zlpawn.liverunner.core.LiveLogger;
import io.github.zlpawn.liverunner.core.LiveRunnerClassLoader;
import io.github.zlpawn.liverunner.core.model.ScriptExecuteResult;
import io.github.zlpawn.liverunner.core.model.ScriptHolder;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import io.github.zlpawn.liverunner.core.security.SecurityChecker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
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
    private volatile boolean securityCheckEnabled = true;

    public LiveRunnerEngine(ScriptRegistry registry) {
        this.registry = registry;
        this.executorService = new ThreadPoolExecutor(
                2,
                10,
                60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(100),
                r -> {
                    Thread t = new Thread(r, "LiveRunner-Worker-" + System.currentTimeMillis());
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.CallerRunsPolicy()
        );
    }

    public LiveRunnerEngine(ScriptRegistry registry, ExecutorService executorService) {
        this.registry = registry;
        this.executorService = executorService;
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
        if (securityCheckEnabled) {
            SecurityChecker.checkSourceCode(scriptSource);
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
        if (securityCheckEnabled) {
            try {
                SecurityChecker.checkSourceCode(scriptSource);
            } catch (SecurityException e) {
                long costMs = System.currentTimeMillis() - startTime;
                logger.println("\n[SECURITY ERROR]: " + e.getMessage());
                return ScriptExecuteResult.fail(e.getMessage(), logger.getLogs(), costMs);
            }
        }

        int finalTimeout = timeoutSeconds > 0 ? timeoutSeconds : 60;
        LiveRunnerClassLoader tempClassLoader = null;

        try {
            tempClassLoader = new LiveRunnerClassLoader(Thread.currentThread().getContextClassLoader());
            Class<?> scriptClass = tempClassLoader.parseClass(scriptSource);
            Object scriptInstance = scriptClass.getDeclaredConstructor().newInstance();

            if (beanPostProcessor != null) {
                scriptInstance = beanPostProcessor.apply(scriptInstance);
            }

            ScriptHolder tempHolder = new ScriptHolder("one-shot-temp", 1, calculateMd5(scriptSource),
                    "One-Shot Execution", tempClassLoader, scriptClass, scriptInstance);

            Future<Object> future = executorService.submit(() -> {
                try {
                    return tempHolder.invoke(methodName, params, logger);
                } finally {
                    tempHolder.destroy();
                }
            });

            Object result = future.get(finalTimeout, TimeUnit.SECONDS);
            long costMs = System.currentTimeMillis() - startTime;
            return ScriptExecuteResult.success(result, logger.getLogs(), costMs);
        } catch (TimeoutException e) {
            if (tempClassLoader != null) {
                tempClassLoader.unload();
            }
            long costMs = System.currentTimeMillis() - startTime;
            logger.println("\n[ERROR] Execution timeout after " + finalTimeout + " seconds. Cancelled.");
            return ScriptExecuteResult.fail("Execution Timeout (" + finalTimeout + "s)", logger.getLogs(), costMs);
        } catch (Throwable e) {
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

        Future<Object> future = executorService.submit(() -> holder.invoke(methodName, params, logger));

        try {
            Object result = future.get(finalTimeout, TimeUnit.SECONDS);
            long costMs = System.currentTimeMillis() - startTime;
            return ScriptExecuteResult.success(result, logger.getLogs(), costMs);
        } catch (TimeoutException e) {
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

    private Throwable unwrapException(Throwable e) {
        Throwable current = e;
        while (current != null) {
            if (current instanceof ExecutionException && current.getCause() != null) {
                current = current.getCause();
            } else if (current instanceof InvocationTargetException && current.getCause() != null) {
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

    public boolean isSecurityCheckEnabled() {
        return securityCheckEnabled;
    }

    public void setSecurityCheckEnabled(boolean securityCheckEnabled) {
        this.securityCheckEnabled = securityCheckEnabled;
    }

    public ScriptRegistry getRegistry() {
        return registry;
    }

    public void shutdown() {
        executorService.shutdown();
        registry.clear();
    }
}
