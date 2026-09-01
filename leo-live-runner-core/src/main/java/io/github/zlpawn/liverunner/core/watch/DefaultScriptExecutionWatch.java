package io.github.zlpawn.liverunner.core.watch;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

public class DefaultScriptExecutionWatch implements ScriptExecutionWatch {
    private static final Logger log = LoggerFactory.getLogger(DefaultScriptExecutionWatch.class);

    private final ScriptExecutionClock clock;
    private final Map<Long, ObservedTask> tasks = new ConcurrentHashMap<>();
    private final AtomicLong taskIdSequence = new AtomicLong();
    private final AtomicLong totalTimedOutTasks = new AtomicLong();
    private final AtomicLong totalStuckTasks = new AtomicLong();
    private volatile ScriptExecutionWatchSettings settings;

    public DefaultScriptExecutionWatch() {
        this(new ScriptExecutionWatchSettings(), System::currentTimeMillis);
    }

    public DefaultScriptExecutionWatch(ScriptExecutionWatchSettings settings) {
        this(settings, System::currentTimeMillis);
    }

    public DefaultScriptExecutionWatch(ScriptExecutionWatchSettings settings, ScriptExecutionClock clock) {
        this.settings = settings != null ? copy(settings) : new ScriptExecutionWatchSettings();
        this.clock = clock != null ? clock : System::currentTimeMillis;
    }

    @Override
    public ScriptExecutionHandle start(String scriptKey, String scriptMd5, int timeoutSeconds) {
        ObservedTask task = new ObservedTask(taskIdSequence.incrementAndGet(), scriptKey,
                scriptMd5 != null ? scriptMd5 : "", null, timeoutSeconds, clock.currentTimeMillis());
        tasks.put(task.getTaskId(), task);
        return task;
    }

    @Override
    public void check() {
        ScriptExecutionWatchSettings currentSettings = settings;
        if (!currentSettings.isEnabled()) {
            return;
        }

        long now = clock.currentTimeMillis();
        for (ObservedTask task : tasks.values()) {
            if (task.markStuckIfEligible(now, currentSettings.getGraceSeconds())) {
                totalStuckTasks.incrementAndGet();
                log.error("LiveRunner: Script task [{}] on script [{}] is stuck for [{}s], timeout [{}s], thread [{}], md5 [{}]",
                        task.getTaskId(), task.scriptKey, task.elapsedSeconds(now), task.timeoutSeconds,
                        task.threadName, task.scriptMd5);
            }
        }
    }

    @Override
    public ScriptWatchSnapshot snapshot() {
        long now = clock.currentTimeMillis();
        List<ScriptTaskSnapshot> stuck = new ArrayList<>();
        int activeStuck = 0;
        for (ObservedTask task : tasks.values()) {
            if (task.stuck) {
                activeStuck++;
                stuck.add(task.toSnapshot(now));
            }
        }
        stuck.sort(Comparator.comparingLong(ScriptTaskSnapshot::getTaskId).reversed());
        int max = settings.getMaxRecordedStuckTasks();
        if (stuck.size() > max) {
            stuck = new ArrayList<>(stuck.subList(0, max));
        }
        return new ScriptWatchSnapshot(activeStuck, totalTimedOutTasks.get(), totalStuckTasks.get(), stuck);
    }

    @Override
    public void updateSettings(ScriptExecutionWatchSettings newSettings) {
        ScriptExecutionWatchSettings copied = copy(newSettings);
        ScriptExecutionWatchSettings previous = this.settings;
        this.settings = copied;
        if (previous != null && previous.isEnabled() && !copied.isEnabled()) {
            tasks.clear();
        }
    }

    public int getCheckIntervalSeconds() {
        return settings.getCheckIntervalSeconds();
    }

    private static ScriptExecutionWatchSettings copy(ScriptExecutionWatchSettings source) {
        ScriptExecutionWatchSettings copy = new ScriptExecutionWatchSettings();
        if (source != null) {
            copy.setEnabled(source.isEnabled());
            copy.setGraceSeconds(source.getGraceSeconds());
            copy.setCheckIntervalSeconds(source.getCheckIntervalSeconds());
            copy.setMaxRecordedStuckTasks(source.getMaxRecordedStuckTasks());
        }
        return copy;
    }

    private final class ObservedTask implements ScriptExecutionHandle {
        private final long taskId;
        private final String scriptKey;
        private final String scriptMd5;
        private final int timeoutSeconds;
        private final long startTimeMillis;
        private volatile String threadName;
        private volatile boolean timedOut;
        private volatile boolean stuck;
        private volatile boolean running = true;

        private ObservedTask(long taskId, String scriptKey, String scriptMd5, String threadName,
                             int timeoutSeconds, long startTimeMillis) {
            this.taskId = taskId;
            this.scriptKey = scriptKey;
            this.scriptMd5 = scriptMd5;
            this.timeoutSeconds = timeoutSeconds;
            this.startTimeMillis = startTimeMillis;
        }

        @Override
        public void recordThreadName(String threadName) {
            this.threadName = threadName != null ? threadName : "";
        }

        @Override
        public long getTaskId() {
            return taskId;
        }

        @Override
        public boolean isRunning() {
            return running;
        }

        @Override
        public void markTimedOut() {
            if (running && !timedOut) {
                timedOut = true;
                totalTimedOutTasks.incrementAndGet();
            }
        }

        @Override
        public void complete() {
            running = false;
            tasks.remove(taskId);
        }

        private boolean markStuckIfEligible(long now, int graceSeconds) {
            if (!running || !timedOut || stuck) {
                return false;
            }
            if (elapsedSeconds(now) >= graceSeconds) {
                stuck = true;
                return true;
            }
            return false;
        }

        private ScriptTaskSnapshot toSnapshot(long now) {
            return new ScriptTaskSnapshot(taskId, scriptKey, scriptMd5, threadName, timeoutSeconds,
                    elapsedSeconds(now));
        }

        private long elapsedSeconds(long now) {
            return Math.max(0, (now - startTimeMillis) / 1000L);
        }
    }
}
