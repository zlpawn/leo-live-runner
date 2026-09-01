package io.github.zlpawn.liverunner.autoconfigure.util;

import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;
import io.github.zlpawn.liverunner.core.annotation.LiveConfigDoc;
import io.github.zlpawn.liverunner.core.model.LiveRunnerConfigItem;
import org.springframework.core.env.Environment;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.*;

/**
 * High-performance, zero-runtime-overhead configuration metadata resolver.
 * Pre-scans and caches configuration descriptor metadata once at startup via reflection.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerConfigMetadataResolver {

    private final List<ConfigDescriptor> cachedDescriptors;

    public LiveRunnerConfigMetadataResolver() {
        this.cachedDescriptors = Collections.unmodifiableList(scanDescriptors(LiveRunnerProperties.class, "leo.live-runner", ""));
    }

    /**
     * Resolve all configuration items with real-time effective values from Environment or properties instance.
     */
    public List<LiveRunnerConfigItem> resolveConfigItems(LiveRunnerProperties properties, Environment env) {
        List<LiveRunnerConfigItem> items = new ArrayList<>(cachedDescriptors.size());
        for (ConfigDescriptor descriptor : cachedDescriptors) {
            Object effectiveValue = descriptor.resolveEffectiveValue(properties, env);
            items.add(new LiveRunnerConfigItem(
                    descriptor.getKey(),
                    effectiveValue,
                    descriptor.getDefaultValue(),
                    descriptor.getDesc(),
                    descriptor.getUnit(),
                    descriptor.isDynamic(),
                    descriptor.getGroup()
            ));
        }
        return items;
    }

    private static List<ConfigDescriptor> scanDescriptors(Class<?> clazz, String prefix, String parentGroup) {
        List<ConfigDescriptor> list = new ArrayList<>();
        LiveConfigDoc classDoc = clazz.getAnnotation(LiveConfigDoc.class);
        String currentGroup = (classDoc != null && !classDoc.group().isEmpty()) ? classDoc.group() : parentGroup;

        Field[] fields = clazz.getDeclaredFields();
        for (Field field : fields) {
            if (Modifier.isStatic(field.getModifiers())) {
                continue;
            }
            field.setAccessible(true);

            LiveConfigDoc doc = field.getAnnotation(LiveConfigDoc.class);
            String fieldKebab = toKebabCase(field.getName());
            String propertyKey = (doc != null && !doc.key().isEmpty()) ? doc.key() : (prefix + "." + fieldKebab);

            Class<?> type = field.getType();
            // Check if nested configuration class (e.g. Security, SqlSecurity, StuckTask, etc.)
            if (isNestedConfigClass(type)) {
                String nestedGroup = (doc != null && !doc.group().isEmpty()) ? doc.group() : currentGroup;
                List<ConfigDescriptor> nestedList = scanDescriptors(type, propertyKey, nestedGroup);
                for (ConfigDescriptor nestedDesc : nestedList) {
                    nestedDesc.prependField(field);
                    list.add(nestedDesc);
                }
            } else if (doc != null) {
                String group = !doc.group().isEmpty() ? doc.group() : currentGroup;
                Object defaultValue = extractDefaultValue(clazz, field);
                list.add(new ConfigDescriptor(
                        propertyKey,
                        fieldKebab,
                        field.getName(),
                        doc.desc(),
                        doc.unit(),
                        doc.dynamic(),
                        group,
                        defaultValue,
                        field.getType(),
                        new ArrayList<>(Collections.singletonList(field))
                ));
            }
        }
        return list;
    }

    private static boolean isNestedConfigClass(Class<?> type) {
        return !type.isPrimitive()
                && !type.getName().startsWith("java.")
                && !type.isEnum()
                && type.getDeclaredFields().length > 0;
    }

    private static Object extractDefaultValue(Class<?> rootClass, Field targetField) {
        try {
            Object instance = rootClass.getDeclaredConstructor().newInstance();
            return targetField.get(instance);
        } catch (Exception e) {
            return null;
        }
    }

    private static String toKebabCase(String input) {
        if (input == null || input.isEmpty()) {
            return "";
        }
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) {
                    result.append('-');
                }
                result.append(Character.toLowerCase(c));
            } else {
                result.append(c);
            }
        }
        return result.toString();
    }

    /**
     * Pre-computed descriptor for a single configuration field.
     */
    private static class ConfigDescriptor {
        private final String key;
        private final String kebabName;
        private final String camelName;
        private final String desc;
        private final String unit;
        private final boolean dynamic;
        private final String group;
        private final Object defaultValue;
        private final Class<?> valueType;
        private final List<Field> fieldPath;

        public ConfigDescriptor(String key, String kebabName, String camelName, String desc, String unit,
                                boolean dynamic, String group, Object defaultValue, Class<?> valueType, List<Field> fieldPath) {
            this.key = key;
            this.kebabName = kebabName;
            this.camelName = camelName;
            this.desc = desc;
            this.unit = unit != null ? unit : "";
            this.dynamic = dynamic;
            this.group = group != null ? group : "";
            this.defaultValue = defaultValue;
            this.valueType = valueType;
            this.fieldPath = fieldPath;
        }

        public void prependField(Field parentField) {
            this.fieldPath.add(0, parentField);
        }

        public String getKey() {
            return key;
        }

        public String getDesc() {
            return desc;
        }

        public String getUnit() {
            return unit;
        }

        public boolean isDynamic() {
            return dynamic;
        }

        public String getGroup() {
            return group;
        }

        public Object getDefaultValue() {
            return defaultValue;
        }

        public Object resolveEffectiveValue(LiveRunnerProperties rootInstance, Environment env) {
            if (dynamic && env != null) {
                try {
                    if (valueType == boolean.class || valueType == Boolean.class) {
                        Boolean val = env.getProperty(key, Boolean.class);
                        if (val != null) return val;
                    } else if (valueType == int.class || valueType == Integer.class) {
                        Integer val = env.getProperty(key, Integer.class);
                        if (val != null) return val;
                    } else if (valueType == long.class || valueType == Long.class) {
                        Long val = env.getProperty(key, Long.class);
                        if (val != null) return val;
                    } else if (valueType == String.class) {
                        String val = env.getProperty(key);
                        if (val != null) return val;
                    }
                } catch (Exception ignored) {
                }
            }

            // Read from rootInstance via cached field path
            try {
                Object current = rootInstance;
                for (Field field : fieldPath) {
                    if (current == null) return defaultValue;
                    current = field.get(current);
                }
                return current != null ? current : defaultValue;
            } catch (Exception e) {
                return defaultValue;
            }
        }
    }
}
