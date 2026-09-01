package io.github.zlpawn.liverunner.core.watch;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.TimeUnit;

class DefaultScriptExecutionWatchTest {

    @Test
    void shouldRemoveTaskWhenItCompletes() {
        TestClock clock = new TestClock();
        DefaultScriptExecutionWatch watch = new DefaultScriptExecutionWatch(settings(), clock);

        ScriptExecutionHandle handle = watch.start("one-shot", "md5", 30);
        Assertions.assertTrue(handle.isRunning());
        handle.complete();
        Assertions.assertFalse(handle.isRunning());

        clock.advance(61, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(0, watch.snapshot().getActiveStuckTaskCount());
        Assertions.assertTrue(watch.snapshot().getStuckTasks().isEmpty());
    }

    @Test
    void shouldKeepObservingTimedOutTaskUntilGraceExpires() {
        TestClock clock = new TestClock();
        DefaultScriptExecutionWatch watch = new DefaultScriptExecutionWatch(settings(), clock);
        ScriptExecutionHandle handle = watch.start("one-shot", "md5", 30);
        handle.markTimedOut();

        clock.advance(59, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(0, watch.snapshot().getActiveStuckTaskCount());

        clock.advance(2, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(1, watch.snapshot().getActiveStuckTaskCount());
        Assertions.assertEquals(1, watch.snapshot().getTotalStuckTaskCount());

        List<ScriptTaskSnapshot> tasks = watch.snapshot().getStuckTasks();
        Assertions.assertEquals(handle.getTaskId(), tasks.get(0).getTaskId());
        Assertions.assertEquals("one-shot", tasks.get(0).getScriptKey());
        Assertions.assertEquals("md5", tasks.get(0).getScriptMd5());
    }

    @Test
    void shouldClearStuckTaskAfterDelayedCompletion() {
        TestClock clock = new TestClock();
        DefaultScriptExecutionWatch watch = new DefaultScriptExecutionWatch(settings(), clock);
        ScriptExecutionHandle handle = watch.start("one-shot", "md5", 30);
        handle.markTimedOut();

        clock.advance(61, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(1, watch.snapshot().getActiveStuckTaskCount());

        handle.complete();
        watch.check();
        Assertions.assertEquals(0, watch.snapshot().getActiveStuckTaskCount());
        Assertions.assertEquals(1, watch.snapshot().getTotalStuckTaskCount());
    }

    @Test
    void shouldHonorDynamicallyUpdatedSettings() {
        TestClock clock = new TestClock();
        DefaultScriptExecutionWatch watch = new DefaultScriptExecutionWatch(settings(), clock);
        ScriptExecutionHandle handle = watch.start("one-shot", "md5", 30);
        handle.markTimedOut();

        ScriptExecutionWatchSettings newSettings = new ScriptExecutionWatchSettings();
        newSettings.setGraceSeconds(10);
        watch.updateSettings(newSettings);

        clock.advance(11, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(1, watch.snapshot().getActiveStuckTaskCount());

        watch.updateSettings(settings(false, 60));
        clock.advance(60, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(0, watch.snapshot().getActiveStuckTaskCount());
    }

    @Test
    void shouldLimitReturnedStuckTaskSnapshots() {
        TestClock clock = new TestClock();
        DefaultScriptExecutionWatch watch = new DefaultScriptExecutionWatch(settings(), clock);
        for (int i = 0; i < 3; i++) {
            ScriptExecutionHandle handle = watch.start("one-shot-" + i, "md5-" + i, 30);
            handle.markTimedOut();
        }

        clock.advance(61, TimeUnit.SECONDS);
        watch.check();
        Assertions.assertEquals(3, watch.snapshot().getActiveStuckTaskCount());
        Assertions.assertEquals(2, watch.snapshot().getStuckTasks().size());
    }

    private static ScriptExecutionWatchSettings settings() {
        return settings(true, 60);
    }

    private static ScriptExecutionWatchSettings settings(boolean enabled, int graceSeconds) {
        ScriptExecutionWatchSettings settings = new ScriptExecutionWatchSettings();
        settings.setEnabled(enabled);
        settings.setGraceSeconds(graceSeconds);
        settings.setMaxRecordedStuckTasks(2);
        return settings;
    }

    private static final class TestClock implements ScriptExecutionClock {
        private long nowMillis;

        @Override
        public long currentTimeMillis() {
            return nowMillis;
        }

        private void advance(long duration, TimeUnit unit) {
            nowMillis += unit.toMillis(duration);
        }
    }
}
