package io.github.zlpawn.liverunner.core.security;

/**
 * Dynamic code safety and compliance inspection SPI.
 *
 * Applications can implement one or more beans of this interface in their Spring context
 * to enforce custom code auditing rules before scripts are compiled.
 *
 * Ordering:
 * Implementations can be ordered using Spring's standard {@code @Order(n)} annotation or by implementing
 * {@code org.springframework.core.Ordered}.
 *
 * @author Leo (zlpawn)
 */
@FunctionalInterface
public interface LiveRunnerCodeValidator {

    /**
     * Validate the dynamic script source code before compilation.
     *
     * @param scriptKey    optional script key (may be null for one-shot execution)
     * @param scriptSource raw Java/Groovy code string
     * @return {@link CodeValidationResult} indicating allow or deny with violation details
     */
    CodeValidationResult validate(String scriptKey, String scriptSource);
}
