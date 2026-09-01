package io.github.zlpawn.liverunner.autoconfigure.config;

import io.github.zlpawn.liverunner.autoconfigure.controller.LiveRunnerController;
import io.github.zlpawn.liverunner.autoconfigure.injector.SpringBeanInjector;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator;
import io.github.zlpawn.liverunner.core.security.DefaultWarnAccessValidator;
import io.github.zlpawn.liverunner.core.security.LiveRunnerAccessValidator;
import io.github.zlpawn.liverunner.core.security.LiveRunnerCodeValidator;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import io.github.zlpawn.liverunner.autoconfigure.pool.LiveRunnerThreadPoolRefresher;
import io.github.zlpawn.liverunner.core.pool.ResizableLinkedBlockingQueue;
import io.github.zlpawn.liverunner.core.security.rule.SecurityRule;
import io.github.zlpawn.liverunner.core.watch.DefaultScriptExecutionWatch;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatch;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatchSettings;
import io.github.zlpawn.liverunner.autoconfigure.watch.StuckTaskWatchScheduler;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.core.env.Environment;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * Spring Boot AutoConfiguration for Leo Live Runner.
 * Configures ScriptRegistry, dynamic Resizable Worker ExecutorService, LiveRunnerCodeValidator,
 * SpringBeanInjector, LiveRunnerThreadPoolRefresher, and REST Controller.
 *
 * @author Leo (zlpawn)
 */
