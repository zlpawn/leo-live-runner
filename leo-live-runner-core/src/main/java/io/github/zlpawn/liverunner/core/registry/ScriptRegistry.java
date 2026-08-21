package io.github.zlpawn.liverunner.core.registry;

import io.github.zlpawn.liverunner.core.model.ScriptHolder;
import io.github.zlpawn.liverunner.core.model.ScriptInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Thread-safe central registry managing in-memory live scripts.
 *
 * @author Leo (zlpawn)
 */
public class ScriptRegistry {
    private static final Logger log = LoggerFactory.getLogger(ScriptRegistry.class);

    private final ConcurrentMap<String, ScriptHolder> scriptMap = new ConcurrentHashMap<>();

    /**
     * Put a new or updated script holder, destroying the previous one if existed.
     */
    public synchronized ScriptHolder put(String scriptKey, ScriptHolder newHolder) {
        ScriptHolder oldHolder = scriptMap.put(scriptKey, newHolder);
        if (oldHolder != null) {
            log.info("LiveRunner: Hot-replacing script [{}], version {} -> {}",
                    scriptKey, oldHolder.getVersion(), newHolder.getVersion());
            oldHolder.destroy();
        } else {
            log.info("LiveRunner: Registered new script [{}] with version {}",
                    scriptKey, newHolder.getVersion());
        }
        return newHolder;
    }

    /**
     * Get a registered script holder by scriptKey.
     */
    public ScriptHolder get(String scriptKey) {
        return scriptMap.get(scriptKey);
    }

    /**
     * Unregister and unload a script by scriptKey.
     */
    public synchronized boolean unregister(String scriptKey) {
        ScriptHolder holder = scriptMap.remove(scriptKey);
        if (holder != null) {
            log.info("LiveRunner: Unregistering and destroying script [{}]", scriptKey);
            holder.destroy();
            return true;
        }
        return false;
    }

    /**
     * Check if a script is registered.
     */
    public boolean contains(String scriptKey) {
        return scriptMap.containsKey(scriptKey);
    }

    /**
     * List all registered script metadata.
     */
    public List<ScriptInfo> listAll() {
        List<ScriptInfo> list = new ArrayList<>();
        for (ScriptHolder holder : scriptMap.values()) {
            list.add(holder.toScriptInfo());
        }
        return list;
    }

    /**
     * Total number of registered scripts.
     */
    public int size() {
        return scriptMap.size();
    }

    /**
     * Clear and destroy all scripts.
     */
    public synchronized void clear() {
        for (ScriptHolder holder : scriptMap.values()) {
            holder.destroy();
        }
        scriptMap.clear();
    }
}
