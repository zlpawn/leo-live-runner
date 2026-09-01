package io.github.zlpawn.liverunner.core.watch;

public class ScriptTaskSnapshot {
    private final long taskId;
    private final String scriptKey;
    private final String scriptMd5;
    private final String threadName;
    private final int timeoutSeconds;
    private final long elapsedSeconds;

    public ScriptTaskSnapshot(long taskId, String scriptKey, String scriptMd5, String threadName,
                              int timeoutSeconds, long elapsedSeconds) {
        this.taskId = taskId;
        this.scriptKey = scriptKey;
        this.scriptMd5 = scriptMd5;
        this.threadName = threadName;
        this.timeoutSeconds = timeoutSeconds;
        this.elapsedSeconds = elapsedSeconds;
    }

    public long getTaskId() {
        return taskId;
    }

    public String getScriptKey() {
        return scriptKey;
    }

    public String getScriptMd5() {
        return scriptMd5;
    }

    public String getThreadName() {
        return threadName;
    }

    public int getTimeoutSeconds() {
        return timeoutSeconds;
    }

    public long getElapsedSeconds() {
        return elapsedSeconds;
    }
}
