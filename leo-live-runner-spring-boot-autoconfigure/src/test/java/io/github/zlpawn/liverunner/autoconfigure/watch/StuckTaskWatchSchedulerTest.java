package io.github.zlpawn.liverunner.autoconfigure.watch;

import io.github.zlpawn.liverunner.core.watch.DefaultScriptExecutionWatch;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatchSettings;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

class StuckTaskWatchSchedulerTest {

    @Test
    void shouldApplyCurrentSettingsWhenChecking() throws Exception {
        DefaultScriptExecutionWatch watch = new DefaultScriptExecutionWatch(settings(1));
        RecordingScheduler scheduler = new RecordingScheduler();
        StuckTaskWatchScheduler stuckScheduler = new StuckTaskWatchScheduler(
                watch, () -> settings(2), scheduler);
        stuckScheduler.start(1);
        scheduler.lastCommand.run();

        Assertions.assertEquals(1, scheduler.delaySeconds);
        Assertions.assertEquals(2, scheduler.periodSeconds);
        Assertions.assertEquals(2, watch.getCheckIntervalSeconds());
        stuckScheduler.shutdown();
        Assertions.assertTrue(scheduler.cancelled);
    }

    private static ScriptExecutionWatchSettings settings(int intervalSeconds) {
        ScriptExecutionWatchSettings settings = new ScriptExecutionWatchSettings();
        settings.setCheckIntervalSeconds(intervalSeconds);
        return settings;
    }

    private static final class RecordingScheduler implements ScheduledExecutorService {
        private long delaySeconds;
        private long periodSeconds;
        private boolean cancelled;
        private Runnable lastCommand;

        @Override
        public ScheduledFuture<?> scheduleWithFixedDelay(Runnable command, long initialDelay, long delay, TimeUnit unit) {
            lastCommand = command;
            delaySeconds = unit.toSeconds(initialDelay);
            periodSeconds = unit.toSeconds(delay);
            return new ScheduledFuture<Object>() {
                @Override
                public long getDelay(TimeUnit unit) {
                    return 0;
                }

                @Override
                public int compareTo(java.util.concurrent.Delayed o) {
                    return 0;
                }

                @Override
                public boolean cancel(boolean mayInterruptIfRunning) {
                    cancelled = true;
                    return true;
                }

                @Override
                public boolean isCancelled() {
                    return cancelled;
                }

                @Override
                public boolean isDone() {
                    return false;
                }

                @Override
                public Object get() {
                    throw new UnsupportedOperationException();
                }

                @Override
                public Object get(long timeout, TimeUnit unit) {
                    throw new UnsupportedOperationException();
                }
            };
        }

        @Override
        public void shutdown() {
        }

        @Override
        public java.util.List<Runnable> shutdownNow() {
            return java.util.Collections.emptyList();
        }

        @Override
        public boolean isShutdown() {
            return false;
        }

        @Override
        public boolean isTerminated() {
            return false;
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return true;
        }

        @Override
        public <T> ScheduledFuture<T> submit(java.util.concurrent.Callable<T> task) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> ScheduledFuture<T> submit(Runnable task, T result) {
            throw new UnsupportedOperationException();
        }

        @Override
        public ScheduledFuture<?> submit(Runnable task) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> java.util.List<java.util.concurrent.Future<T>> invokeAll(java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> java.util.List<java.util.concurrent.Future<T>> invokeAll(java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks, long timeout, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> T invokeAny(java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> T invokeAny(java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks, long timeout, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <V> ScheduledFuture<V> schedule(java.util.concurrent.Callable<V> callable, long delay, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override
        public ScheduledFuture<?> scheduleAtFixedRate(Runnable command, long initialDelay, long period, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void execute(Runnable command) {
            throw new UnsupportedOperationException();
        }
    }
}
