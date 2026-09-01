package io.github.zlpawn.liverunner.core.model;

import java.io.Serializable;

/**
 * Metric item descriptor for LiveRunner runtime status.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerStatusItem implements Serializable {
    private static final long serialVersionUID = 1L;

    /**
     * Metric name / key (e.g. "threadPool.activeCount", "stuckTask.activeStuckTaskCount").
     */
    private String name;

    /**
     * Current real-time metric value.
     */
    private Object value;

    /**
     * Human-readable explanation of this metric.
     */
    private String desc;

    /**
     * Unit of measurement (e.g. "threads", "tasks", "scripts").
     */
    private String unit;

    /**
     * Category grouping (e.g. "工作线程池监控", "卡死任务监控", "脚本注册表").
     */
    private String group;

    public LiveRunnerStatusItem() {
    }

    public LiveRunnerStatusItem(String name, Object value, String desc, String unit, String group) {
        this.name = name;
        this.value = value;
        this.desc = desc;
        this.unit = unit != null ? unit : "";
        this.group = group != null ? group : "";
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Object getValue() {
        return value;
    }

    public void setValue(Object value) {
        this.value = value;
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

    public String getGroup() {
        return group;
    }

    public void setGroup(String group) {
        this.group = group;
    }
}
