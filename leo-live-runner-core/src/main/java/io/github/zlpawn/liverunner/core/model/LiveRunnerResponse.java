package io.github.zlpawn.liverunner.core.model;

import java.io.Serializable;

/**
 * Unified enterprise response structure for Live Runner operations.
 *
 * @author Leo (zlpawn)
 */
public class LiveRunnerResponse<T> implements Serializable {
    private static final long serialVersionUID = 1L;

    private int code;
    private boolean success;
    private String msg;
    private T data;
    private long costMs;

    public LiveRunnerResponse() {
    }

    public LiveRunnerResponse(int code, boolean success, String msg, T data, long costMs) {
        this.code = code;
        this.success = success;
        this.msg = msg;
        this.data = data;
        this.costMs = costMs;
    }

    public static <T> LiveRunnerResponse<T> success(T data, String msg, long costMs) {
        return new LiveRunnerResponse<>(200, true, msg, data, costMs);
    }

    public static <T> LiveRunnerResponse<T> fail(int code, String msg, long costMs) {
        return new LiveRunnerResponse<>(code, false, msg, null, costMs);
    }

    public int getCode() {
        return code;
    }

    public void setCode(int code) {
        this.code = code;
    }

    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public String getMsg() {
        return msg;
    }

    public void setMsg(String msg) {
        this.msg = msg;
    }

    public T getData() {
        return data;
    }

    public void setData(T data) {
        this.data = data;
    }

    public long getCostMs() {
        return costMs;
    }

    public void setCostMs(long costMs) {
        this.costMs = costMs;
    }
}
