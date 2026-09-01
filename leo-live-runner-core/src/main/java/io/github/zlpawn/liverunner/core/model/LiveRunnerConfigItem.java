package io.github.zlpawn.liverunner.core.model;

import java.io.Serializable;

/**
 * Metadata and runtime effective value descriptor for a configuration property.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerConfigItem implements Serializable {
    private static final long serialVersionUID = 1L;

    /**
     * Standard Apollo / Nacos / Spring Boot configuration key.
     * e.g. "leo.live-runner.security.read-only-mode"
     */
    private String key;

    /**
     * Current real-time effective value in the runtime environment.
     */
    private Object value;

    /**
     * Default value if not configured.
     */
    private Object defaultValue;

    /**
     * Human-readable description of what this configuration controls and its safety effect.
     */
    private String desc;

    /**
     * Unit of measurement (e.g. "seconds", "KB", "threads", "rows", or "" for boolean/strings).
     */
    private String unit;

    /**
     * Whether this configuration supports real-time dynamic modification via Apollo / Nacos without service restart.
     */
    private boolean dynamic;

    /**
     * Functional category group name (e.g. "安全沙箱与只读控制", "工作线程池配置").
     */
    private String group;

    public LiveRunnerConfigItem() {
    }

    public LiveRunnerConfigItem(String key, Object value, Object defaultValue, String desc, String unit, boolean dynamic, String group) {
        this.key = key;
        this.value = value;
        this.defaultValue = defaultValue;
        this.desc = desc;
        this.unit = unit != null ? unit : "";
        this.dynamic = dynamic;
        this.group = group != null ? group : "";
    }

    public String getKey() {
        return key;
    }

    public void setKey(String key) {
        this.key = key;
    }

    public Object getValue() {
        return value;
    }

    public void setValue(Object value) {
        this.value = value;
    }

    public Object getDefaultValue() {
        return defaultValue;
    }

    public void setDefaultValue(Object defaultValue) {
        this.defaultValue = defaultValue;
    }

    public String getDesc() {
        return desc;
    }

    public void setDesc(String desc) {
        this.desc = desc;
    }

    public String getUnit() {
        return unit;
    }

    public void setUnit(String unit) {
        this.unit = unit;
    }

    public boolean isDynamic() {
        return dynamic;
    }

    public void setDynamic(boolean dynamic) {
        this.dynamic = dynamic;
    }

    public String getGroup() {
        return group;
    }

    public void setGroup(String group) {
        this.group = group;
    }
}
