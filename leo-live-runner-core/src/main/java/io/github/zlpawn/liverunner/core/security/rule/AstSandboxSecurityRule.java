package io.github.zlpawn.liverunner.core.security.rule;

import groovy.lang.GroovyClassLoader;
import io.github.zlpawn.liverunner.core.security.SecurityChecker;
import org.codehaus.groovy.control.CompilerConfiguration;
import org.codehaus.groovy.control.MultipleCompilationErrorsException;

/**
 * Groovy compiler AST-level sandbox security rule.
 * Leverages Groovy's {@code SecureASTCustomizer} to intercept forbidden receivers
 * (System, Runtime, ProcessBuilder, Unsafe) and forbidden package imports at compile-time.
 *
 * @author Leo (zlpawn)
 */
public class AstSandboxSecurityRule implements SecurityRule {

    public static final AstSandboxSecurityRule INSTANCE = new AstSandboxSecurityRule();

    private final boolean allowProcessExec;

    public AstSandboxSecurityRule() {
        this(false);
    }

    public AstSandboxSecurityRule(boolean allowProcessExec) {
        this.allowProcessExec = allowProcessExec;
    }

    @Override
    public String getName() {
        return SecurityRuleType.AST_SANDBOX_SECURITY.getCode();
    }

    @Override
    public RuleResult check(String scriptSource) {
        if (scriptSource == null || scriptSource.trim().isEmpty()) {
            return RuleResult.pass();
        }

        CompilerConfiguration config = SecurityChecker.createSecureCompilerConfig(allowProcessExec);
        try (GroovyClassLoader testLoader = new GroovyClassLoader(Thread.currentThread().getContextClassLoader(), config)) {
            testLoader.parseClass(scriptSource);
            return RuleResult.pass();
        } catch (SecurityException e) {
            return RuleResult.fail("AST Sandbox Violation: " + e.getMessage());
        } catch (MultipleCompilationErrorsException e) {
            String message = e.getMessage();
            if (isSecurityViolation(message, e)) {
                return RuleResult.fail("AST Sandbox Violation: " + extractReason(message));
            }
            // General syntax error: pass through to let compilation engine report exact line & error
            return RuleResult.pass();
        } catch (Throwable t) {
            if (t.getCause() instanceof SecurityException) {
                return RuleResult.fail("AST Sandbox Violation: " + t.getCause().getMessage());
            }
            return RuleResult.pass();
        }
    }

    private boolean isSecurityViolation(String message, MultipleCompilationErrorsException e) {
        if (message != null) {
            if (message.contains("SecureASTCustomizer")
                    || message.contains("Method calls not allowed on")
                    || message.contains("Indirect method calls not allowed on")
                    || message.contains("Expression not allowed")
                    || message.contains("Import not allowed")
                    || message.contains("Receivers not allowed")
                    || message.contains("Package not allowed")) {
                return true;
            }
        }
        Throwable cause = e.getCause();
        while (cause != null) {
            if (cause instanceof SecurityException) {
                return true;
            }
            cause = cause.getCause();
        }
        return false;
    }

    private String extractReason(String fullMessage) {
        if (fullMessage == null) {
            return "Security sandbox violation during AST compilation.";
        }
        String[] lines = fullMessage.split("\\r?\\n");
        for (String line : lines) {
            if (line.contains("Method calls not allowed")
                    || line.contains("Indirect method calls not allowed")
                    || line.contains("Import not allowed")
                    || line.contains("not allowed")) {
                return line.trim();
            }
        }
        return lines.length > 0 ? lines[0].trim() : fullMessage;
    }
}
