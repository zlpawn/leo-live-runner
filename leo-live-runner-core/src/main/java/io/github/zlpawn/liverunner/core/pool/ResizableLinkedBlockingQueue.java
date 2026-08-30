package io.github.zlpawn.liverunner.core.pool;
import java.util.AbstractQueue;
import java.util.Collection;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

public class ResizableLinkedBlockingQueue<E> extends AbstractQueue<E> implements BlockingQueue<E>, java.io.Serializable {
    private static final long serialVersionUID = 1L;

    static class Node<E> {
        E item;
        Node<E> next;
        Node(E x) { item = x; }
    }

    private volatile int capacity;
    private final AtomicInteger count = new AtomicInteger();
    private transient Node<E> head;
    private transient Node<E> last;

    private final ReentrantLock takeLock = new ReentrantLock();
    private final Condition notEmpty = takeLock.newCondition();
    private final ReentrantLock putLock = new ReentrantLock();
    private final Condition notFull = putLock.newCondition();


    public ResizableLinkedBlockingQueue() {
        this(Integer.MAX_VALUE);
    }

    public ResizableLinkedBlockingQueue(int capacity) {
        if (capacity <= 0) throw new IllegalArgumentException("capacity must be positive");
        this.capacity = capacity;
        last = head = new Node<E>(null);
    }

    private void signalNotEmpty() {
        final ReentrantLock takeLock = this.takeLock;
        takeLock.lock();
        try {
            notEmpty.signal();
        } finally {
            takeLock.unlock();
        }
    }

    private void signalNotFull() {
        final ReentrantLock putLock = this.putLock;
        putLock.lock();
        try {
            notFull.signal();
        } finally {
            putLock.unlock();
        }
    }

    private void signalNotFullAll() {
        final ReentrantLock putLock = this.putLock;
        putLock.lock();
        try {
            notFull.signalAll();
        } finally {
            putLock.unlock();
        }
    }

    private void enqueue(Node<E> node) {
        last = last.next = node;
    }

    private E dequeue() {
        Node<E> h = head;
        Node<E> first = h.next;
        h.next = h;
        head = first;
        E x = first.item;
        first.item = null;
        return x;
    }

    void fullyLock() {
        putLock.lock();
        takeLock.lock();
    }

    void fullyUnlock() {
        takeLock.unlock();
        putLock.unlock();
    }

    public void setCapacity(int newCapacity) {
        if (newCapacity <= 0) throw new IllegalArgumentException("capacity must be positive");
        int oldCapacity = this.capacity;
        this.capacity = newCapacity;
        if (newCapacity > oldCapacity) {
            signalNotFullAll();
        }
    }

    public int getCapacity() {
        return this.capacity;
    }

    @Override
    public int size() {
        return count.get();
    }

    @Override
    public int remainingCapacity() {
        int rem = capacity - count.get();
        return Math.max(0, rem);
    }

    @Override
    public void put(E e) throws InterruptedException {
        if (e == null) throw new NullPointerException();
        int c = -1;
        Node<E> node = new Node<E>(e);
        final ReentrantLock putLock = this.putLock;
        putLock.lockInterruptibly();
        try {
            while (this.count.get() >= capacity) {
                notFull.await();
            }
            enqueue(node);
            c = this.count.getAndIncrement();
            if (c + 1 < capacity) {
                notFull.signal();
            }
        } finally {
            putLock.unlock();
        }
        if (c == 0) {
            signalNotEmpty();
        }
    }

    @Override
    public boolean offer(E e, long timeout, TimeUnit unit) throws InterruptedException {
        if (e == null) throw new NullPointerException();
        long nanos = unit.toNanos(timeout);
        int c = -1;
        final ReentrantLock putLock = this.putLock;
        putLock.lockInterruptibly();
        try {
            while (this.count.get() >= capacity) {
                if (nanos <= 0) return false;
                nanos = notFull.awaitNanos(nanos);
            }
            enqueue(new Node<E>(e));
            c = this.count.getAndIncrement();
            if (c + 1 < capacity) {
                notFull.signal();
            }
        } finally {
            putLock.unlock();
        }
        if (c == 0) {
            signalNotEmpty();
        }
        return true;
    }

