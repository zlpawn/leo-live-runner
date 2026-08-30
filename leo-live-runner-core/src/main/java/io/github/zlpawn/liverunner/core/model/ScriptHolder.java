package io.github.zlpawn.liverunner.core.model;

import io.github.zlpawn.liverunner.core.LiveLogger;
import io.github.zlpawn.liverunner.core.LiveRunnerClassLoader;

import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.text.SimpleDateFormat;
import java.time.*;
import java.time.temporal.TemporalAccessor;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * In-memory runtime wrapper for a compiled live script.
 * Supports multi-method dispatch, automatic single-method resolution,
 * and intelligent argument mapping from JSON Map to target Java method parameters.
 *
 * @author Leo (zlpawn)
 */
public class ScriptHolder {

    private static final Set<String> IGNORED_METHODS = new HashSet<>(Arrays.asList(
            "equals", "hashCode", "toString", "getClass", "notify", "notifyAll", "wait",
            "getMetaClass", "setMetaClass", "invokeMethod", "getProperty", "setProperty"
    ));

    private final String scriptKey;
    private final int version;
    private final String md5;
    private final String remark;
    private final Date registerTime;

    private LiveRunnerClassLoader classLoader;
    private Class<?> scriptClass;
    private Object scriptInstance;

    // Available business methods mapped by lower-case method name
    private final Map<String, Method> methodMap = new ConcurrentHashMap<>();
    private Method defaultMethod;

    private final AtomicLong invokeCount = new AtomicLong(0);
    private volatile long lastInvokeTime = 0;

    public ScriptHolder(String scriptKey, int version, String md5, String remark,
                        LiveRunnerClassLoader classLoader, Class<?> scriptClass,
                        Object scriptInstance) {
        this.scriptKey = scriptKey;
        this.version = version;
        this.md5 = md5;
        this.remark = remark;
        this.registerTime = new Date();
        this.classLoader = classLoader;
        this.scriptClass = scriptClass;
        this.scriptInstance = scriptInstance;

        initMethods(scriptClass);
    }

    private void initMethods(Class<?> clazz) {
        Method preferredDefault = null;
        for (Method m : clazz.getMethods()) {
            if (!Modifier.isPublic(m.getModifiers()) || m.isSynthetic()) {
                continue;
            }
            if (IGNORED_METHODS.contains(m.getName())) {
                continue;
            }
            m.setAccessible(true);
            methodMap.put(m.getName().toLowerCase(), m);

            if ("run".equalsIgnoreCase(m.getName())) {
                preferredDefault = m;
            } else if ("execute".equalsIgnoreCase(m.getName()) && preferredDefault == null) {
                preferredDefault = m;
            }
        }

        if (preferredDefault != null) {
            this.defaultMethod = preferredDefault;
        } else if (methodMap.size() == 1) {
            // Exactly one custom public method -> use it as default
            this.defaultMethod = methodMap.values().iterator().next();
        } else if (!methodMap.isEmpty()) {
            // Fallback to first available public method
            this.defaultMethod = methodMap.values().iterator().next();
        }
    }

