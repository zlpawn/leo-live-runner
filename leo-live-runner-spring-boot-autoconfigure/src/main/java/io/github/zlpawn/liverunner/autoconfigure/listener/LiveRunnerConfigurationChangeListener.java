package io.github.zlpawn.liverunner.autoconfigure.listener;

import io.github.zlpawn.liverunner.autoconfigure.pool.LiveRunnerThreadPoolRefresher;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.security.DefaultSecurityCheckerValidator;
import io.github.zlpawn.liverunner.core.security.LiveRunnerCodeValidator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Event and trigger listener for configuration changes.
 * Automatically refreshes dynamic thread pool and active security rules when configuration changes.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerConfigurationChangeListener {
    private static final Logger log = LoggerFactory.getLogger(LiveRunnerConfigurationChangeListener.class);

    private final LiveRunnerProperties properties;
    private final LiveRunnerThreadPoolRefresher threadPoolRefresher;
    private final LiveRunnerEngine engine;

    public LiveRunnerConfigurationChangeListener(LiveRunnerProperties properties,
                                                LiveRunnerThreadPoolRefresher threadPoolRefresher,
                                                LiveRunnerEngine engine) {
        this.properties = properties;
        this.threadPoolRefresher = threadPoolRefresher;
        this.engine = engine;
    }

    /**
     * Trigger refresh of dynamic components.
     */
    public void onConfigurationRefresh() {
        log.info("LiveRunner: Refreshing dynamic configurations and components...");

        // 1. Refresh thread pool
        if (threadPoolRefresher != null && properties != null) {
            threadPoolRefresher.refresh(properties);
        }

        // 2. Refresh engine security check flag
        if (engine != null && properties != null) {
            engine.setSecurityCheckEnabled(properties.isSecurityCheckEnabled());

            // 3. Reload granular security rules in DefaultSecurityCheckerValidator if present
            for (LiveRunnerCodeValidator validator : engine.getCodeValidators()) {
                if (validator instanceof DefaultSecurityCheckerValidator) {
                    DefaultSecurityCheckerValidator defaultVal = (DefaultSecurityCheckerValidator) validator;
                    defaultVal.reloadRules(DefaultSecurityCheckerValidator.createDefaultRules(
                            properties.getSecurity().getSql().isAllowDdl(),
                            properties.getSecurity().getSql().isAllowMissingWhere(),
                            properties.getSecurity().getRedis().isAllowDangerousKeys(),
                            properties.getSecurity().getSystem().isAllowProcessExec()
                    ));
                    log.info("LiveRunner: Reloaded default security rules with latest allow-xxx properties.");
                }
            }
        }
    }
}