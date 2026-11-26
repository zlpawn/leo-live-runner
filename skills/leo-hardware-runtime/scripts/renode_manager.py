#!/usr/bin/env python3
"""Cross-platform (macOS, Windows, Linux) Renode CLI lifecycle manager."""

import argparse
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

RELEASES_API = "https://api.github.com/repos/renode/renode/releases"


def managed_base_dir():
    """Return user-local data directory for managed Renode installations."""
    sys_name = platform.system()
    if sys_name == "Windows":
        local_app = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local_app) / "leo-hardware-runtime"
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(xdg) / "leo-hardware-runtime"


def managed_bin_dir():
    """Return user-local bin directory for shims/symlinks."""
    if platform.system() == "Windows":
        return managed_base_dir() / "bin"
    return Path.home() / ".local" / "bin"


def find_renode_binary(explicit_path=None):
    """Locate Renode executable across env, PATH, managed dir, and OS defaults."""
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))
    env_bin = os.environ.get("RENODE_BIN")
    if env_bin:
        candidates.append(Path(env_bin))

    for name in ("renode", "Renode", "Renode.exe", "renode.cmd"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))

    base = managed_base_dir() / "renode"
    sys_name = platform.system()
    if sys_name == "Darwin":
        candidates.extend([
            base / "Renode.app" / "Contents" / "MacOS" / "Renode",
            Path("/Applications/Renode.app/Contents/MacOS/Renode"),
            Path.home() / "Applications" / "Renode.app" / "Contents" / "MacOS" / "Renode",
        ])
    elif sys_name == "Windows":
        prog = os.environ.get("ProgramFiles", r"C:\Program Files")
        candidates.extend([
            base / "bin" / "Renode.exe",
            base / "Renode.exe",
            Path(prog) / "Renode" / "bin" / "Renode.exe",
            Path(prog) / "Renode" / "Renode.exe",
        ])
    else:
        candidates.extend([
            base / "renode",
            Path("/opt/renode/renode"),
        ])

    for cand in candidates:
        if cand.exists() and cand.is_file():
            return cand.resolve()
    return None


