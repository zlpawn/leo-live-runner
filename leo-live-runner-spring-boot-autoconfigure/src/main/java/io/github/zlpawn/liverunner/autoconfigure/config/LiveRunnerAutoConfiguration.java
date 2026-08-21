package io.github.zlpawn.liverunner.autoconfigure.config;

import io.github.zlpawn.liverunner.autoconfigure.controller.LiveRunnerController;
import io.github.zlpawn.liverunner.autoconfigure.injector.SpringBeanInjector;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Spring Boot AutoConfiguration for Leo Live Runner.
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

    @Bean
    @ConditionalOnMissingBean
    public LiveRunnerEngine liveRunnerEngine(ScriptRegistry scriptRegistry, LiveRunnerProperties properties) {
        ThreadPoolExecutor customExecutor = new ThreadPoolExecutor(
                properties.getCorePoolSize(),
                properties.getMaxPoolSize(),
                60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(200),
                r -> {
                    Thread t = new Thread(r, "LiveRunner-Worker-" + System.currentTimeMillis());
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.CallerRunsPolicy()
        );
        LiveRunnerEngine engine = new LiveRunnerEngine(scriptRegistry, customExecutor);
        engine.setSecurityCheckEnabled(properties.isSecurityCheckEnabled());
        return engine;
    }

    @Bean
    @ConditionalOnMissingBean
    public SpringBeanInjector springBeanInjector(ApplicationContext applicationContext) {
        return new SpringBeanInjector(applicationContext);
    }

    @Bean
    @ConditionalOnMissingBean
    public LiveRunnerController liveRunnerController(LiveRunnerEngine engine,
                                                     SpringBeanInjector injector,
                                                     LiveRunnerProperties properties) {
        return new LiveRunnerController(engine, injector, properties);
    }
}
