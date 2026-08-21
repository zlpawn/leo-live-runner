package io.github.zlpawn.liverunner.core.model;

import java.io.Serializable;

/**
 * Standard execution result returned after calling a dynamic script.
 *
 * @author Leo (zlpawn)
 */
public class ScriptExecuteResult implements Serializable {
    private static final long serialVersionUID = 1L;

    private boolean success;
    private Object result;
    private String logs;
    private String error;
    private long costMs;

    public ScriptExecuteResult() {
    }

    public static ScriptExecuteResult success(Object result, String logs, long costMs) {
        ScriptExecuteResult res = new ScriptExecuteResult();
        res.setSuccess(true);
        res.setResult(result);
        res.setLogs(logs);
        res.setCostMs(costMs);
        return res;
    }

    public static ScriptExecuteResult fail(String error, String logs, long costMs) {
        ScriptExecuteResult res = new ScriptExecuteResult();
        res.setSuccess(false);
        res.setError(error);
        res.setLogs(logs);
        res.setCostMs(costMs);
        return res;
    }

    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public Object getResult() {
        return result;
    }

    public void setResult(Object result) {
        this.result = result;
    }

    public String getLogs() {
        return logs;
    }

    public void setLogs(String logs) {
        this.logs = logs;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public long getCostMs() {
        return costMs;
    }

    public void setCostMs(long costMs) {
        this.costMs = costMs;
    }
}
