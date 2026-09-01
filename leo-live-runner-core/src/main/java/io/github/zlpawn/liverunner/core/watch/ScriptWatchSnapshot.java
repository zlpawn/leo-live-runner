package io.github.zlpawn.liverunner.core.watch;

import java.util.Collections;
import java.util.List;

public class ScriptWatchSnapshot {
    private final int activeStuckTaskCount;
    private final long totalTimedOutTaskCount;
    private final long totalStuckTaskCount;
    private final List<ScriptTaskSnapshot> stuckTasks;

    public ScriptWatchSnapshot(int activeStuckTaskCount, long totalTimedOutTaskCount,
                               long totalStuckTaskCount, List<ScriptTaskSnapshot> stuckTasks) {
        this.activeStuckTaskCount = activeStuckTaskCount;
        this.totalTimedOutTaskCount = totalTimedOutTaskCount;
        this.totalStuckTaskCount = totalStuckTaskCount;
        this.stuckTasks = Collections.unmodifiableList(stuckTasks);
    }

    public int getActiveStuckTaskCount() {
        return activeStuckTaskCount;
    }

    public long getTotalTimedOutTaskCount() {
        return totalTimedOutTaskCount;
    }

    public long getTotalStuckTaskCount() {
        return totalStuckTaskCount;
    }

    public List<ScriptTaskSnapshot> getStuckTasks() {
        return stuckTasks;
    }
}
