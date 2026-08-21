package io.github.zlpawn.liverunner.core.model;

import java.io.Serializable;
import java.util.Date;

/**
 * Metadata info representing a registered live script.
 *
 * @author Leo (zlpawn)
 */
public class ScriptInfo implements Serializable {
    private static final long serialVersionUID = 1L;

    private String scriptKey;
    private int version;
    private String md5;
    private String remark;
    private Date registerTime;
    private Date lastInvokeTime;
    private long invokeCount;

    public ScriptInfo() {
    }

    public String getScriptKey() {
        return scriptKey;
    }

    public void setScriptKey(String scriptKey) {
        this.scriptKey = scriptKey;
    }

    public int getVersion() {
        return version;
    }

    public void setVersion(int version) {
        this.version = version;
    }

    public String getMd5() {
        return md5;
    }

    public void setMd5(String md5) {
        this.md5 = md5;
    }

    public String getRemark() {
        return remark;
    }

    public void setRemark(String remark) {
        this.remark = remark;
    }

    public Date getRegisterTime() {
        return registerTime;
    }

    public void setRegisterTime(Date registerTime) {
        this.registerTime = registerTime;
    }

    public Date getLastInvokeTime() {
        return lastInvokeTime;
    }

    public void setLastInvokeTime(Date lastInvokeTime) {
        this.lastInvokeTime = lastInvokeTime;
    }

    public long getInvokeCount() {
        return invokeCount;
    }

    public void setInvokeCount(long invokeCount) {
        this.invokeCount = invokeCount;
    }
}
