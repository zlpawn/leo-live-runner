package io.github.zlpawn.liverunner.autoconfigure.util;

import io.github.zlpawn.liverunner.core.security.AccessContext;

import javax.servlet.http.HttpServletRequest;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;

/**
 * Utility for building {@link AccessContext} from {@link HttpServletRequest}.
 *
 * @author Leo (zlpawn)
 */
public class AccessContextBuilder {

    public static AccessContext build(HttpServletRequest request, String endpoint, String scriptKey,
                                      String methodName, Map<String, Object> params) {
        String clientIp = resolveClientIp(request);
        Map<String, String> headers = resolveHeaders(request);

        return AccessContext.builder()
                .endpoint(endpoint)
                .scriptKey(scriptKey)
                .methodName(methodName)
                .clientIp(clientIp)
                .headers(headers)
                .params(params != null ? params : new HashMap<>())
                .rawRequest(request)
                .build();
    }

    private static Map<String, String> resolveHeaders(HttpServletRequest request) {
        Map<String, String> headers = new HashMap<>();
        if (request == null) {
            return headers;
        }
        Enumeration<String> headerNames = request.getHeaderNames();
        if (headerNames != null) {
            while (headerNames.hasMoreElements()) {
                String name = headerNames.nextElement();
                headers.put(name, request.getHeader(name));
            }
        }
        return headers;
    }

    private static String resolveClientIp(HttpServletRequest request) {
        if (request == null) {
            return "unknown";
        }
        String[] headerNames = {"X-Forwarded-For", "X-Real-IP", "Proxy-Client-IP", "WL-Proxy-Client-IP", "HTTP_CLIENT_IP"};
        for (String header : headerNames) {
            String ip = request.getHeader(header);
            if (ip != null && !ip.trim().isEmpty() && !"unknown".equalsIgnoreCase(ip.trim())) {
                if (ip.contains(",")) {
                    return ip.split(",")[0].trim();
                }
                return ip.trim();
            }
        }
        return request.getRemoteAddr() != null ? request.getRemoteAddr() : "unknown";
    }
}
