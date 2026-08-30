package io.github.zlpawn.liverunner.core.pool;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

class ResizableLinkedBlockingQueueTest {

    @Test
    void testBasicOfferPoll() {
        ResizableLinkedBlockingQueue<String> queue = new ResizableLinkedBlockingQueue<>(3);
        assertEquals(3, queue.getCapacity());
        assertEquals(0, queue.size());
        assertEquals(3, queue.remainingCapacity());

        assertTrue(queue.offer("A"));
        assertTrue(queue.offer("B"));
        assertTrue(queue.offer("C"));
        assertFalse(queue.offer("D")); // full

        assertEquals(3, queue.size());
        assertEquals(0, queue.remainingCapacity());
        assertEquals("A", queue.peek());

        assertEquals("A", queue.poll());
        assertEquals("B", queue.poll());
        assertEquals("C", queue.poll());
        assertNull(queue.poll());
        assertEquals(0, queue.size());
    }

    @Test
    void testDynamicCapacityExpansion() {
        ResizableLinkedBlockingQueue<Integer> queue = new ResizableLinkedBlockingQueue<>(2);
        assertTrue(queue.offer(1));
        assertTrue(queue.offer(2));
        assertFalse(queue.offer(3));

        // Dynamically expand capacity from 2 to 5
        queue.setCapacity(5);
        assertEquals(5, queue.getCapacity());
        assertEquals(3, queue.remainingCapacity());

        assertTrue(queue.offer(3));
        assertTrue(queue.offer(4));
        assertTrue(queue.offer(5));
        assertFalse(queue.offer(6));
        assertEquals(5, queue.size());
    }

    @Test
    void testDynamicCapacityShrink() {
        ResizableLinkedBlockingQueue<Integer> queue = new ResizableLinkedBlockingQueue<>(5);
        for (int i = 1; i <= 4; i++) {
            queue.offer(i);
        }
        assertEquals(4, queue.size());

        // Shrink capacity to 2 (already has 4 items)
        queue.setCapacity(2);
        assertEquals(2, queue.getCapacity());
        assertEquals(0, queue.remainingCapacity());
        assertFalse(queue.offer(5));

        // Consume until below new capacity
        assertEquals(1, queue.poll());
        assertEquals(2, queue.poll());
        assertEquals(3, queue.poll());
        assertEquals(1, queue.size());
        assertEquals(1, queue.remainingCapacity());

        // Now can offer 1 item
        assertTrue(queue.offer(5));
        assertFalse(queue.offer(6));
    }

    @Test
    void testBlockingPutUnblockedOnExpansion() throws InterruptedException {
        ResizableLinkedBlockingQueue<String> queue = new ResizableLinkedBlockingQueue<>(1);
        queue.offer("item1");

        CountDownLatch startLatch = new CountDownLatch(1);
        AtomicBoolean putSuccess = new AtomicBoolean(false);

        Thread putter = new Thread(() -> {
            try {
                startLatch.countDown();
                queue.put("item2"); // will block until capacity expanded
                putSuccess.set(true);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        putter.start();

        assertTrue(startLatch.await(2, TimeUnit.SECONDS));
        Thread.sleep(100);
        assertFalse(putSuccess.get()); // Still blocked

        // Expand capacity to 2
        queue.setCapacity(2);

        putter.join(2000);
        assertTrue(putSuccess.get());
        assertEquals(2, queue.size());
    }

    @Test
    void testDrainToAndIterator() {
        ResizableLinkedBlockingQueue<String> queue = new ResizableLinkedBlockingQueue<>(10);
        queue.offer("X");
        queue.offer("Y");
        queue.offer("Z");

        List<String> list = new ArrayList<>();
        int drained = queue.drainTo(list);
        assertEquals(3, drained);
        assertEquals(3, list.size());
        assertEquals(0, queue.size());
    }
}