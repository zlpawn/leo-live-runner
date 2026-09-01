package io.github.zlpawn.liverunner.core.security.rule;

/**
 * Standard security rule type enumeration.
 * Defines the unique identifier codes and descriptions for all built-in security rules.
 *
 * @author Leo (zlpawn)
 */
public enum SecurityRuleType {

    /**
     * System and JVM level security rule.
     */
    SYSTEM_SECURITY("SYSTEM_SECURITY", "System and JVM level security inspection rule"),

    /**
     * Groovy compiler AST-level sandbox rule.
     */
    AST_SANDBOX_SECURITY("AST_SANDBOX_SECURITY", "Groovy AST-level compiler sandbox rule"),

    /**
     * Thread management and lifecycle rule.
     */
    THREAD_SECURITY("THREAD_SECURITY", "Thread management and lifecycle rule"),

    /**
     * Spring container and runtime environment configuration security rule.
     */
    SPRING_CONFIG_SECURITY("SPRING_CONFIG_SECURITY", "Spring environment and container tampering rule"),

    /**
     * Redis high-risk command and cache safety rule.
     */
    REDIS_SAFETY("REDIS_SAFETY", "Redis high-risk commands and cache safety rule"),

    /**
     * SQL DML data safety rule (WHERE clause enforcement).
     */
    SQL_DML_SAFETY("SQL_DML_SAFETY", "SQL DML safety inspection rule"),

    /**
     * SQL DDL schema and privilege safety rule.
     */
    SQL_DDL_SAFETY("SQL_DDL_SAFETY", "SQL DDL and schema/privilege safety inspection rule"),

    /**
     * Message queue produce/send safety inspection rule.
     */
    MQ_SAFETY("MQ_SAFETY", "Message queue produce and send safety inspection rule"),

    /**
     * HTTP / Feign client write operations safety inspection rule.
     */
    HTTP_SAFETY("HTTP_SAFETY", "HTTP / Feign client write operations safety inspection rule");

    private final String code;
    private final String description;

    SecurityRuleType(String code, String description) {
        this.code = code;
        this.description = description;
    }

    public String getCode() {
        return code;
    }

    public String getDescription() {
        return description;
    }

    @Override
    public String toString() {
        return code;
    }
}
