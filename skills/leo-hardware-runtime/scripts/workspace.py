#!/usr/bin/env python3
"""Cross-platform workspace and configuration manager for leo-hardware-runtime.

Manages persistent user configuration at:
  ~/.shrimp/skills/leo-hardware-runtime/config.json

Provides 3-tier cascade resolution for output_dir:
1. Explicitly specified --output-dir (persisted to config.json unless persist=False)
2. Configured output_dir in ~/.shrimp/skills/leo-hardware-runtime/config.json
3. Default fallback: ~/.shrimp/skills/leo-hardware-runtime/output
"""

import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path


class ConfigError(Exception):
    """Raised when config.json exists but is corrupt or unreadable."""


def get_skill_home():
    """Return ~/.shrimp/skills/leo-hardware-runtime (overridable via env)."""
    env_home = os.environ.get("LEO_HARDWARE_RUNTIME_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return Path.home() / ".shrimp" / "skills" / "leo-hardware-runtime"


def get_config_path():
    """Return config.json path (overridable via LEO_HARDWARE_CONFIG_PATH)."""
    env_cfg = os.environ.get("LEO_HARDWARE_CONFIG_PATH")
    if env_cfg:
        return Path(env_cfg).expanduser().resolve()
    return get_skill_home() / "config.json"


def get_default_output_dir():
    """Return default output directory under ~/.shrimp/skills/leo-hardware-runtime/output."""
    return get_skill_home() / "output"


def read_config():
    """Read config.json; return defaults if absent; raise ConfigError if corrupt."""
    cfg_path = get_config_path()
    defaults = {
        "output_dir": "",
        "backend_dir": "",
        "renode_bin": "",
        "updated_at": None,
    }
    if not cfg_path.exists():
        return defaults
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise ConfigError(f"{cfg_path} is corrupt or unreadable ({exc}); fix or remove it") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{cfg_path} is corrupt (expected JSON object); fix or remove it")
    return {**defaults, **data}


def write_config(config):
    """Write config.json atomically."""
    cfg_path = get_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        **config,
        "updated_at": datetime.datetime.now().astimezone().isoformat(),
    }
    tmp_path = cfg_path.parent / f".config-{os.getpid()}.tmp"
    try:
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(cfg_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return payload


def update_config(partial):
    """Merge partial keys into config.json and persist."""
    current = read_config()
    current.update(partial)
    return write_config(current)


def resolve_output_dir(explicit_output_dir=None, persist=True):
    """Resolve effective output root using 3-tier cascade."""
    if explicit_output_dir and str(explicit_output_dir).strip():
        resolved = Path(str(explicit_output_dir).strip()).expanduser().resolve()
        if persist:
            update_config({"output_dir": str(resolved)})
        return {"dir": resolved, "source": "user_specified", "persisted": bool(persist)}

    cfg = read_config()
    cfg_dir = cfg.get("output_dir")
    if cfg_dir and isinstance(cfg_dir, str) and cfg_dir.strip():
        return {"dir": Path(cfg_dir).expanduser().resolve(), "source": "config", "persisted": False}

    return {"dir": get_default_output_dir().resolve(), "source": "default", "persisted": False}


def allocate_run_dir(device_name, tag="", explicit_output_dir=None, persist=True):
    """Allocate a dated run directory under the resolved output root."""
    info = resolve_output_dir(explicit_output_dir=explicit_output_dir, persist=persist)
    now = datetime.datetime.now()
    safe_dev = re.sub(r"[^a-zA-Z0-9_-]+", "_", device_name or "device").strip("_") or "device"
    safe_tag = re.sub(r"[^a-zA-Z0-9_-]+", "_", tag).strip("_") if tag else ""
    leaf = f"{safe_dev}_{now.strftime('%H%M%S')}" + (f"_{safe_tag}" if safe_tag else "")
    run_dir = info["dir"] / now.strftime("%Y-%m-%d") / leaf
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir, info


def main():
    parser = argparse.ArgumentParser(description="Manage ~/.shrimp/skills/leo-hardware-runtime/config.json")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="Show config.json and effective directories")

    p_set_out = sub.add_parser("set-output", help="Persist default output_dir in config.json")
    p_set_out.add_argument("dir", help="Target output directory path")

    p_set = sub.add_parser("set", help="Set config fields (output_dir / backend_dir / renode_bin)")
    p_set.add_argument("--output-dir", default=None)
    p_set.add_argument("--backend-dir", default=None)
    p_set.add_argument("--renode-bin", default=None)

    p_res = sub.add_parser("resolve", help="Resolve effective output_dir")
    p_res.add_argument("--output-dir", default=None)
    p_res.add_argument("--no-persist", action="store_true")

    args = parser.parse_args()
    try:
        if args.command == "status":
            cfg = read_config()
            eff = resolve_output_dir()
            print(json.dumps({
                "config_path": str(get_config_path()),
                "config_exists": get_config_path().exists(),
                "effective_output_dir": str(eff["dir"]),
                "output_source": eff["source"],
                "config": cfg,
            }, indent=2, ensure_ascii=False))
            return 0

        if args.command == "set-output":
            target = Path(args.dir).expanduser().resolve()
            saved = update_config({"output_dir": str(target)})
            print(json.dumps({"config_path": str(get_config_path()), "config": saved}, indent=2, ensure_ascii=False))
            return 0

        if args.command == "set":
            updates = {}
            if args.output_dir is not None:
                updates["output_dir"] = str(Path(args.output_dir).expanduser().resolve()) if args.output_dir else ""
            if args.backend_dir is not None:
                updates["backend_dir"] = str(Path(args.backend_dir).expanduser().resolve()) if args.backend_dir else ""
            if args.renode_bin is not None:
                updates["renode_bin"] = str(Path(args.renode_bin).expanduser().resolve()) if args.renode_bin else ""
            saved = update_config(updates)
            print(json.dumps({"config_path": str(get_config_path()), "config": saved}, indent=2, ensure_ascii=False))
            return 0

        if args.command == "resolve":
            eff = resolve_output_dir(args.output_dir, persist=not args.no_persist)
            print(json.dumps({
                "config_path": str(get_config_path()),
                "output_dir": str(eff["dir"]),
                "source": eff["source"],
                "persisted": eff["persisted"],
            }, indent=2, ensure_ascii=False))
            return 0
    except ConfigError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 3
    return 1


if __name__ == "__main__":
    sys.exit(main())
