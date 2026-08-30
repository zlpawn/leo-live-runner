package io.github.zlpawn.liverunner.autoconfigure.properties;

import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * Thread pool rejection policies for Live Runner worker execution.
 *
 * @author Leo (zlpawn)
 */
public enum RejectionPolicyType {

    /**
     * Executes the task in the caller (HTTP dispatch) thread if the pool and queue are saturated.
     * Prevents task drops at the cost of caller thread latency. Default policy.
     */
    CALLER_RUNS,

    /**
     * Throws {@link java.util.concurrent.RejectedExecutionException} immediately when saturated.
     */
    ABORT,

    /**
     * Silently discards the rejected task.
     */
    DISCARD,

    /**
     * Discards the oldest unhandled request in the queue, then retries execution.
     */
    DISCARD_OLDEST;

    /**
     * Convert this enum to standard JDK {@link RejectedExecutionHandler}.
     */
    public RejectedExecutionHandler toHandler() {
        switch (this) {
            case ABORT:
                return new ThreadPoolExecutor.AbortPolicy();
            case DISCARD:
                return new ThreadPoolExecutor.DiscardPolicy();
            case DISCARD_OLDEST:
                return new ThreadPoolExecutor.DiscardOldestPolicy();
            case CALLER_RUNS:
            default:
                return new ThreadPoolExecutor.CallerRunsPolicy();
        }
    }
}
