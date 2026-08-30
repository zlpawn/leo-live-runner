package io.github.zlpawn.liverunner.autoconfigure.pool;

import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.autoconfigure.properties.RejectionPolicyType;
import io.github.zlpawn.liverunner.core.pool.ResizableLinkedBlockingQueue;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Dynamic ThreadPool Refresher for Live Runner worker pool.
 * Handles safe, non-disruptive runtime resizing of thread pool parameters
 * (corePoolSize, maxPoolSize, keepAliveTime, queueCapacity, and rejectionPolicy).
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerThreadPoolRefresher {
    private static final Logger log = LoggerFactory.getLogger(LiveRunnerThreadPoolRefresher.class);

    private final ThreadPoolExecutor executor;

    public LiveRunnerThreadPoolRefresher(ThreadPoolExecutor executor) {
        this.executor = executor;
    }

    /**
     * Refresh thread pool with the latest LiveRunnerProperties.
     */
    public synchronized void refresh(LiveRunnerProperties properties) {
        if (properties == null || executor == null || executor.isShutdown()) {
            return;
        }

        refresh(
                properties.getCorePoolSize(),
                properties.getMaxPoolSize(),
                properties.getQueueCapacity(),
                properties.getKeepAliveSeconds(),
                properties.getRejectionPolicy()
        );
    }

    /**
     * Atomically and safely refresh all dynamic parameters.
     */
    public synchronized void refresh(int newCore, int newMax, int newQueueCapacity, int newKeepAliveSeconds, RejectionPolicyType newRejectionPolicy) {
        if (executor == null || executor.isShutdown()) {
            return;
        }

        int oldCore = executor.getCorePoolSize();
        int oldMax = executor.getMaximumPoolSize();

        // 1. Safe resizing order to prevent IllegalArgumentException
        if (newCore > oldMax) {
            executor.setMaximumPoolSize(newMax);
            executor.setCorePoolSize(newCore);
        } else {
            executor.setCorePoolSize(newCore);
            executor.setMaximumPoolSize(newMax);
        }

        // 2. Refresh keepAliveTime
        if (newKeepAliveSeconds > 0) {
            executor.setKeepAliveTime(newKeepAliveSeconds, TimeUnit.SECONDS);
        }

        // 3. Refresh Queue Capacity if ResizableLinkedBlockingQueue
        BlockingQueue<Runnable> queue = executor.getQueue();
        if (queue instanceof ResizableLinkedBlockingQueue && newQueueCapacity > 0) {
            ResizableLinkedBlockingQueue<Runnable> resizableQueue = (ResizableLinkedBlockingQueue<Runnable>) queue;
            int oldCapacity = resizableQueue.getCapacity();
            if (oldCapacity != newQueueCapacity) {
                resizableQueue.setCapacity(newQueueCapacity);
                log.info("LiveRunner: Dynamic thread pool queue capacity resized from [{}] to [{}]", oldCapacity, newQueueCapacity);
            }
        }

        // 4. Refresh Rejection Policy
        if (newRejectionPolicy != null) {
            executor.setRejectedExecutionHandler(newRejectionPolicy.toHandler());
        }

        log.info("LiveRunner: Dynamic thread pool refreshed. [core: {} -> {}, max: {} -> {}, keepAlive: {}s, rejection: {}]",
                oldCore, newCore, oldMax, newMax, newKeepAliveSeconds, newRejectionPolicy);
    }

    public ThreadPoolExecutor getExecutor() {
        return executor;
    }
}