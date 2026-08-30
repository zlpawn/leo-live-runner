package io.github.zlpawn.liverunner.core.security.rule;

/**
 * Single security rule abstraction for evaluating dynamic scripts.
 * Inspired by Alibaba Druid WallFilter and Sentinel rule architecture.
 *
 * @author Leo (zlpawn)
 */
public interface SecurityRule {

    /**
     * Unique identifier or category name for this security rule.
     */
    String getName();

    /**
     * Evaluate the script source against this rule.
     *
     * @param scriptSource raw Java/Groovy code string
     * @return {@link RuleResult} indicating passed or failed with detailed violation message
     */
    RuleResult check(String scriptSource);
}
