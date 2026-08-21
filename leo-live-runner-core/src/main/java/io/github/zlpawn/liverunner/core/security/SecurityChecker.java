package io.github.zlpawn.liverunner.core.security;

import org.codehaus.groovy.control.CompilerConfiguration;
import org.codehaus.groovy.control.customizers.SecureASTCustomizer;

import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Multi-layer Security Validator for Live Runner dynamic code.
 * 1. Pre-compilation static keyword / pattern inspection.
 * 2. Groovy SecureASTCustomizer compilation-level AST receiver & import blacklisting.
 *
 * @author Leo (zlpawn)
 */
public class SecurityChecker {

    private static final List<Pattern> FORBIDDEN_PATTERNS = Arrays.asList(
            Pattern.compile("System\\s*\\.\\s*exit", Pattern.CASE_INSENSITIVE),
            Pattern.compile("Runtime\\s*\\.\\s*getRuntime\\s*\\(\\s*\\)\\s*\\.\\s*exec", Pattern.CASE_INSENSITIVE),
            Pattern.compile("ProcessBuilder", Pattern.CASE_INSENSITIVE),
            Pattern.compile("sun\\.misc\\.Unsafe", Pattern.CASE_INSENSITIVE),
            Pattern.compile("jdk\\.internal\\.misc\\.Unsafe", Pattern.CASE_INSENSITIVE),
            Pattern.compile("Thread\\s*\\.\\s*currentThread\\s*\\(\\s*\\)\\s*\\.\\s*stop", Pattern.CASE_INSENSITIVE),
            Pattern.compile("System\\s*\\.\\s*setSecurityManager", Pattern.CASE_INSENSITIVE)
    );

    /**
     * Inspect source code text against forbidden high-risk keywords before compilation.
     */
    public static void checkSourceCode(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return;
        }

        for (Pattern p : FORBIDDEN_PATTERNS) {
            if (p.matcher(scriptSource).find()) {
                throw new SecurityException("Security Violation: High-risk code pattern [" +
                        p.pattern() + "] is strictly forbidden in Live Runner.");
            }
        }
    }

    /**
     * Build a secure CompilerConfiguration with AST-level blacklisting.
     */
    public static CompilerConfiguration createSecureCompilerConfig() {
        CompilerConfiguration config = new CompilerConfiguration();
        config.setParameters(true); // Preserve parameter names for method parameter reflection

        SecureASTCustomizer customizer = new SecureASTCustomizer();
        customizer.setReceiversBlackList(Arrays.asList(
                System.class.getName(),
                Runtime.class.getName(),
                ProcessBuilder.class.getName(),
                "sun.misc.Unsafe",
                "jdk.internal.misc.Unsafe"
        ));

        customizer.setImportsBlacklist(Arrays.asList(
                "sun.misc.*",
                "jdk.internal.*"
        ));

        config.addCompilationCustomizers(customizer);
        return config;
    }
}
