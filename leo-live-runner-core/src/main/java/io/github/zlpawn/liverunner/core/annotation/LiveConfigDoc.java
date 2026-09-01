package io.github.zlpawn.liverunner.core.annotation;

import java.lang.annotation.*;

/**
 * Annotation to describe LiveRunner configuration properties for automatic catalog generation.
 *
 * @author Leo (zlpawn)
 */
@Target({ElementType.FIELD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface LiveConfigDoc {

    /**
     * Explicit Apollo / Spring Boot configuration key.
     * If omitted, it will be automatically generated from property prefix and field name.
     */
    String key() default "";

    /**
     * Human-readable description of what this configuration controls and its safety effect.
     */
    String desc() default "";

    /**
     * Unit of measurement (e.g. "seconds", "KB", "threads", "rows", "records", or "" for boolean/string).
     */
    String unit() default "";

    /**
     * Whether this configuration supports real-time dynamic modification via Apollo / Nacos without service restart.
     */
    boolean dynamic() default false;

    /**
     * Functional category group name (e.g. "安全沙箱与只读控制", "工作线程池配置").
     */
    String group() default "";
}
