package io.github.zlpawn.liverunner.core.security;

import io.github.zlpawn.liverunner.core.LiveRunnerClassLoader;
import org.codehaus.groovy.control.CompilerConfiguration;
import org.codehaus.groovy.control.customizers.SecureASTCustomizer;

import java.util.Arrays;

/**
 * Multi-layer Security Validator for Live Runner dynamic code.
 * 1. Pre-compilation static keyword / pattern inspection via {@link DefaultSecurityCheckerValidator}.
 * 2. Groovy SecureASTCustomizer compilation-level AST receiver & import blacklisting.
 *
 * @author Leo (zlpawn)
 */
public class SecurityChecker {

    private static final DefaultSecurityCheckerValidator DEFAULT_VALIDATOR = new DefaultSecurityCheckerValidator();

    /**
     * Inspect source code text against default security rules before compilation.
     */
    public static void checkSourceCode(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return;
        }

        CodeValidationResult result = DEFAULT_VALIDATOR.validate(null, scriptSource);
        if (result != null && result.isDenied()) {
            throw new SecurityException(result.getReason());
        }
    }

    /**
     * Build a secure CompilerConfiguration with AST-level blacklisting.
     */
    public static CompilerConfiguration createSecureCompilerConfig() {
        return createSecureCompilerConfig(false);
    }

    /**
     * Build a secure CompilerConfiguration with AST-level blacklisting, respecting process execution preference.
     *
     * @param allowProcessExec whether to allow OS command execution / process builder
     */
    public static CompilerConfiguration createSecureCompilerConfig(boolean allowProcessExec) {
        CompilerConfiguration config = new CompilerConfiguration();
        LiveRunnerClassLoader.enableParametersIfSupported(config); // Preserve parameter names if supported

        SecureASTCustomizer customizer = new SecureASTCustomizer();
        java.util.List<String> receiversBlackList = new java.util.ArrayList<>(Arrays.asList(
                System.class.getName(),
                "sun.misc.Unsafe",
                "jdk.internal.misc.Unsafe"
        ));

        if (!allowProcessExec) {
            receiversBlackList.add(Runtime.class.getName());
            receiversBlackList.add(ProcessBuilder.class.getName());
        }

        customizer.setReceiversBlackList(receiversBlackList);

        customizer.setImportsBlacklist(Arrays.asList(
                "sun.misc.Unsafe",
                "jdk.internal.misc.Unsafe"
        ));

        customizer.setStarImportsBlacklist(Arrays.asList(
                "sun.misc.*",
                "jdk.internal.*",
                "sun.misc.",
                "jdk.internal."
        ));

        customizer.setIndirectImportCheckEnabled(true);

        config.addCompilationCustomizers(customizer);
        return config;
    }
}
