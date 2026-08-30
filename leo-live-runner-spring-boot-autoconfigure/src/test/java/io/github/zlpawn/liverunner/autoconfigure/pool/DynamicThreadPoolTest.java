package io.github.zlpawn.liverunner.autoconfigure.pool;

import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.autoconfigure.properties.RejectionPolicyType;
import io.github.zlpawn.liverunner.core.pool.ResizableLinkedBlockingQueue;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class DynamicThreadPoolTest {

    private ThreadPoolExecutor executor;
    private LiveRunnerThreadPoolRefresher refresher;

    @BeforeEach
    void setUp() {
        executor = new ThreadPoolExecutor(
                2,
                4,
                30L, TimeUnit.SECONDS,
                new ResizableLinkedBlockingQueue<>(100),
                r -> new Thread(r, "Test-Pool-Worker"),
                new ThreadPoolExecutor.CallerRunsPolicy()
        );
        refresher = new LiveRunnerThreadPoolRefresher(executor);
    }

    @AfterEach
    void tearDown() {
        if (executor != null && !executor.isShutdown()) {
            executor.shutdownNow();
        }
    }

    @Test
    void testDynamicCoreAndMaxPoolExpansion() {
        assertEquals(2, executor.getCorePoolSize());
        assertEquals(4, executor.getMaximumPoolSize());

        // Expand pool to core=6, max=12
        refresher.refresh(6, 12, 100, 45, RejectionPolicyType.ABORT);

        assertEquals(6, executor.getCorePoolSize());
        assertEquals(12, executor.getMaximumPoolSize());
        assertEquals(45, executor.getKeepAliveTime(TimeUnit.SECONDS));
        assertTrue(executor.getRejectedExecutionHandler() instanceof ThreadPoolExecutor.AbortPolicy);
    }

    @Test
    void testDynamicCoreAndMaxPoolShrink() {
        // First expand
        refresher.refresh(8, 16, 100, 30, RejectionPolicyType.CALLER_RUNS);
        assertEquals(8, executor.getCorePoolSize());
        assertEquals(16, executor.getMaximumPoolSize());

        // Shrink to core=2, max=4
        refresher.refresh(2, 4, 50, 20, RejectionPolicyType.DISCARD);
        assertEquals(2, executor.getCorePoolSize());
        assertEquals(4, executor.getMaximumPoolSize());
        assertEquals(20, executor.getKeepAliveTime(TimeUnit.SECONDS));
        assertTrue(executor.getRejectedExecutionHandler() instanceof ThreadPoolExecutor.DiscardPolicy);

        ResizableLinkedBlockingQueue<?> queue = (ResizableLinkedBlockingQueue<?>) executor.getQueue();
        assertEquals(50, queue.getCapacity());
    }

    @Test
    void testRefreshFromLiveRunnerProperties() {
        LiveRunnerProperties properties = new LiveRunnerProperties();
        properties.setCorePoolSize(5);
        properties.setMaxPoolSize(15);
        properties.setQueueCapacity(300);
        properties.setKeepAliveSeconds(90);
        properties.setRejectionPolicy(RejectionPolicyType.DISCARD_OLDEST);

        refresher.refresh(properties);

        assertEquals(5, executor.getCorePoolSize());
        assertEquals(15, executor.getMaximumPoolSize());
        assertEquals(90, executor.getKeepAliveTime(TimeUnit.SECONDS));
        assertTrue(executor.getRejectedExecutionHandler() instanceof ThreadPoolExecutor.DiscardOldestPolicy);

        ResizableLinkedBlockingQueue<?> queue = (ResizableLinkedBlockingQueue<?>) executor.getQueue();
        assertEquals(300, queue.getCapacity());
    }
}