    /**
     * Invoke method on this dynamic class.
     *
     * @param targetMethodName Optional specific method name to invoke. If null/empty, uses default method.
     * @param params           Input JSON parameters
     * @param logger           Live execution logger
     * @return Execution result
     */
    public Object invoke(String targetMethodName, Map<String, Object> params, LiveLogger logger) throws Exception {
        this.lastInvokeTime = System.currentTimeMillis();
        this.invokeCount.incrementAndGet();

        Method targetMethod = resolveMethod(targetMethodName);

        Parameter[] parameters = targetMethod.getParameters();
        if (parameters.length == 0) {
            return targetMethod.invoke(scriptInstance);
        }

        Object[] args = new Object[parameters.length];
        int nonLoggerIndex = 0;
        List<Object> paramValuesList = params != null ? new ArrayList<>(params.values()) : Collections.emptyList();

        for (int i = 0; i < parameters.length; i++) {
            Parameter p = parameters[i];
            Class<?> type = p.getType();

            // 1. LiveLogger injection
            if (LiveLogger.class.isAssignableFrom(type)) {
                args[i] = logger;
                continue;
            }

            // 2. Name-based parameter extraction from JSON Map
            String paramName = p.getName();
            Object rawValue = findParamValue(params, paramName);

            // 3. Full Map injection if name matching didn't hit a specific inner map
            if (rawValue == null && Map.class.isAssignableFrom(type)) {
                args[i] = params;
                continue;
            }

            // 4. Positional fallback if name matching didn't hit (e.g. arg0, arg1)
            if (rawValue == null && nonLoggerIndex < paramValuesList.size()) {
                if (paramName.startsWith("arg") || (params != null && !params.containsKey(paramName))) {
                    rawValue = paramValuesList.get(nonLoggerIndex);
                }
            }
            nonLoggerIndex++;

            // 5. Smart Type Conversion
            args[i] = convertType(rawValue, type);
        }

        return targetMethod.invoke(scriptInstance, args);
    }

    public Method resolveMethod(String methodName) throws NoSuchMethodException {
        if (methodName == null || methodName.trim().isEmpty()) {
            if (defaultMethod != null) {
                return defaultMethod;
            }
            throw new NoSuchMethodException("No default method found on script [" + scriptKey +
                    "]. Please specify a method name from: " + methodMap.keySet());
        }

        Method m = methodMap.get(methodName.trim().toLowerCase());
        if (m != null) {
            return m;
        }

        throw new NoSuchMethodException("Method [" + methodName + "] not found on script [" + scriptKey +
                "]. Available public methods: " + methodMap.keySet());
    }