@Configuration
@ConditionalOnWebApplication
@EnableConfigurationProperties(LiveRunnerProperties.class)
@ConditionalOnProperty(prefix = "leo.live-runner", name = "enabled", havingValue = "true", matchIfMissing = true)
public class LiveRunnerAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public ScriptRegistry scriptRegistry() {
        return new ScriptRegistry();
    }

    @Bean(name = "liveRunnerExecutorService")
    @ConditionalOnMissingBean(name = "liveRunnerExecutorService")
    public ExecutorService liveRunnerExecutorService(LiveRunnerProperties properties) {
        return new ThreadPoolExecutor(
                properties.getCorePoolSize(),
                properties.getMaxPoolSize(),
                properties.getKeepAliveSeconds(), TimeUnit.SECONDS,
                new ResizableLinkedBlockingQueue<>(properties.getQueueCapacity()),
                r -> {
                    Thread t = new Thread(r, properties.getThreadNamePrefix() + System.currentTimeMillis());
                    t.setDaemon(true);
                    return t;
                },
                properties.getRejectionPolicy().toHandler()
        );
    }

    @Bean(name = "liveRunnerThreadPoolRefresher")
    @ConditionalOnMissingBean(LiveRunnerThreadPoolRefresher.class)
    public LiveRunnerThreadPoolRefresher liveRunnerThreadPoolRefresher(
            @Qualifier("liveRunnerExecutorService") ExecutorService liveRunnerExecutorService) {
        if (liveRunnerExecutorService instanceof ThreadPoolExecutor) {
            return new LiveRunnerThreadPoolRefresher((ThreadPoolExecutor) liveRunnerExecutorService);
        }
        return null;
    }

    @Bean(name = "liveRunnerExecutionWatch")
    @ConditionalOnMissingBean(ScriptExecutionWatch.class)
    public DefaultScriptExecutionWatch liveRunnerExecutionWatch(LiveRunnerProperties properties) {
        return new DefaultScriptExecutionWatch(toWatchSettings(properties));
    }

    @Bean(destroyMethod = "shutdown")
    @ConditionalOnMissingBean(StuckTaskWatchScheduler.class)
    public StuckTaskWatchScheduler liveRunnerStuckTaskWatchScheduler(
            @Qualifier("liveRunnerExecutionWatch") ScriptExecutionWatch watch,
            LiveRunnerProperties properties) {
        StuckTaskWatchScheduler scheduler = new StuckTaskWatchScheduler(
                watch, () -> toWatchSettings(properties));
        scheduler.start(properties.getStuckTask().getCheckIntervalSeconds());
        return scheduler;
    }

    @Bean
    @ConditionalOnMissingBean(LiveRunnerCodeValidator.class)
    public DefaultSecurityCheckerValidator defaultSecurityCheckerValidator(LiveRunnerProperties properties,
                                                                            Environment env) {
        BooleanSupplier readOnlySupplier = () -> resolveBooleanProperty(env, "leo.live-runner.security.read-only-mode", "leo.live-runner.security.readOnlyMode", properties.isReadOnlyMode());
        BooleanSupplier allowDdlSupplier = () -> resolveBooleanProperty(env, "leo.live-runner.security.sql.allow-ddl", "leo.live-runner.security.sql.allowDdl", properties.getSecurity().getSql().isAllowDdl());
        BooleanSupplier allowMissingWhereSupplier = () -> resolveBooleanProperty(env, "leo.live-runner.security.sql.allow-missing-where", "leo.live-runner.security.sql.allowMissingWhere", properties.getSecurity().getSql().isAllowMissingWhere());
        BooleanSupplier allowDangerousKeysSupplier = () -> resolveBooleanProperty(env, "leo.live-runner.security.redis.allow-dangerous-keys", "leo.live-runner.security.redis.allowDangerousKeys", properties.getSecurity().getRedis().isAllowDangerousKeys());
        BooleanSupplier allowProcessExecSupplier = () -> resolveBooleanProperty(env, "leo.live-runner.security.system.allow-process-exec", "leo.live-runner.security.system.allowProcessExec", properties.getSecurity().getSystem().isAllowProcessExec());

        List<SecurityRule> rules = DefaultSecurityCheckerValidator.createDefaultRules(
                readOnlySupplier,
                allowDdlSupplier,
                allowMissingWhereSupplier,
                allowDangerousKeysSupplier,
                allowProcessExecSupplier
        );
        return new DefaultSecurityCheckerValidator(rules);
    }

    @Bean
    @ConditionalOnMissingBean
    public LiveRunnerEngine liveRunnerEngine(ScriptRegistry scriptRegistry,
                                            LiveRunnerProperties properties,
                                            ExecutorService liveRunnerExecutorService,
                                            ScriptExecutionWatch executionWatch,
                                            Environment env,
                                            ObjectProvider<List<LiveRunnerCodeValidator>> codeValidatorsProvider) {
        List<LiveRunnerCodeValidator> codeValidators = codeValidatorsProvider.getIfAvailable(ArrayList::new);
        AnnotationAwareOrderComparator.sort(codeValidators);
        io.github.zlpawn.liverunner.core.LiveLogger.setGlobalMaxLogLength(properties.getMaxLogBufferSizeKb() * 1024);
        LiveRunnerEngine engine = new LiveRunnerEngine(scriptRegistry, liveRunnerExecutorService, codeValidators);
        engine.setExecutionWatch(executionWatch);
        engine.setSecurityCheckEnabled(() -> resolveBooleanProperty(env, "leo.live-runner.security-check-enabled", "leo.live-runner.security.enabled", properties.isSecurityCheckEnabled()));
        return engine;
    }

    private static boolean resolveBooleanProperty(Environment env, String kebabKey, String camelKey, boolean defaultValue) {
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

    @Bean
    @ConditionalOnMissingBean
    public SpringBeanInjector springBeanInjector(ApplicationContext applicationContext, LiveRunnerProperties properties) {
        return new SpringBeanInjector(applicationContext, properties);
    }

    public static ScriptExecutionWatchSettings toWatchSettings(LiveRunnerProperties properties) {
        ScriptExecutionWatchSettings settings = new ScriptExecutionWatchSettings();
        LiveRunnerProperties.StuckTask stuckTask = properties.getStuckTask();
        settings.setEnabled(stuckTask.isDetectionEnabled());
        settings.setGraceSeconds(stuckTask.getGraceSeconds());
        settings.setCheckIntervalSeconds(stuckTask.getCheckIntervalSeconds());
        settings.setMaxRecordedStuckTasks(stuckTask.getMaxRecordedStuckTasks());
        return settings;
    }

    @Bean
    @ConditionalOnMissingBean(LiveRunnerAccessValidator.class)
    public DefaultWarnAccessValidator defaultWarnAccessValidator() {
        return new DefaultWarnAccessValidator();
    }

    @Bean
    @ConditionalOnMissingBean
    public LiveRunnerController liveRunnerController(LiveRunnerEngine engine,
                                                     SpringBeanInjector injector,
                                                     LiveRunnerProperties properties,
                                                     Environment env,
                                                     ObjectProvider<List<LiveRunnerAccessValidator>> validatorsProvider) {
        List<LiveRunnerAccessValidator> validators = validatorsProvider.getIfAvailable(ArrayList::new);
        return new LiveRunnerController(engine, injector, properties, validators, env);
    }
}