def get_renode_version(binary_path):
    """Run `<renode> --version` cleanly without spawning a GUI."""
    try:
        proc = subprocess.run(
            [str(binary_path), "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return (proc.stdout or proc.stderr or "").strip()
    except Exception as exc:
        return f"error: {exc}"


def fetch_releases(limit=5):
    """Query official Renode GitHub releases metadata."""
    req = urllib.request.Request(
        f"{RELEASES_API}?per_page={limit}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "leo-hardware-runtime"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def select_asset_for_platform(release):
    """Pick the best portable release asset for the current OS and CPU arch."""
    sys_name = platform.system()
    machine = platform.machine().lower()
    assets = release.get("assets", [])

    def find_match(predicates):
        for pred in predicates:
            for asset in assets:
                if pred(asset["name"].lower()):
                    return asset
        return None

    if sys_name == "Darwin":
        if "arm" in machine or "aarch64" in machine:
            return find_match([
                lambda n: "osx-arm64-portable.dmg" in n,
                lambda n: "osx" in n and n.endswith(".dmg"),
                lambda n: "multiplatform.zip" in n,
            ])
        return find_match([
            lambda n: "osx" in n and "arm64" not in n and (n.endswith(".dmg") or n.endswith(".tar.gz")),
            lambda n: "multiplatform.zip" in n,
        ])

    if sys_name == "Windows":
        return find_match([
            lambda n: "windows-portable.zip" in n,
            lambda n: "windows" in n and n.endswith(".zip"),
            lambda n: "multiplatform.zip" in n,
        ])

    return find_match([
        lambda n: "linux-portable-dotnet.tar.gz" in n,
        lambda n: "linux-portable.tar.gz" in n,
        lambda n: "multiplatform.zip" in n,
    ])


def cmd_doctor(args):
    """Report Renode CLI and host environment health."""
    binary = find_renode_binary(args.renode_bin)
    info = {
        "os": platform.system(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "renode_found": binary is not None,
        "renode_path": str(binary) if binary else None,
        "renode_version": get_renode_version(binary) if binary else None,
        "managed_install_dir": str(managed_base_dir() / "renode"),
        "managed_bin_dir": str(managed_bin_dir()),
        "optional_packages": {
            pkg: importlib.util.find_spec(pkg) is not None
            for pkg in ("capstone", "elftools")
        },
    }
    print(json.dumps(info, indent=2, ensure_ascii=False))
    return 0 if binary else 1


def cmd_releases(args):
    """List latest Renode releases and matched asset for current platform."""
    releases = fetch_releases(limit=args.limit)
    out = []
    for rel in releases:
        asset = select_asset_for_platform(rel)
        out.append({
            "tag": rel.get("tag_name"),
            "published_at": rel.get("published_at"),
            "matched_asset": asset["name"] if asset else None,
            "download_url": asset["browser_download_url"] if asset else None,
        })
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def _download_file(url, dest_path):
    req = urllib.request.Request(url, headers={"User-Agent": "leo-hardware-runtime"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest_path, "wb") as f:
        shutil.copyfileobj(resp, f)


def _install_macos_dmg(dmg_path, install_dir, bin_dir):
    mount_point = Path(tempfile.mkdtemp(prefix="renode-dmg-"))
    try:
        subprocess.run(
            ["hdiutil", "attach", str(dmg_path), "-mountpoint", str(mount_point), "-nobrowse", "-readonly"],
            check=True,
            capture_output=True,
        )
        apps = list(mount_point.glob("*.app"))
        if not apps:
            raise RuntimeError("No .app bundle found inside mounted Renode DMG")
        src_app = apps[0]
        install_dir.mkdir(parents=True, exist_ok=True)
        dst_app = install_dir / "Renode.app"
        if dst_app.exists():
            shutil.rmtree(dst_app)
        shutil.copytree(src_app, dst_app, symlinks=True)
    finally:
        subprocess.run(["hdiutil", "detach", str(mount_point), "-quiet"], capture_output=True)
        shutil.rmtree(mount_point, ignore_errors=True)

    subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(dst_app)], capture_output=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    link_path = bin_dir / "renode"
    target_bin = dst_app / "Contents" / "MacOS" / "Renode"
    if link_path.exists() or link_path.is_symlink():
        link_path.unlink()
    link_path.symlink_to(target_bin)
    return target_bin


def _install_archive(archive_path, install_dir, bin_dir):
    if install_dir.exists():
        shutil.rmtree(install_dir)
    install_dir.mkdir(parents=True, exist_ok=True)

    name = archive_path.name.lower()
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(install_dir)
    else:
        import tarfile
        with tarfile.open(archive_path, "r:*") as tf:
            tf.extractall(install_dir)

    # Flatten single top-level directory if present
    entries = list(install_dir.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        nested = entries[0]
        for child in list(nested.iterdir()):
            shutil.move(str(child), str(install_dir / child.name))
        nested.rmdir()

    bin_dir.mkdir(parents=True, exist_ok=True)
    if platform.system() == "Windows":
        exe = next(install_dir.rglob("Renode.exe"), None)
        if not exe:
            raise RuntimeError("Renode.exe not found after extraction")
        shim = bin_dir / "renode.cmd"
        shim.write_text(f'@echo off\r\n"{exe}" %*\r\n', encoding="utf-8")
        return exe

    exe = next((p for p in install_dir.rglob("renode") if p.is_file()), None)
    if not exe:
        raise RuntimeError("renode executable not found after extraction")
    exe.chmod(exe.stat().st_mode | 0o111)
    link_path = bin_dir / "renode"
    if link_path.exists() or link_path.is_symlink():
        link_path.unlink()
    link_path.symlink_to(exe)
    return exe


def cmd_install(args):
    """Install or update Renode CLI (dry-run unless --confirm is provided)."""
    releases = fetch_releases(limit=10)
    if args.version == "latest":
        target_rel = releases[0]
    else:
        wanted = args.version.lstrip("v")
        target_rel = next(
            (r for r in releases if r.get("tag_name", "").lstrip("v") == wanted),
            None,
        )
        if target_rel is None:
            raise RuntimeError(f"Release {args.version} not found in recent GitHub releases")

    asset = select_asset_for_platform(target_rel)
    if not asset:
        raise RuntimeError(f"No compatible Renode asset found for {platform.system()} / {platform.machine()}")

    install_dir = Path(args.dir).expanduser().resolve() if args.dir else (managed_base_dir() / "renode")
    bin_dir = Path(args.bin_dir).expanduser().resolve() if args.bin_dir else managed_bin_dir()
    current_bin = find_renode_binary()

    plan = {
        "action": "install_or_update",
        "dry_run": not args.confirm,
        "os": platform.system(),
        "arch": platform.machine(),
        "current_binary": str(current_bin) if current_bin else None,
        "current_version": get_renode_version(current_bin) if current_bin else None,
        "target_tag": target_rel.get("tag_name"),
        "asset_name": asset["name"],
        "download_url": asset["browser_download_url"],
        "install_dir": str(install_dir),
        "bin_dir": str(bin_dir),
    }

    if not args.confirm:
        plan["hint"] = "Re-run with --confirm to download and install."
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return 0

    with tempfile.TemporaryDirectory(prefix="renode-dl-") as tmp:
        dl_path = Path(tmp) / asset["name"]
        _download_file(asset["browser_download_url"], dl_path)
        if dl_path.name.lower().endswith(".dmg"):
            installed_bin = _install_macos_dmg(dl_path, install_dir, bin_dir)
        else:
            installed_bin = _install_archive(dl_path, install_dir, bin_dir)

    plan["dry_run"] = False
    plan["installed_binary"] = str(installed_bin)
    plan["installed_version"] = get_renode_version(installed_bin)
    print(json.dumps(plan, indent=2, ensure_ascii=False))
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="Cross-platform Renode CLI manager")
    sub = parser.add_subparsers(dest="command", required=True)

    p_doc = sub.add_parser("doctor", help="Check Renode installation and dependencies")
    p_doc.add_argument("--renode-bin", default=None, help="Explicit Renode executable path")

    p_rel = sub.add_parser("releases", help="List recent official Renode releases")
    p_rel.add_argument("--limit", type=int, default=5)

    for name in ("install", "update"):
        p_inst = sub.add_parser(name, help=f"{name.capitalize()} Renode CLI")
        p_inst.add_argument("--version", default="latest", help="Target version tag or 'latest'")
        p_inst.add_argument("--dir", default=None, help="Custom installation directory")
        p_inst.add_argument("--bin-dir", default=None, help="Custom bin/shim directory")
        p_inst.add_argument("--confirm", action="store_true", help="Actually download and install")

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "doctor":
        return cmd_doctor(args)
    if args.command == "releases":
        return cmd_releases(args)
    if args.command in ("install", "update"):
        return cmd_install(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
