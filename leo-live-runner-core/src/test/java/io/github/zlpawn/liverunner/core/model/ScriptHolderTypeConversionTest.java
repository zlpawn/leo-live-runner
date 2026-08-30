package io.github.zlpawn.liverunner.core.model;

import io.github.zlpawn.liverunner.core.LiveLogger;
import io.github.zlpawn.liverunner.core.LiveRunnerClassLoader;
import io.github.zlpawn.liverunner.core.engine.LiveRunnerEngine;
import io.github.zlpawn.liverunner.core.registry.ScriptRegistry;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.*;

public class ScriptHolderTypeConversionTest {

    public enum StatusEnum {
        PENDING,
        PROCESSING,
        COMPLETED
    }

    @Test
    public void testEnumAndDateTimeConversions() throws Exception {
        String script = ""
                + "package com.example.test;\n"
                + "import io.github.zlpawn.liverunner.core.model.ScriptHolderTypeConversionTest.StatusEnum;\n"
                + "import java.util.Date;\n"
                + "import java.time.LocalDate;\n"
                + "import java.time.LocalDateTime;\n"
                + "import java.time.LocalTime;\n"
                + "public class DateTask {\n"
                + "    public String testEnum(StatusEnum status) {\n"
                + "        return \"STATUS:\" + status.name();\n"
                + "    }\n"
                + "    public String testDate(Date date) {\n"
                + "        return \"DATE:\" + (date != null ? date.getTime() > 0 : false);\n"
                + "    }\n"
                + "    public String testLocalDate(LocalDate date) {\n"
                + "        return \"LOCAL_DATE:\" + date.getYear() + \"-\" + date.getMonthValue() + \"-\" + date.getDayOfMonth();\n"
                + "    }\n"
                + "    public String testLocalDateTime(LocalDateTime dateTime) {\n"
                + "        return \"LOCAL_DATE_TIME:\" + dateTime.getYear() + \"_\" + dateTime.getHour();\n"
                + "    }\n"
                + "    public String testLocalTime(LocalTime time) {\n"
                + "        return \"LOCAL_TIME:\" + time.getHour() + \":\" + time.getMinute();\n"
                + "    }\n"
                + "}\n";

        LiveRunnerClassLoader loader = new LiveRunnerClassLoader();
        Class<?> clazz = loader.parseClass(script);
        Object instance = clazz.getDeclaredConstructor().newInstance();

        ScriptHolder holder = new ScriptHolder("date-task", 1, "md5", "Remark", loader, clazz, instance);
        LiveLogger logger = new LiveLogger();

        // 1. Enum conversion
        Map<String, Object> params1 = new HashMap<>();
        params1.put("status", "processing"); // lowercase matching
        Object res1 = holder.invoke("testEnum", params1, logger);
        Assertions.assertEquals("STATUS:PROCESSING", res1);

        // 2. Date conversion (from yyyy-MM-dd HH:mm:ss)
        Map<String, Object> params2 = new HashMap<>();
        params2.put("date", "2026-08-30 20:00:00");
        Object res2 = holder.invoke("testDate", params2, logger);
        Assertions.assertEquals("DATE:true", res2);

        // 3. LocalDate conversion
        Map<String, Object> params3 = new HashMap<>();
        params3.put("date", "2026-08-30");
        Object res3 = holder.invoke("testLocalDate", params3, logger);
        Assertions.assertEquals("LOCAL_DATE:2026-8-30", res3);

        // 4. LocalDateTime conversion
        Map<String, Object> params4 = new HashMap<>();
        params4.put("dateTime", "2026-08-30 15:30:00");
        Object res4 = holder.invoke("testLocalDateTime", params4, logger);
        Assertions.assertEquals("LOCAL_DATE_TIME:2026_15", res4);

        // 5. LocalTime conversion
        Map<String, Object> params5 = new HashMap<>();
        params5.put("time", "15:30:00");
        Object res5 = holder.invoke("testLocalTime", params5, logger);
        Assertions.assertEquals("LOCAL_TIME:15:30", res5);

        holder.destroy();
    }

