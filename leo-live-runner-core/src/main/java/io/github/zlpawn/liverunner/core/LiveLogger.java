package io.github.zlpawn.liverunner.core;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Serializable;

/**
 * Thread-safe, dual-write execution logger.
 * 1. Buffers logs in memory for HTTP response (with 512KB OOM protection).
 * 2. Simultaneously forwards logs to host application's SLF4J framework (app.log, console, ELK).
 *
 * @author Leo (zlpawn)
 */
public class LiveLogger implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final Logger slf4j = LoggerFactory.getLogger(LiveLogger.class);

    /**
     * Default log buffer size (64 KB) to prevent runaway loops from exhausting JVM heap.
     */
    public static final int DEFAULT_MAX_LOG_LENGTH = 64 * 1024;
    private static volatile int globalMaxLogLength = DEFAULT_MAX_LOG_LENGTH;

    private final int maxLogLength;
    private final StringBuilder buffer = new StringBuilder(1024);
    private boolean truncated = false;

    public LiveLogger() {
        this(globalMaxLogLength);
    }

    public LiveLogger(int maxLogLength) {
        this.maxLogLength = maxLogLength > 0 ? maxLogLength : DEFAULT_MAX_LOG_LENGTH;
    }

    public static void setGlobalMaxLogLength(int newGlobalMax) {
        if (newGlobalMax > 0) {
            globalMaxLogLength = newGlobalMax;
        }
    }

    public static int getGlobalMaxLogLength() {
        return globalMaxLogLength;
    }

    public int getMaxLogLength() {
        return maxLogLength;
    }

    public synchronized void println(String message) {
        // 1. Dual-write to host application's SLF4J log system (Logback/Log4j2/ELK)
        if (message != null) {
            slf4j.info("[LiveRunner] {}", message);
        }

        // 2. Buffer in memory for HTTP response
        if (truncated) {
            return;
        }

        String toAppend = message != null ? message : "null";
        int remaining = maxLogLength - buffer.length();

        if (remaining <= 0) {
            buffer.append("\n[WARN: Log buffer limit (").append(maxLogLength / 1024).append("KB) reached. Further logs truncated to prevent OOM.]\n");
            truncated = true;
            return;
        }

        if (toAppend.length() + 1 > remaining) {
            int subLen = Math.max(0, remaining - 1);
            if (subLen > 0) {
                buffer.append(toAppend, 0, Math.min(toAppend.length(), subLen));
            }
            buffer.append("\n[WARN: Log buffer limit (").append(maxLogLength / 1024).append("KB) reached. Further logs truncated to prevent OOM.]\n");
            truncated = true;
            return;
        }

        buffer.append(toAppend).append("\n");
    }

    public synchronized void print(String message) {
        if (truncated || message == null) {
            return;
        }

        int remaining = maxLogLength - buffer.length();
        if (remaining <= 0) {
            buffer.append("\n[WARN: Log buffer limit (").append(maxLogLength / 1024).append("KB) reached. Further logs truncated to prevent OOM.]\n");
            truncated = true;
            return;
        }

        if (message.length() > remaining) {
            buffer.append(message, 0, remaining);
            buffer.append("\n[WARN: Log buffer limit (").append(maxLogLength / 1024).append("KB) reached. Further logs truncated to prevent OOM.]\n");
            truncated = true;
            return;
        }

        buffer.append(message);
    }

    public synchronized String getLogs() {
        return buffer.toString();
    }

    public synchronized void clear() {
        buffer.setLength(0);
        truncated = false;
    }
}