    private Object findParamValue(Map<String, Object> params, String paramName) {
        if (params == null || params.isEmpty()) {
            return null;
        }
        if (params.containsKey(paramName)) {
            return params.get(paramName);
        }
        for (Map.Entry<String, Object> entry : params.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(paramName)) {
                return entry.getValue();
            }
        }
        return null;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private Object convertType(Object value, Class<?> targetType) {
        if (value == null) {
            if (targetType.isPrimitive()) {
                if (targetType == boolean.class) return false;
                if (targetType == byte.class) return (byte) 0;
                if (targetType == short.class) return (short) 0;
                if (targetType == int.class) return 0;
                if (targetType == long.class) return 0L;
                if (targetType == float.class) return 0.0f;
                if (targetType == double.class) return 0.0d;
                if (targetType == char.class) return '\0';
            }
            return null;
        }

        if (targetType.isAssignableFrom(value.getClass())) {
            return value;
        }

        String strVal = value.toString().trim();

        // 1. String
        if (targetType == String.class) {
            return strVal;
        }

        // 2. Numeric and Boolean types
        if (targetType == Long.class || targetType == long.class) {
            if (value instanceof Number) return ((Number) value).longValue();
            return Long.parseLong(strVal);
        }
        if (targetType == Integer.class || targetType == int.class) {
            if (value instanceof Number) return ((Number) value).intValue();
            return Integer.parseInt(strVal);
        }
        if (targetType == Boolean.class || targetType == boolean.class) {
            if (value instanceof Boolean) return value;
            return Boolean.parseBoolean(strVal);
        }
        if (targetType == Double.class || targetType == double.class) {
            if (value instanceof Number) return ((Number) value).doubleValue();
            return Double.parseDouble(strVal);
        }
        if (targetType == Float.class || targetType == float.class) {
            if (value instanceof Number) return ((Number) value).floatValue();
            return Float.parseFloat(strVal);
        }
        if (targetType == Short.class || targetType == short.class) {
            if (value instanceof Number) return ((Number) value).shortValue();
            return Short.parseShort(strVal);
        }
        if (targetType == Byte.class || targetType == byte.class) {
            if (value instanceof Number) return ((Number) value).byteValue();
            return Byte.parseByte(strVal);
        }
        if (targetType == BigDecimal.class) {
            if (value instanceof Number) return new BigDecimal(value.toString());
            return new BigDecimal(strVal);
        }
        if (targetType == BigInteger.class) {
            if (value instanceof Number) return BigInteger.valueOf(((Number) value).longValue());
            return new BigInteger(strVal);
        }

        // 3. Enum types
        if (targetType.isEnum()) {
            Class<Enum> enumClass = (Class<Enum>) targetType;
            try {
                return Enum.valueOf(enumClass, strVal);
            } catch (IllegalArgumentException e) {
                for (Enum<?> constant : enumClass.getEnumConstants()) {
                    if (constant.name().equalsIgnoreCase(strVal)) {
                        return constant;
                    }
                }
                if (value instanceof Number) {
                    int ordinal = ((Number) value).intValue();
                    Enum<?>[] constants = enumClass.getEnumConstants();
                    if (ordinal >= 0 && ordinal < constants.length) {
                        return constants[ordinal];
                    }
                }
                throw e;
            }
        }

        // 4. Date (java.util.Date)
        if (targetType == Date.class) {
            if (value instanceof Number) {
                return new Date(((Number) value).longValue());
            }
            if (value instanceof TemporalAccessor) {
                if (value instanceof LocalDateTime) {
                    return Date.from(((LocalDateTime) value).atZone(ZoneId.systemDefault()).toInstant());
                }
                if (value instanceof LocalDate) {
                    return Date.from(((LocalDate) value).atStartOfDay(ZoneId.systemDefault()).toInstant());
                }
                if (value instanceof Instant) {
                    return Date.from((Instant) value);
                }
            }
            return parseDate(strVal);
        }

        // 5. Java 8 Date & Time types (LocalDate, LocalDateTime, LocalTime)
        if (targetType == LocalDate.class) {
            if (value instanceof LocalDateTime) {
                return ((LocalDateTime) value).toLocalDate();
            }
            if (value instanceof Date) {
                return ((Date) value).toInstant().atZone(ZoneId.systemDefault()).toLocalDate();
            }
            if (value instanceof Number) {
                return Instant.ofEpochMilli(((Number) value).longValue()).atZone(ZoneId.systemDefault()).toLocalDate();
            }
            if (strVal.length() > 10 && (strVal.contains("T") || strVal.contains(" "))) {
                return LocalDate.parse(strVal.substring(0, 10));
            }
            return LocalDate.parse(strVal);
        }

        if (targetType == LocalDateTime.class) {
            if (value instanceof LocalDate) {
                return ((LocalDate) value).atStartOfDay();
            }
            if (value instanceof Date) {
                return ((Date) value).toInstant().atZone(ZoneId.systemDefault()).toLocalDateTime();
            }
            if (value instanceof Number) {
                return Instant.ofEpochMilli(((Number) value).longValue()).atZone(ZoneId.systemDefault()).toLocalDateTime();
            }
            if (strVal.contains(" ")) {
                return LocalDateTime.parse(strVal.replace(' ', 'T'));
            }
            if (strVal.length() == 10) {
                return LocalDate.parse(strVal).atStartOfDay();
            }
            return LocalDateTime.parse(strVal);
        }

        if (targetType == LocalTime.class) {
            if (value instanceof LocalDateTime) {
                return ((LocalDateTime) value).toLocalTime();
            }
            return LocalTime.parse(strVal);
        }

        // 6. Collections (List, Set, Collection, Iterable)
        if (List.class.isAssignableFrom(targetType) || Collection.class.equals(targetType) || Iterable.class.equals(targetType)) {
            if (value instanceof Collection) {
                return new ArrayList<>((Collection<?>) value);
            }
            if (value.getClass().isArray()) {
                int length = Array.getLength(value);
                List<Object> list = new ArrayList<>(length);
                for (int i = 0; i < length; i++) {
                    list.add(Array.get(value, i));
                }
                return list;
            }
            if (strVal.startsWith("[") && strVal.endsWith("]")) {
                String inner = strVal.substring(1, strVal.length() - 1).trim();
                if (inner.isEmpty()) return new ArrayList<>();
                return new ArrayList<>(Arrays.asList(inner.split("\\s*,\\s*")));
            }
            if (strVal.contains(",")) {
                return new ArrayList<>(Arrays.asList(strVal.split("\\s*,\\s*")));
            }
            return new ArrayList<>(Collections.singletonList(value));
        }

        if (Set.class.isAssignableFrom(targetType)) {
            if (value instanceof Collection) {
                return new LinkedHashSet<>((Collection<?>) value);
            }
            if (value.getClass().isArray()) {
                int length = Array.getLength(value);
                Set<Object> set = new LinkedHashSet<>(length);
                for (int i = 0; i < length; i++) {
                    set.add(Array.get(value, i));
                }
                return set;
            }
            if (strVal.startsWith("[") && strVal.endsWith("]")) {
                String inner = strVal.substring(1, strVal.length() - 1).trim();
                if (inner.isEmpty()) return new LinkedHashSet<>();
                return new LinkedHashSet<>(Arrays.asList(inner.split("\\s*,\\s*")));
            }
            if (strVal.contains(",")) {
                return new LinkedHashSet<>(Arrays.asList(strVal.split("\\s*,\\s*")));
            }
            return new LinkedHashSet<>(Collections.singletonList(value));
        }

        // 7. Map
        if (Map.class.isAssignableFrom(targetType) && value instanceof Map) {
            return value;
        }

        return value;
    }

