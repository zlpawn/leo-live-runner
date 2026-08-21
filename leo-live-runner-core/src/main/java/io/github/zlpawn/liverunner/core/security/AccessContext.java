package io.github.zlpawn.liverunner.core.security;

import java.io.Serializable;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Extensible access context containing request metadata and runtime environment.
 * Designed for maximum backward compatibility and future expansion.
 *
 * @author Leo (zlpawn)
 */
public class AccessContext implements Serializable {
    private static final long serialVersionUID = 1L;

    /**
     * Target endpoint action ("execute", "register", "invoke", "list", "unregister").
     */
    private final String endpoint;

    /**
     * Target script key (e.g. "order-api", null for one-shot execution).
     */
    private final String scriptKey;

    /**
     * Target secondary method name (e.g. "query", "cancel", null for default method).
     */
    private final String methodName;

    /**
     * Client IP address (resolved through reverse proxies/SLBs).
     */
    private final String clientIp;

    /**
     * HTTP request headers (case-insensitive key mapping).
     */
    private final Map<String, String> headers;

    /**
     * Business parameters map.
     */
    private final Map<String, Object> params;

    /**
     * Underlying raw request object (e.g. HttpServletRequest).
     */
    private final transient Object rawRequest;

    /**
     * Mutable context attribute store for inter-validator data passing.
     */
    private final Map<String, Object> attributes = new ConcurrentHashMap<>();

    public AccessContext(Builder builder) {
        this.endpoint = builder.endpoint;
        this.scriptKey = builder.scriptKey;
        this.methodName = builder.methodName;
        this.clientIp = builder.clientIp;
        this.headers = builder.headers != null ? Collections.unmodifiableMap(builder.headers) : Collections.emptyMap();
        this.params = builder.params != null ? Collections.unmodifiableMap(builder.params) : Collections.emptyMap();
        this.rawRequest = builder.rawRequest;
    }

    public static Builder builder() {
        return new Builder();
    }

    /**
     * Get header value by name (case-insensitive).
     */
    public String getHeader(String headerName) {
        if (headerName == null || headers.isEmpty()) {
            return null;
        }
        String direct = headers.get(headerName);
        if (direct != null) {
            return direct;
        }
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(headerName)) {
                return entry.getValue();
            }
        }
        return null;
    }

    public void setAttribute(String key, Object value) {
        if (key != null && value != null) {
            this.attributes.put(key, value);
        }
    }

    @SuppressWarnings("unchecked")
    public <T> T getAttribute(String key) {
        return (T) this.attributes.get(key);
    }

    public String getEndpoint() {
        return endpoint;
    }

    public String getScriptKey() {
        return scriptKey;
    }

    public String getMethodName() {
        return methodName;
    }

    public String getClientIp() {
        return clientIp;
    }

    public Map<String, String> getHeaders() {
        return headers;
    }

    public Map<String, Object> getParams() {
        return params;
    }

    public Object getRawRequest() {
        return rawRequest;
    }

    public Map<String, Object> getAttributes() {
        return Collections.unmodifiableMap(attributes);
    }

    public static class Builder {
        private String endpoint;
        private String scriptKey;
        private String methodName;
        private String clientIp;
        private Map<String, String> headers = new HashMap<>();
        private Map<String, Object> params = new HashMap<>();
        private Object rawRequest;

        public Builder endpoint(String endpoint) {
            this.endpoint = endpoint;
            return this;
        }

        public Builder scriptKey(String scriptKey) {
            this.scriptKey = scriptKey;
            return this;
        }

        public Builder methodName(String methodName) {
            this.methodName = methodName;
            return this;
        }

        public Builder clientIp(String clientIp) {
            this.clientIp = clientIp;
            return this;
        }

        public Builder headers(Map<String, String> headers) {
            if (headers != null) {
                this.headers.putAll(headers);
            }
            return this;
        }

        public Builder params(Map<String, Object> params) {
            if (params != null) {
                this.params.putAll(params);
            }
            return this;
        }

        public Builder rawRequest(Object rawRequest) {
            this.rawRequest = rawRequest;
            return this;
        }

        public AccessContext build() {
            return new AccessContext(this);
        }
    }
}
