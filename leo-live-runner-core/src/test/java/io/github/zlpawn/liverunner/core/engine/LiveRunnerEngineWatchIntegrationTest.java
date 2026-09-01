package io.github.zlpawn.liverunner.core.engine;

import io.github.zlpawn.liverunner.core.model.ScriptExecuteResult;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatch;
import io.github.zlpawn.liverunner.core.watch.ScriptWatchSnapshot;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

class LiveRunnerEngineWatchIntegrationTest {
    private final ExecutorService executorService = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "watch-test-worker");
        thread.setDaemon(true);
        return thread;
    });

    private final LiveRunnerEngine engine = new LiveRunnerEngine(
            new ScriptRegistry(), executorService, null);

    @AfterEach
    void tearDown() {
        engine.shutdown();
    }

    @Test
    void shouldCompleteWatchWhenOneShotTaskFinishes() {
        RecordingWatch watch = new RecordingWatch();
        engine.setExecutionWatch(watch);

        ScriptExecuteResult result = engine.executeOneShot(successScript(), "run", null, 5, null);
        Assertions.assertTrue(result.isSuccess(), result.getError());
        Assertions.assertEquals(1, watch.startCount);
        Assertions.assertEquals(1, watch.completeCount);
        Assertions.assertEquals(0, watch.timeoutCount);
    }

    @Test
    void shouldKeepTimedOutTaskUnderWatchUntilWorkerFinishes() throws Exception {
        RecordingWatch watch = new RecordingWatch();
        engine.setExecutionWatch(watch);

        ScriptExecuteResult result = engine.executeOneShot(blockingScript(), "run", null, 1, null);
        Assertions.assertFalse(result.isSuccess());
        Assertions.assertEquals(1, watch.startCount);
        Assertions.assertEquals(1, watch.timeoutCount);
        Assertions.assertTrue(awaitCompletion(() -> watch.completeCount == 1),
                "interruptible task should complete after future.cancel(true)");
    }

    @Test
    void shouldObserveRegisteredScriptTimeoutUntilWorkerFinishes() throws Exception {
        RecordingWatch watch = new RecordingWatch();
        engine.setExecutionWatch(watch);
        engine.register("blocking", blockingScript(), null, null);

        ScriptExecuteResult result = engine.invoke("blocking", "run", null, 1);
        Assertions.assertFalse(result.isSuccess());
        Assertions.assertEquals(1, watch.startCount);
        Assertions.assertEquals(1, watch.timeoutCount);

        Assertions.assertTrue(awaitCompletion(() -> watch.completeCount == 1));
    }

    @Test
    void shouldCompleteWatchWhenExecutorRejectsTask() {
        executorService.shutdownNow();
        RecordingWatch watch = new RecordingWatch();
        engine.setExecutionWatch(watch);

        ScriptExecuteResult result = engine.executeOneShot(successScript(), "run", null, 1, null);
        Assertions.assertFalse(result.isSuccess());
        Assertions.assertEquals(1, watch.startCount);
        Assertions.assertEquals(1, watch.completeCount);
        Assertions.assertEquals(0, watch.timeoutCount);
    }

    private static String successScript() {
        return "package com.example.watch;" +
                "public class SuccessTask { public String run() { return \"OK\"; } }";
    }

    private static String blockingScript() {
        return "package com.example.watch;" +
                "public class BlockingTask { public String run() throws Exception { Thread.sleep(30000L); return \"OK\"; } }";
    }

    private static boolean awaitCompletion(BooleanSupplier supplier) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            if (supplier.getAsBoolean()) {
                return true;
            }
            Thread.sleep(20);
        }
        return false;
    }

    private interface BooleanSupplier {
        boolean getAsBoolean();
    }

    private static final class RecordingWatch implements ScriptExecutionWatch {
        private int startCount;
        private int completeCount;
        private int timeoutCount;

        @Override
        public io.github.zlpawn.liverunner.core.watch.ScriptExecutionHandle start(
                String scriptKey, String scriptMd5, int timeoutSeconds) {
            startCount++;
            return new io.github.zlpawn.liverunner.core.watch.ScriptExecutionHandle() {
                @Override
                public long getTaskId() {
                    return 1;
                }

                @Override
                public boolean isRunning() {
                    return false;
                }

                @Override
                public void markTimedOut() {
                    timeoutCount++;
                }

                @Override
                public void recordThreadName(String threadName) {
                }

                @Override
                public void complete() {
                    completeCount++;
                }
            };
        }

        @Override
        public void check() {
        }

        @Override
        public ScriptWatchSnapshot snapshot() {
            return new ScriptWatchSnapshot(0, 0, 0, java.util.Collections.emptyList());
        }

        @Override
        public void updateSettings(io.github.zlpawn.liverunner.core.watch.ScriptExecutionWatchSettings settings) {
        }

    }
}
