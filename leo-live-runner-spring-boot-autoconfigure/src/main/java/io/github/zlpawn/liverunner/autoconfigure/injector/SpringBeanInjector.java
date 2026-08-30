package io.github.zlpawn.liverunner.autoconfigure.injector;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.context.ApplicationContext;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import io.github.zlpawn.liverunner.autoconfigure.properties.LiveRunnerProperties;

import java.lang.annotation.Annotation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.function.Function;

/**
 * Intelligent Spring Bean Injector and @Transactional AOP Proxy enhancer.
 * 1. Automatically injects Spring Beans matching @Autowired, @Resource, @Qualifier or field names.
 * 2. Automatically wraps the dynamic instance with a Spring CGLIB Transactional Proxy if @Transactional is present.
 *
 * @author Leo (zlpawn)
 */
public class SpringBeanInjector implements Function<Object, Object> {
    private static final Logger log = LoggerFactory.getLogger(SpringBeanInjector.class);

    private final ApplicationContext applicationContext;
    private final LiveRunnerProperties properties;

    public SpringBeanInjector(ApplicationContext applicationContext) {
        this(applicationContext, null);
    }

    public SpringBeanInjector(ApplicationContext applicationContext, LiveRunnerProperties properties) {
        this.applicationContext = applicationContext;
        this.properties = properties;
    }

    @Override
    public Object apply(Object rawInstance) {
        return injectAndWrap(rawInstance);
    }

    /**
     * Inject Spring beans into fields and wrap with Transactional AOP Proxy if needed.
     *
     * @param rawInstance The freshly compiled and instantiated dynamic object
     * @return The original instance or proxied instance
     */
    public Object injectAndWrap(Object rawInstance) {
        if (rawInstance == null) {
            return null;
        }

        // 1. Reflectively inject Spring Beans into fields
        injectFields(rawInstance);

        // 2. Automatically create CGLIB Transactional Proxy if @Transactional is detected
        if (hasTransactionalAnnotation(rawInstance.getClass())) {
            return wrapTransactionalProxy(rawInstance);
        }

        return rawInstance;
    }

    private void injectFields(Object instance) {
        Class<?> clazz = instance.getClass();
        while (clazz != null && clazz != Object.class) {
            for (Field field : clazz.getDeclaredFields()) {
                injectField(instance, field);
            }
            clazz = clazz.getSuperclass();
        }
    }

    private void injectField(Object instance, Field field) {
        Annotation[] annotations = field.getAnnotations();

        String specifiedBeanName = null;
        boolean shouldInject = false;

        for (Annotation ann : annotations) {
            String simpleName = ann.annotationType().getSimpleName();
            if ("Resource".equals(simpleName)) {
                shouldInject = true;
                specifiedBeanName = getAnnotationStringAttribute(ann, "name");
            } else if ("Autowired".equals(simpleName)) {
                shouldInject = true;
            } else if ("Qualifier".equals(simpleName)) {
                specifiedBeanName = getAnnotationStringAttribute(ann, "value");
            }
        }

        // Zero-annotation fallback: if field name matches a bean in ApplicationContext
        if (!shouldInject && applicationContext.containsBean(field.getName())) {
            shouldInject = true;
        }

        if (shouldInject) {
            // Check denied-beans blacklist if configured
            if (properties != null && properties.getSecurity() != null) {
                java.util.List<String> deniedBeans = properties.getSecurity().getDeniedBeans();
                if (deniedBeans != null && !deniedBeans.isEmpty()) {
                    if (deniedBeans.contains(specifiedBeanName) || deniedBeans.contains(field.getName())) {
                        throw new SecurityException("Injection Security Violation: Spring bean [" +
                                (specifiedBeanName != null ? specifiedBeanName : field.getName()) +
                                "] is blacklisted in leo.live-runner.security.denied-beans");
                    }
                }
            }

            Object bean = resolveBean(field, specifiedBeanName);
            if (bean != null) {
                field.setAccessible(true);
                try {
                    field.set(instance, bean);
                    log.debug("LiveRunner: Injected Spring bean [{}] into field [{}]", bean.getClass().getSimpleName(), field.getName());
                } catch (Exception e) {
                    log.warn("LiveRunner: Failed to inject Spring bean into field [{}]: {}", field.getName(), e.getMessage());
                }
            }
        }
    }

    private Object resolveBean(Field field, String specifiedBeanName) {
        try {
            if (specifiedBeanName != null && !specifiedBeanName.trim().isEmpty()) {
                if (applicationContext.containsBean(specifiedBeanName)) {
                    return applicationContext.getBean(specifiedBeanName);
                }
            }
            if (applicationContext.containsBean(field.getName())) {
                Object bean = applicationContext.getBean(field.getName());
                if (field.getType().isAssignableFrom(bean.getClass())) {
                    return bean;
                }
            }
            String[] beanNames = applicationContext.getBeanNamesForType(field.getType());
            if (beanNames.length > 0) {
                return applicationContext.getBean(field.getType());
            }
        } catch (Exception e) {
            log.warn("LiveRunner: Error looking up bean for field [{}]: {}", field.getName(), e.getMessage());
        }
        return null;
    }

    private boolean hasTransactionalAnnotation(Class<?> clazz) {
        for (Annotation ann : clazz.getAnnotations()) {
            if ("Transactional".equals(ann.annotationType().getSimpleName())) {
                return true;
            }
        }
        for (Method m : clazz.getMethods()) {
            for (Annotation ann : m.getAnnotations()) {
                if ("Transactional".equals(ann.annotationType().getSimpleName())) {
                    return true;
                }
            }
        }
        return false;
    }

    private Object wrapTransactionalProxy(Object target) {
        try {
            String[] txBeanNames = applicationContext.getBeanNamesForType(PlatformTransactionManager.class);
            if (txBeanNames.length == 0) {
                log.warn("LiveRunner: @Transactional detected on script [{}], but no PlatformTransactionManager found in Spring context. Skipping proxy wrapping.",
                        target.getClass().getName());
                return target;
            }

            PlatformTransactionManager txManager = applicationContext.getBean(PlatformTransactionManager.class);
            TransactionInterceptor txAdvice = new TransactionInterceptor(txManager, new AnnotationTransactionAttributeSource());

            ProxyFactory proxyFactory = new ProxyFactory(target);
            proxyFactory.setProxyTargetClass(true); // CGLIB proxy for full class compatibility
            proxyFactory.addAdvice(txAdvice);

            Object proxy = proxyFactory.getProxy();
            log.info("LiveRunner: Successfully created CGLIB @Transactional AOP proxy for dynamic script [{}]",
                    target.getClass().getName());
            return proxy;
        } catch (Throwable e) {
            log.warn("LiveRunner: Failed to create @Transactional proxy for script [{}]: {}",
                    target.getClass().getName(), e.getMessage());
            return target;
        }
    }

    private String getAnnotationStringAttribute(Annotation ann, String attributeName) {
        try {
            Method m = ann.annotationType().getMethod(attributeName);
            Object val = m.invoke(ann);
            return val != null ? val.toString() : null;
        } catch (Exception e) {
            return null;
        }
    }
}
