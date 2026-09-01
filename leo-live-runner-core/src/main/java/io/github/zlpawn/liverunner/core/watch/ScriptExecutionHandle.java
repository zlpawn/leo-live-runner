package io.github.zlpawn.liverunner.core.watch;

public interface ScriptExecutionHandle {
    long getTaskId();

    boolean isRunning();

    void markTimedOut();

    void recordThreadName(String threadName);

    void complete();
}