    private Date parseDate(String strVal) {
        if (strVal.matches("^\\d+$")) {
            return new Date(Long.parseLong(strVal));
        }
        String[] patterns = {
                "yyyy-MM-dd HH:mm:ss",
                "yyyy-MM-dd'T'HH:mm:ss",
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                "yyyy-MM-dd'T'HH:mm:ssXXX",
                "yyyy-MM-dd",
                "yyyy/MM/dd HH:mm:ss",
                "yyyy/MM/dd"
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat sdf = new SimpleDateFormat(pattern);
                sdf.setLenient(false);
                return sdf.parse(strVal);
            } catch (Exception ignored) {
            }
        }
        try {
            return Date.from(Instant.parse(strVal));
        } catch (Exception e) {
            throw new IllegalArgumentException("Cannot parse Date string: " + strVal);
        }
    }

    /**
     * Clean up references to allow JVM GC to unload the Class and release Metaspace.
     */
    public synchronized void destroy() {
        this.methodMap.clear();
        this.defaultMethod = null;
        this.scriptInstance = null;
        this.scriptClass = null;
        if (this.classLoader != null) {
            this.classLoader.unload();
            this.classLoader = null;
        }
    }

    public ScriptInfo toScriptInfo() {
        ScriptInfo info = new ScriptInfo();
        info.setScriptKey(this.scriptKey);
        info.setVersion(this.version);
        info.setMd5(this.md5);
        info.setRemark(this.remark);
        info.setRegisterTime(this.registerTime);
        info.setLastInvokeTime(this.lastInvokeTime > 0 ? new Date(this.lastInvokeTime) : null);
        info.setInvokeCount(this.invokeCount.get());
        return info;
    }

    public Set<String> getAvailableMethods() {
        return methodMap.keySet();
    }

    public String getScriptKey() {
        return scriptKey;
    }

    public int getVersion() {
        return version;
    }

    public String getMd5() {
        return md5;
    }

    public String getRemark() {
        return remark;
    }

    public Date getRegisterTime() {
        return registerTime;
    }

    public long getLastInvokeTime() {
        return lastInvokeTime;
    }

    public long getInvokeCount() {
        return invokeCount.get();
    }
}
