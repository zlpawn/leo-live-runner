#!/usr/bin/env python3
"""
Core 3-Way Diff Engine
通用的全量配置比对与安全降权审计引擎
"""

from typing import List, Dict, Any, Set, Tuple


def perform_3way_diff(
    candidate_records: List[Dict[str, Any]],
    live_keys: Set[str],
    degraded_records: List[Dict[str, Any]] = None,
    all_sheet_records: List[Dict[str, Any]] = None,
    key_field: str = "ucid"
) -> Dict[str, Any]:
    """
    通用 3-Way Diff 算法:
    1. Retained (保持不变): 既在当期候选名单中，又在线上配置中
    2. Added (纯新增): 当期候选名单中有，但线上配置缺失
    3. Degraded (高危降权): 线上已拥有权限，但当期已转入低权限/普通角色
    4. Removed / Ghost (离职/移出): 线上已拥有权限，但在当期全量名单中彻底查无此人
    """
    if degraded_records is None:
        degraded_records = []
    if all_sheet_records is None:
        all_sheet_records = []

    candidate_keys = set(x[key_field] for x in candidate_records)
    candidate_map = {x[key_field]: x for x in candidate_records}

    # 1. 保持不变
    retained_keys = candidate_keys.intersection(live_keys)
    retained_items = [candidate_map[k] for k in sorted(retained_keys)]

    # 2. 纯新增增量
    added_keys = candidate_keys - live_keys
    added_items = [candidate_map[k] for k in sorted(added_keys)]

    # 3. 高危降权人员 (在 live_keys 中，但在当期 degraded_records 中)
    degraded_keys = set(x[key_field] for x in degraded_records)
    degraded_map = {x[key_field]: x for x in degraded_records}
    actual_degraded_keys = live_keys.intersection(degraded_keys)
    actual_degraded_items = [degraded_map[k] for k in sorted(actual_degraded_keys)]

    # 4. 幽灵配置 / 离职移出人员 (在 live_keys 中，但在全量总表中完全不存在)
    all_sheet_keys = set(x[key_field] for x in all_sheet_records)
    ghost_keys = live_keys - all_sheet_keys

    # 5. 全量清洗目标 (应该在线上的全量合法人员)
    clean_target_keys = sorted(list(candidate_keys))

    return {
        "candidate_total": len(candidate_keys),
        "live_total": len(live_keys),
        "retained": retained_items,
        "retained_count": len(retained_items),
        "added": added_items,
        "added_count": len(added_items),
        "degraded": actual_degraded_items,
        "degraded_count": len(actual_degraded_items),
        "ghost_keys": sorted(list(ghost_keys)),
        "ghost_count": len(ghost_keys),
        "clean_target_keys": clean_target_keys,
        "clean_target_count": len(clean_target_keys),
        "is_perfect_match": (len(added_keys) == 0 and len(actual_degraded_keys) == 0 and len(ghost_keys) == 0 and len(candidate_keys) == len(live_keys))
    }