    @Override
    public boolean offer(E e) {
        if (e == null) throw new NullPointerException();
        if (this.count.get() >= capacity) return false;
        int c = -1;
        Node<E> node = new Node<E>(e);
        final ReentrantLock putLock = this.putLock;
        putLock.lock();
        try {
            if (this.count.get() < capacity) {
                enqueue(node);
                c = this.count.getAndIncrement();
                if (c + 1 < capacity) {
                    notFull.signal();
                }
            }
        } finally {
            putLock.unlock();
        }
        if (c == 0) {
            signalNotEmpty();
        }
        return c >= 0;
    }

    @Override
    public E take() throws InterruptedException {
        E e;
        int c = -1;
        final ReentrantLock takeLock = this.takeLock;
        takeLock.lockInterruptibly();
        try {
            while (this.count.get() == 0) {
                notEmpty.await();
            }
            e = dequeue();
            c = this.count.getAndDecrement();
            if (c > 1) {
                notEmpty.signal();
            }
        } finally {
            takeLock.unlock();
        }
        if (c == capacity) {
            signalNotFull();
        }
        return e;
    }

    @Override
    public E poll(long timeout, TimeUnit unit) throws InterruptedException {
        E e = null;
        int c = -1;
        long nanos = unit.toNanos(timeout);
        final ReentrantLock takeLock = this.takeLock;
        takeLock.lockInterruptibly();
        try {
            while (this.count.get() == 0) {
                if (nanos <= 0) return null;
                nanos = notEmpty.awaitNanos(nanos);
            }
            e = dequeue();
            c = this.count.getAndDecrement();
            if (c > 1) {
                notEmpty.signal();
            }
        } finally {
            takeLock.unlock();
        }
        if (c == capacity) {
            signalNotFull();
        }
        return e;
    }

    @Override
    public E poll() {
        if (this.count.get() == 0) return null;
        E e = null;
        int c = -1;
        final ReentrantLock takeLock = this.takeLock;
        takeLock.lock();
        try {
            if (this.count.get() > 0) {
                e = dequeue();
                c = this.count.getAndDecrement();
                if (c > 1) {
                    notEmpty.signal();
                }
            }
        } finally {
            takeLock.unlock();
        }
        if (c == capacity) {
            signalNotFull();
        }
        return e;
    }

    @Override
    public E peek() {
        if (this.count.get() == 0) return null;
        final ReentrantLock takeLock = this.takeLock;
        takeLock.lock();
        try {
            Node<E> first = head.next;
            return first == null ? null : first.item;
        } finally {
            takeLock.unlock();
        }
    }

    @Override
    public int drainTo(Collection<? super E> c) {
        return drainTo(c, Integer.MAX_VALUE);
    }

    @Override
    public int drainTo(Collection<? super E> c, int maxElements) {
        if (c == null) throw new NullPointerException();
        if (c == this) throw new IllegalArgumentException();
        if (maxElements <= 0) return 0;
        boolean signalNotFull = false;
        final ReentrantLock takeLock = this.takeLock;
        takeLock.lock();
        try {
            int n = Math.min(maxElements, this.count.get());
            Node<E> h = head;
            int i = 0;
            try {
                while (i < n) {
                    Node<E> p = h.next;
                    c.add(p.item);
                    p.item = null;
                    h.next = h;
                    h = p;
                    i++;
                }
                return n;
            } finally {
                if (i > 0) {
                    head = h;
                    signalNotFull = (this.count.getAndAdd(-i) == capacity);
                }
            }
        } finally {
            takeLock.unlock();
            if (signalNotFull) signalNotFull();
        }
    }

    @Override
    public Iterator<E> iterator() {
        return new Itr();
    }

    private class Itr implements Iterator<E>{
        private Node<E> current;
        private E currentElement;

        Itr() {
            fullyLock();
            try {
                current = head.next;
                if (current != null) {
                    currentElement = current.item;
                }
            } finally {
                fullyUnlock();
            }
        }

        @Override
        public boolean hasNext() {
            return current != null;
        }

        @Override
        public E next() {
            fullyLock();
            try {
                if (current == null) throw new NoSuchElementException();
                E x = currentElement;
                current = current.next;
                currentElement = (current == null) ? null : current.item;
                return x;
            } finally {
                fullyUnlock();
            }
        }
    }
}
