package io.github.zlpawn.liverunner.core.watch;

public class ScriptExecutionWatchSettings {
    private boolean enabled = true;
    private int graceSeconds = 60;
    private int checkIntervalSeconds = 10;
    private int maxRecordedStuckTasks = 100;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public int getGraceSeconds() {
        return graceSeconds;
    }

    public void setGraceSeconds(int graceSeconds) {
        this.graceSeconds = Math.max(1, graceSeconds);
    }

    public int getCheckIntervalSeconds() {
        return checkIntervalSeconds;
    }

    public void setCheckIntervalSeconds(int checkIntervalSeconds) {
        this.checkIntervalSeconds = Math.max(1, checkIntervalSeconds);
    }

    public int getMaxRecordedStuckTasks() {
        return maxRecordedStuckTasks;
    }

    public void setMaxRecordedStuckTasks(int maxRecordedStuckTasks) {
        this.maxRecordedStuckTasks = Math.max(1, maxRecordedStuckTasks);
    }
}