    @Test
    public void testCollectionAndMapConversions() throws Exception {
        String script = ""
                + "package com.example.test;\n"
                + "import java.util.List;\n"
                + "import java.util.Set;\n"
                + "import java.util.Map;\n"
                + "public class CollectionTask {\n"
                + "    public int testList(List<String> list) {\n"
                + "        return list.size();\n"
                + "    }\n"
                + "    public int testSet(Set<String> set) {\n"
                + "        return set.size();\n"
                + "    }\n"
                + "    public String testMap(Map<String, Object> map) {\n"
                + "        return String.valueOf(map.get(\"key\"));\n"
                + "    }\n"
                + "}\n";

        LiveRunnerClassLoader loader = new LiveRunnerClassLoader();
        Class<?> clazz = loader.parseClass(script);
        Object instance = clazz.getDeclaredConstructor().newInstance();

        ScriptHolder holder = new ScriptHolder("col-task", 1, "md5", "Remark", loader, clazz, instance);
        LiveLogger logger = new LiveLogger();

        // 1. List from comma-separated string
        Map<String, Object> params1 = new HashMap<>();
        params1.put("list", "apple,banana,orange");
        Object res1 = holder.invoke("testList", params1, logger);
        Assertions.assertEquals(3, res1);

        // 2. Set from comma-separated string with duplicates
        Map<String, Object> params2 = new HashMap<>();
        params2.put("set", "a,b,a,c");
        Object res2 = holder.invoke("testSet", params2, logger);
        Assertions.assertEquals(3, res2);

        // 3. Map parameter
        Map<String, Object> innerMap = new HashMap<>();
        innerMap.put("key", "val123");
        Map<String, Object> params3 = new HashMap<>();
        params3.put("map", innerMap);
        Object res3 = holder.invoke("testMap", params3, logger);
        Assertions.assertEquals("val123", res3);

        holder.destroy();
    }

    @Test
    public void testLiveLoggerOverflowSafety() {
        LiveLogger logger = new LiveLogger(); // 64KB default

        // Attempt writing a single 1MB message
        char[] largeChars = new char[1024 * 1024];
        Arrays.fill(largeChars, 'A');
        String largeMsg = new String(largeChars);

        logger.println(largeMsg);

        String logs = logger.getLogs();
        Assertions.assertTrue(logs.length() <= 64 * 1024 + 200, "Log buffer must not exceed default 64KB limit");
        Assertions.assertTrue(logs.contains("[WARN: Log buffer limit (64KB) reached."));

        // Test custom buffer size (e.g. 128KB)
        LiveLogger customLogger = new LiveLogger(128 * 1024);
        customLogger.println(largeMsg);
        Assertions.assertTrue(customLogger.getLogs().length() <= 128 * 1024 + 200);
        Assertions.assertTrue(customLogger.getLogs().contains("[WARN: Log buffer limit (128KB) reached."));
    }

    @Test
    public void testExecuteOneShotTimeoutInterruption() {
        LiveRunnerEngine engine = new LiveRunnerEngine(new ScriptRegistry());

        String infiniteLoopScript = ""
                + "package com.example.test;\n"
                + "public class InfiniteTask {\n"
                + "    public String run() {\n"
                + "        try {\n"
                + "            while (!Thread.currentThread().isInterrupted()) {\n"
                + "                Thread.sleep(100);\n"
                + "            }\n"
                + "        } catch (InterruptedException e) {\n"
                + "            // Interrupted as expected\n"
                + "        }\n"
                + "        return \"LOOP\";\n"
                + "    }\n"
                + "}\n";

        ScriptExecuteResult result = engine.executeOneShot(infiniteLoopScript, null, null, 1, null);
        Assertions.assertFalse(result.isSuccess());
        Assertions.assertTrue(result.getError().contains("Execution Timeout"));

        engine.shutdown();
    }
}
