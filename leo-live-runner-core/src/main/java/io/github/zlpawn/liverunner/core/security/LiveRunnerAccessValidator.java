package io.github.zlpawn.liverunner.core.security;

/**
 * Live Runner Access Authentication & Authorization SPI.
 *
 * Applications can implement one or more beans of this interface in their Spring context
 * to customize access control (e.g. JWT verification, SSO token validation, IP whitelisting, RBAC).
 *
 * Ordering:
 * Implementations can be ordered using Spring's standard {@code @Order(n)} annotation or by implementing
 * {@code org.springframework.core.Ordered}.
 *
 * @author Leo (zlpawn)
 */
@FunctionalInterface
public interface LiveRunnerAccessValidator {

    /**
     * Validate whether the current request is authorized to proceed.
     *
     * @param context extensible request context containing endpoint, headers, client IP, parameters, etc.
     * @return {@link AccessResult} indicating allow/deny, status code, and custom error message
     */
    AccessResult validate(AccessContext context);
}
