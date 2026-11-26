#!/usr/bin/env python3
"""Cross-platform firmware probe for .hex, .bin, and .elf embedded images."""

import argparse
import json
import re
import struct
import sys
from pathlib import Path


def load_hex_bytes(path):
    """Parse Intel HEX into contiguous bytearray starting at min address."""
    mem = {}
    ext_addr = 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line.startswith(":") or len(line) < 11:
                continue
            bc = int(line[1:3], 16)
            addr = int(line[3:7], 16)
            rectype = int(line[7:9], 16)
            data = bytes.fromhex(line[9:9 + bc * 2])
            if rectype == 0:
                base = ext_addr + addr
                for i, b in enumerate(data):
                    mem[base + i] = b
            elif rectype == 2:
                ext_addr = int(line[9:13], 16) << 4
            elif rectype == 4:
                ext_addr = int(line[9:13], 16) << 16
    if not mem:
        return 0, b""
    min_a, max_a = min(mem.keys()), max(mem.keys())
    buf = bytearray(b"\xff" * (max_a - min_a + 1))
    for a, b in mem.items():
        buf[a - min_a] = b
    return min_a, bytes(buf)


def load_firmware_image(path, bin_base=0):
    """Load .hex, .bin, or .elf loadable flash bytes."""
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".hex":
        base, raw = load_hex_bytes(p)
        return "hex", base, raw
    raw = p.read_bytes()
    if ext == ".elf" or raw[:4] == b"\x7fELF":
        # Extract PT_LOAD segments (32-bit little-endian ARM ELF)
        if len(raw) >= 52 and raw[4] == 1 and raw[5] == 1:
            e_phoff, = struct.unpack_from("<I", raw, 28)
            e_phentsize, e_phnum = struct.unpack_from("<HH", raw, 42)
            segs = {}
            for i in range(e_phnum):
                off = e_phoff + i * e_phentsize
                p_type, p_offset, p_vaddr, p_paddr, p_filesz = struct.unpack_from("<5I", raw, off)
                if p_type == 1 and p_filesz > 0 and p_paddr < 0x20000000:
                    chunk = raw[p_offset:p_offset + p_filesz]
                    for j, b in enumerate(chunk):
                        segs[p_paddr + j] = b
            if segs:
                min_a, max_a = min(segs), max(segs)
                buf = bytearray(b"\xff" * (max_a - min_a + 1))
                for a, b in segs.items():
                    buf[a - min_a] = b
                return "elf", min_a, bytes(buf)
    return "bin", bin_base, raw


def find_vector_tables(base, raw):
    """Detect plausible ARM Cortex-M vector tables (SP in SRAM, Thumb Reset PC in Flash)."""
    candidates = []
    flash_end = base + len(raw)
    for off in range(0, max(0, len(raw) - 32), 0x100):
        sp, reset_pc = struct.unpack_from("<II", raw, off)
        if not (0x20000800 <= sp <= 0x20100000 and sp % 4 == 0):
            continue
        if not ((reset_pc & 1) == 1 and base <= (reset_pc & ~1) < flash_end):
            continue
        # Verify NMI and HardFault vectors look like Thumb code pointers in Flash
        nmi, hf = struct.unpack_from("<II", raw, off + 8)
        if (nmi & 1) == 1 and (hf & 1) == 1:
            candidates.append({
                "vector_table": hex(base + off),
                "sp": hex(sp),
                "pc": hex(reset_pc),
            })
    return candidates[:8]


def extract_clues(raw):
    """Extract AT commands, domain/endpoint clues, RTT marker, and source files."""
    at_cmds = sorted({m.decode("ascii", "ignore") for m in re.findall(rb"AT\+[A-Z0-9_=\"?,.:-]{2,48}", raw)})
    urcs = sorted({m.decode("ascii", "ignore") for m in re.findall(rb"\+[A-Z]{3,16}:?", raw)})
    c_files = sorted({m.decode("ascii", "ignore") for m in re.findall(rb"[a-zA-Z0-9_/-]+\.c\b", raw)})
    domains = sorted({
        m.decode("ascii", "ignore")
        for m in re.findall(rb"[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+){2,}", raw)
        if not m.endswith(b".c")
    })
    key_logs = sorted({
        m.decode("ascii", "ignore")
        for m in re.findall(rb"[\x20-\x7e]*(?:localkey|imei|Auth|auth|SKT|SEGGER RTT)[\x20-\x7e]*", raw)
    })
    return {
        "has_segger_rtt_string": b"SEGGER RTT" in raw,
        "at_commands": at_cmds[:40],
        "urc_prefixes": urcs[:40],
        "domains_and_hosts": domains[:20],
        "source_files": c_files[:40],
        "auth_and_key_strings": key_logs[:30],
    }


def main():
    parser = argparse.ArgumentParser(description="Probe embedded firmware image for Renode setup")
    parser.add_argument("firmware", help="Path to .hex, .bin, or .elf firmware")
    parser.add_argument("--base-addr", default="0x0", help="Base address for raw .bin files (default 0x0)")
    args = parser.parse_args()

    fw_path = Path(args.firmware).expanduser().resolve()
    if not fw_path.exists():
        print(json.dumps({"error": f"Firmware not found: {fw_path}"}), file=sys.stderr)
        return 1

    kind, base, raw = load_firmware_image(fw_path, int(args.base_addr, 0))
    report = {
        "firmware": str(fw_path),
        "format": kind,
        "base_addr": hex(base),
        "size_bytes": len(raw),
        "vector_tables": find_vector_tables(base, raw),
        "clues": extract_clues(raw),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
