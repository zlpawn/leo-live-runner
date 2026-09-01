package io.github.zlpawn.liverunner.core.watch;

/**
 * SPI for observing dynamic script execution lifecycle.
 */
public interface ScriptExecutionWatch {
    ScriptExecutionHandle start(String scriptKey, String scriptMd5, int timeoutSeconds);

    void check();

    ScriptWatchSnapshot snapshot();

    void updateSettings(ScriptExecutionWatchSettings settings);
}
