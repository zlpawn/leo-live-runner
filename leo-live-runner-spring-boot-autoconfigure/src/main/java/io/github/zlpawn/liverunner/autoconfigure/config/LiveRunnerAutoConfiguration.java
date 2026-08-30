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
import io.github.zlpawn.liverunner.autoconfigure.listener.LiveRunnerConfigurationChangeListener;
import io.github.zlpawn.liverunner.autoconfigure.pool.LiveRunnerThreadPoolRefresher;
import io.github.zlpawn.liverunner.core.pool.ResizableLinkedBlockingQueue;
import io.github.zlpawn.liverunner.core.security.rule.SecurityRule;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.beans.factory.annotation.Qualifier;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

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

    @Bean
    @ConditionalOnMissingBean(LiveRunnerCodeValidator.class)
    public DefaultSecurityCheckerValidator defaultSecurityCheckerValidator(LiveRunnerProperties properties) {
        List<SecurityRule> rules = DefaultSecurityCheckerValidator.createDefaultRules(
                properties.getSecurity().getSql().isAllowDdl(),
                properties.getSecurity().getSql().isAllowMissingWhere(),
                properties.getSecurity().getRedis().isAllowDangerousKeys(),
                properties.getSecurity().getSystem().isAllowProcessExec()
        );
        return new DefaultSecurityCheckerValidator(rules);
    }

    @Bean
    @ConditionalOnMissingBean
    public LiveRunnerEngine liveRunnerEngine(ScriptRegistry scriptRegistry,
                                            LiveRunnerProperties properties,
                                            ExecutorService liveRunnerExecutorService,
                                            ObjectProvider<List<LiveRunnerCodeValidator>> codeValidatorsProvider) {
        List<LiveRunnerCodeValidator> codeValidators = codeValidatorsProvider.getIfAvailable(ArrayList::new);
        AnnotationAwareOrderComparator.sort(codeValidators);
        io.github.zlpawn.liverunner.core.LiveLogger.setGlobalMaxLogLength(properties.getMaxLogBufferSizeKb() * 1024);
        LiveRunnerEngine engine = new LiveRunnerEngine(scriptRegistry, liveRunnerExecutorService, codeValidators);
        engine.setSecurityCheckEnabled(properties.isSecurityCheckEnabled());
        return engine;
    }

    @Bean
    @ConditionalOnMissingBean
    public LiveRunnerConfigurationChangeListener liveRunnerConfigurationChangeListener(
            LiveRunnerProperties properties,
            ObjectProvider<LiveRunnerThreadPoolRefresher> threadPoolRefresherProvider,
            LiveRunnerEngine engine) {
        return new LiveRunnerConfigurationChangeListener(
                properties,
                threadPoolRefresherProvider.getIfAvailable(),
                engine
        );
    }

    @Bean
    @ConditionalOnMissingBean
    public SpringBeanInjector springBeanInjector(ApplicationContext applicationContext, LiveRunnerProperties properties) {
        return new SpringBeanInjector(applicationContext, properties);
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
                                                     ObjectProvider<List<LiveRunnerAccessValidator>> validatorsProvider) {
        List<LiveRunnerAccessValidator> validators = validatorsProvider.getIfAvailable(ArrayList::new);
        return new LiveRunnerController(engine, injector, properties, validators);
    }
}
