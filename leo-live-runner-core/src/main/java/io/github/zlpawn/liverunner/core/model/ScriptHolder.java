package io.github.zlpawn.liverunner.core.model;

import io.github.zlpawn.liverunner.core.LiveLogger;
import io.github.zlpawn.liverunner.core.LiveRunnerClassLoader;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.math.BigDecimal;
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

            // 2. Full Map injection
            if (Map.class.isAssignableFrom(type)) {
                args[i] = params;
                continue;
            }

            // 3. Name-based parameter extraction from JSON Map
            String paramName = p.getName();
            Object rawValue = findParamValue(params, paramName);

            // 4. Positional fallback if name matching didn't hit (e.g. arg0, arg1)
            if (rawValue == null && nonLoggerIndex < paramValuesList.size()) {
                if (paramName.startsWith("arg") || !params.containsKey(paramName)) {
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

        if (targetType == String.class) {
            return strVal;
        }
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
            return new BigDecimal(strVal);
        }

        return value;
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
