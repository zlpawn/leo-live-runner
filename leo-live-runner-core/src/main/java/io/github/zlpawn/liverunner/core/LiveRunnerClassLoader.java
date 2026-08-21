package io.github.zlpawn.liverunner.core;

import groovy.lang.GroovyClassLoader;
import org.codehaus.groovy.control.CompilerConfiguration;

import java.io.IOException;

/**
 * Isolated ClassLoader for dynamic scripts.
 * Configured with parameter metadata retention (-parameters) for seamless JSON mapping.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerClassLoader extends GroovyClassLoader {

    private static final CompilerConfiguration DEFAULT_CONFIG;

    static {
        DEFAULT_CONFIG = new CompilerConfiguration();
        enableParametersIfSupported(DEFAULT_CONFIG);
    }

    public static void enableParametersIfSupported(CompilerConfiguration config) {
        if (config == null) {
            return;
        }
        try {
            java.lang.reflect.Method m = CompilerConfiguration.class.getMethod("setParameters", boolean.class);
            m.invoke(config, true);
        } catch (Throwable ignored) {
            // Groovy 2.4.x does not have setParameters method; gracefully ignored
        }
    }

    public LiveRunnerClassLoader() {
        super(Thread.currentThread().getContextClassLoader(), DEFAULT_CONFIG);
    }

    public LiveRunnerClassLoader(ClassLoader parent) {
        super(parent, DEFAULT_CONFIG);
    }

    public LiveRunnerClassLoader(ClassLoader parent, CompilerConfiguration config) {
        super(parent, config != null ? config : DEFAULT_CONFIG);
    }

    /**
     * Unload and clean up class references.
     */
    public void unload() {
        try {
            this.clearCache();
            this.close();
        } catch (IOException ignored) {
        }
    }
}
