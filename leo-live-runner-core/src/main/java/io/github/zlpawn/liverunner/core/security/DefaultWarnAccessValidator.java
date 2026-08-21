package io.github.zlpawn.liverunner.core.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Default fallback access validator when no custom {@link LiveRunnerAccessValidator} is defined.
 * Emits a warning log reminding developers to implement a production access validator, and allows the request.
 *
 * @author Leo (zlpawn)
 */
public class DefaultWarnAccessValidator implements LiveRunnerAccessValidator {
    private static final Logger log = LoggerFactory.getLogger(DefaultWarnAccessValidator.class);

    @Override
    public AccessResult validate(AccessContext context) {
        log.warn("[LiveRunner WARN] No custom LiveRunnerAccessValidator bean configured in Spring context! " +
                        "Allowing access to endpoint [{}] from IP [{}] by default. " +
                        "For production environments, please implement LiveRunnerAccessValidator in your project.",
                context.getEndpoint(), context.getClientIp());
        return AccessResult.allow();
    }
}
