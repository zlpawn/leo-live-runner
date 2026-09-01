package io.github.zlpawn.liverunner.core.security.rule;

import java.util.regex.Pattern;

/**
 * Message queue safety rules.
 * Intercepts producing/sending messages via Kafka, RocketMQ, RabbitMQ in read-only mode.
 *
 * @author Leo (zlpawn)
 */
public class MqSafetyRule implements SecurityRule {

    public static final MqSafetyRule INSTANCE = new MqSafetyRule();

    private final java.util.function.BooleanSupplier readOnlyModeSupplier;

    public MqSafetyRule() {
        this(true);
    }

    public MqSafetyRule(boolean readOnlyMode) {
        this(() -> readOnlyMode);
    }

    public MqSafetyRule(java.util.function.BooleanSupplier readOnlyModeSupplier) {
        this.readOnlyModeSupplier = readOnlyModeSupplier != null ? readOnlyModeSupplier : () -> true;
    }

    public boolean isReadOnlyMode() {
        return readOnlyModeSupplier != null && readOnlyModeSupplier.getAsBoolean();
    }

    // Matches Kafka, RocketMQ, RabbitMQ template / producer sending invocations
    private static final Pattern PATTERN_MQ_SEND = Pattern.compile(
            "(\\b(kafkaTemplate|rocketMQTemplate|rabbitTemplate|producer|kafkaProducer|defaultMQProducer)\\s*\\.\\s*(send|sendDefault|syncSend|asyncSend|sendOneWay|convertAndSend|sendAndReceive)\\s*\\(|\\.(syncSend|asyncSend|sendOneWay|convertAndSend)\\s*\\()",
            Pattern.CASE_INSENSITIVE
    );

    @Override
    public String getName() {
        return SecurityRuleType.MQ_SAFETY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty() || !isReadOnlyMode()) {
            return RuleResult.pass();
        }

        return checkMqSendOperation(scriptSource);
    }

    public static RuleResult checkMqSendOperation(String scriptSource) {
        if (scriptSource != null && PATTERN_MQ_SEND.matcher(scriptSource).find()) {
            return RuleResult.fail("Read-Only Violation: Producing messages via Kafka/RocketMQ/RabbitMQ is strictly forbidden in read-only mode.");
        }
        return RuleResult.pass();
    }
}
