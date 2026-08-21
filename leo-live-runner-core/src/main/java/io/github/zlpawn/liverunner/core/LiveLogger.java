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
     * Max log buffer size (512 KB) to prevent runaway loops from exhausting JVM heap.
     */
    private static final int MAX_LOG_LENGTH = 512 * 1024;

    private final StringBuilder buffer = new StringBuilder(1024);
    private boolean truncated = false;

    public synchronized void println(String message) {
        // 1. Dual-write to host application's SLF4J log system (Logback/Log4j2/ELK)
        if (message != null) {
            slf4j.info("[LiveRunner] {}", message);
        }

        // 2. Buffer in memory for HTTP response
        if (truncated) {
            return;
        }

        if (buffer.length() > MAX_LOG_LENGTH) {
            buffer.append("\n[WARN: Log buffer limit (512KB) reached. Further logs truncated to prevent OOM.]\n");
            truncated = true;
            return;
        }

        buffer.append(message).append("\n");
    }

    public synchronized void print(String message) {
        if (truncated) {
            return;
        }

        if (buffer.length() > MAX_LOG_LENGTH) {
            buffer.append("\n[WARN: Log buffer limit (512KB) reached. Further logs truncated to prevent OOM.]\n");
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
