#!/usr/bin/env python3
"""
Excel Loader & Data Sanitizer
自适应解析各类业务 Excel/表格，智能识别有效 Sheet、表头与数据标准化
"""

import os
import zipfile
import xml.etree.ElementTree as ET
from typing import List, Dict, Any, Tuple, Optional
from python_calamine import CalamineWorkbook


def to_beike_ucid(eid_raw: Any) -> str:
    """标准化员工系统号为 16 位 Beike UCID"""
    if eid_raw is None:
        return ""
    try:
        eid_float = float(eid_raw)
        eid_str = str(int(eid_float)).strip()
    except (ValueError, TypeError):
        eid_str = str(eid_raw).strip()

    if not eid_str:
        return ""
    if len(eid_str) == 16:
        return eid_str
    if eid_str.startswith("10") or eid_str.startswith("21"):
        return f"100000{eid_str}"
    return f"10000000{eid_str}"


def detect_active_or_visible_sheet(excel_path: str, explicit_sheet: Optional[str] = None) -> str:
    """通过读取 xl/workbook.xml 智能检测当前激活或唯一可见的工作表"""
    if explicit_sheet:
        return explicit_sheet

    if not os.path.exists(excel_path):
        raise FileNotFoundError(f"文件不存在: {excel_path}")

    try:
        with zipfile.ZipFile(excel_path, 'r') as z:
            if 'xl/workbook.xml' in z.namelist():
                xml_data = z.read('xl/workbook.xml')
                root = ET.fromstring(xml_data)

                # 查找命名空间
                ns = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                
                # 1. 查找 workbookViews 的 activeTab
                active_idx = 0
                views = root.findall('.//main:sheetView', ns) or root.findall('.//main:workbookView', ns)
                for v in views:
                    if 'activeTab' in v.attrib:
                        try:
                            active_idx = int(v.attrib['activeTab'])
                            break
                        except ValueError:
                            pass

                # 2. 遍历 sheets 列表，收集非 hidden 的工作表
                sheets_elems = root.findall('.//main:sheets/main:sheet', ns)
                if not sheets_elems:
                    sheets_elems = [e for e in root.iter() if e.tag.endswith('sheet')]

                sheet_info = []
                for idx, s in enumerate(sheets_elems):
                    name = s.attrib.get('name', f"Sheet{idx+1}")
                    state = s.attrib.get('state', 'visible')
                    sheet_info.append({'index': idx, 'name': name, 'state': state})

                visible_sheets = [s for s in sheet_info if s['state'] != 'hidden']
                
                # 如果 activeTab 对应的 sheet 是可见的，直接返回
                if 0 <= active_idx < len(sheet_info):
                    active_sheet = sheet_info[active_idx]
                    if active_sheet['state'] != 'hidden':
                        return active_sheet['name']

                # 如果有可见的 sheets，返回第一个可见的
                if visible_sheets:
                    return visible_sheets[0]['name']
    except Exception:
        pass

    # Fallback to Calamine sheet names
    wb = CalamineWorkbook.from_path(excel_path)
    if not wb.sheet_names:
        raise ValueError(f"Excel 中未找到任何工作表: {excel_path}")
    return wb.sheet_names[0]


def load_sheet_records(
    excel_path: str,
    sheet_name: str,
    field_mapping: Dict[str, Any],
    sanitizer_name: str = "beike_ucid_converter"
) -> Dict[str, Any]:
    """
    自适应表头并加载数据行
    field_mapping: {
        "key_col": ["员工系统号", "工号", "ucid", "eid"],
        "name_col": ["姓名", "员工姓名", "name"],
        "role_col": ["权限", "角色", "岗位权限", "role"],
        "group_col": ["七级组织", "城市", "服务组", "组织", "group"]
    }
    """
    wb = CalamineWorkbook.from_path(excel_path)
    sheet = wb.get_sheet_by_name(sheet_name)
    rows = sheet.to_python()
    if len(rows) < 2:
        raise ValueError(f"工作表 '{sheet_name}' 数据行数不足")

    # 1. 动态识别表头行 (前 5 行探测)
    header_idx = -1
    col_indices: Dict[str, int] = {}
    key_candidates = field_mapping.get("key_col", ["员工系统号", "工号", "ucid"])

    for i, r in enumerate(rows[:6]):
        row_str = " ".join([str(c) for c in r if c is not None])
        for cand in key_candidates:
            if cand in row_str:
                header_idx = i
                break
        if header_idx != -1:
            break

    if header_idx == -1:
        header_idx = 0  # 默认第 0 行

    headers = [str(c).strip() if c is not None else "" for c in rows[header_idx]]

    # 2. 匹配具体字段索引
    for field_key, candidates in field_mapping.items():
        if isinstance(candidates, str):
            candidates = [candidates]
        col_indices[field_key] = -1
        for idx, h in enumerate(headers):
            for cand in candidates:
                if cand in h:
                    col_indices[field_key] = idx
                    break
            if col_indices[field_key] != -1:
                break

    if col_indices.get("key_col", -1) == -1:
        raise ValueError(f"未能自动识别主键列 {key_candidates}，表头: {headers}")

    # 3. 提取有效数据行
    records = []
    key_idx = col_indices["key_col"]
    name_idx = col_indices.get("name_col", -1)
    role_idx = col_indices.get("role_col", -1)
    group_idx = col_indices.get("group_col", -1)

    for r in rows[header_idx + 1:]:
        if len(r) <= key_idx or r[key_idx] is None or str(r[key_idx]).strip() == "":
            continue

        raw_key = r[key_idx]
        try:
            key_float = float(raw_key)
            eid = str(int(key_float))
        except (ValueError, TypeError):
            eid = str(raw_key).strip()

        if not eid:
            continue

        if sanitizer_name == "beike_ucid_converter":
            ucid = to_beike_ucid(eid)
        else:
            ucid = eid

        name = str(r[name_idx]).strip() if name_idx != -1 and len(r) > name_idx and r[name_idx] is not None else ""
        role = str(r[role_idx]).strip() if role_idx != -1 and len(r) > role_idx and r[role_idx] is not None else ""
        group = str(r[group_idx]).strip() if group_idx != -1 and len(r) > group_idx and r[group_idx] is not None else ""

        records.append({
            "eid": eid,
            "ucid": ucid,
            "name": name,
            "role": role,
            "group": group,
            "raw_row": r
        })

    return {
        "sheet_name": sheet_name,
        "total_rows": len(records),
        "headers": headers,
        "records": records
    }
