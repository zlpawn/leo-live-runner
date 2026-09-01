package io.github.zlpawn.liverunner.autoconfigure.watch;

import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatch;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatchSettings;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public class StuckTaskWatchScheduler {
    private static final Logger log = LoggerFactory.getLogger(StuckTaskWatchScheduler.class);

    private final ScriptExecutionWatch watch;
    private final java.util.function.Supplier<ScriptExecutionWatchSettings> settingsSupplier;
    private final ScheduledExecutorService scheduler;
    private final Object lock = new Object();
    private volatile ScheduledFuture<?> scheduledFuture;

    public StuckTaskWatchScheduler(ScriptExecutionWatch watch,
                                   java.util.function.Supplier<ScriptExecutionWatchSettings> settingsSupplier) {
        this(watch, settingsSupplier, Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "LiveRunner-Stuck-Task-Checker");
            thread.setDaemon(true);
            return thread;
        }));
    }

    StuckTaskWatchScheduler(ScriptExecutionWatch watch,
                            java.util.function.Supplier<ScriptExecutionWatchSettings> settingsSupplier,
                            ScheduledExecutorService scheduler) {
        this.watch = watch;
        this.settingsSupplier = settingsSupplier;
        this.scheduler = scheduler;
    }

    public void start(long initialDelaySeconds) {
        reschedule(initialDelaySeconds);
    }

    public void shutdown() {
        synchronized (lock) {
            if (scheduledFuture != null) {
                scheduledFuture.cancel(true);
                scheduledFuture = null;
            }
        }
        scheduler.shutdownNow();
    }

    private void reschedule(long delaySeconds) {
        synchronized (lock) {
            if (scheduledFuture != null) {
                scheduledFuture.cancel(false);
            }
            int intervalSeconds = settingsSupplier.get().getCheckIntervalSeconds();
            scheduledFuture = scheduler.scheduleWithFixedDelay(this::safeCheck, delaySeconds,
                    intervalSeconds, TimeUnit.SECONDS);
            log.info("LiveRunner: Stuck-task watch scheduled every [{}]s", intervalSeconds);
        }
    }

    private void safeCheck() {
        try {
            watch.updateSettings(settingsSupplier.get());
            watch.check();
        } catch (Throwable e) {
            log.error("LiveRunner: Failed to check stuck tasks", e);
        }
    }
}
