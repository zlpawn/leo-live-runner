#!/usr/bin/env python3
"""
Pipeline Runner & Scenario Orchestrator
负责解析场景声明，驱动执行流水线，并管理防遗漏状态机清单 (Checklist)
"""

import os
import sys
import json
import urllib.request
import urllib.parse
from typing import Dict, Any, List, Optional, Set, Tuple

try:
    import yaml
except ImportError:
    yaml = None

from core.excel_loader import detect_active_or_visible_sheet, load_sheet_records, to_beike_ucid
from core.diff_engine import perform_3way_diff


class ScenarioPipeline:
    def __init__(self, scenario_config: Dict[str, Any]):
        self.config = scenario_config
        self.scenario_id = scenario_config.get("id", "unknown")
        self.name = scenario_config.get("name", "未命名场景")
        self.description = scenario_config.get("description", "")
        self.pipeline_steps = scenario_config.get("pipeline", [])

    @classmethod
    def from_file(cls, filepath: str) -> "ScenarioPipeline":
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"场景配置文件不存在: {filepath}")

        with open(filepath, "r", encoding="utf-8") as f:
            if filepath.endswith(".json"):
                data = json.load(f)
            else:
                if yaml is None:
                    raise ImportError("缺少 PyYAML 库，请使用 --with pyyaml 运行")
                data = yaml.safe_load(f)
        return cls(data)

    def fetch_live_apollo_whitelist(self, query_url: str, config_key: str = "service.user.send.password.auth.config") -> Tuple[List[str], Set[str]]:
        """从 Apollo 拉取生产/测试环境当前白名单"""
        try:
            req = urllib.request.Request(query_url, headers={"User-Agent": "leo-config-router/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status != 200:
                    return [], set()
                raw_data = json.loads(resp.read().decode('utf-8'))
                val_str = raw_data.get(config_key) or raw_data.get("configurations", {}).get(config_key, "[]")
                current_list = json.loads(val_str)
                return current_list, set(str(x) for x in current_list)
        except Exception as e:
            print(f"⚠️ [Apollo] 读取线上白名单失败 ({e})，降级为空列表比对", file=sys.stderr)
            return [], set()

    def invoke_backdoor_api(self, endpoint: str, ucids: List[str], need_nation_data: int = 1) -> Tuple[bool, str]:
        """批量调用后端后门权限刷新接口"""
        if not ucids:
            return True, "名单为空，无需调用"

        payload = {
            "ucids": ucids,
            "needNationData": need_nation_data
        }
        data_bytes = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            endpoint,
            data=data_bytes,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                res_body = resp.read().decode('utf-8')
                res_json = json.loads(res_body)
                if res_json.get("errorCode") == 0:
                    return True, res_json.get("data", "刷新完成")
                return False, f"errorCode={res_json.get('errorCode')}, data={res_json.get('data')}"
        except Exception as e:
            return False, str(e)

    def run(
        self,
        excel_path: str,
        explicit_sheet: Optional[str] = None,
        execute_backdoor: bool = False,
        export_dir: str = "~/Downloads"
    ) -> Dict[str, Any]:
        export_dir = os.path.expanduser(export_dir)
        os.makedirs(export_dir, exist_ok=True)

        # 1. 识别 Sheet
        sheet_name = detect_active_or_visible_sheet(excel_path, explicit_sheet)

        # 2. 解析数据行
        input_cfg = self.config.get("input", {})
        fields = input_cfg.get("fields", {})
        sanitizer = input_cfg.get("sanitizer", "beike_ucid_converter")

        parsed_data = load_sheet_records(
            excel_path=excel_path,
            sheet_name=sheet_name,
            field_mapping=fields,
            sanitizer_name=sanitizer
        )
        records = parsed_data["records"]

        # 3. 按业务规则分组
        grouping = self.config.get("grouping", {})
        whitelist_match = grouping.get("whitelist_candidates", {}).get("match_roles", [])
        super_admin_match = grouping.get("super_admins", {}).get("match_roles", [])
        night_shift_match = grouping.get("night_shifts", {}).get("match_roles", [])
        degraded_match = grouping.get("degraded_roles", {}).get("match_roles", [])

        whitelist_candidates = [r for r in records if r["role"] in whitelist_match]
        super_admins = [r for r in records if r["role"] in super_admin_match]
        night_shifts = [r for r in records if r["role"] in night_shift_match]
        degraded_records = [r for r in records if r["role"] in degraded_match]

        # 4. 获取 Apollo 线上数据
        apollo_step = next((s for s in self.pipeline_steps if s.get("type") == "apollo_config"), None)
        query_url = apollo_step.get("query_url") if apollo_step else None
        config_key = apollo_step.get("key", "service.user.send.password.auth.config") if apollo_step else "service.user.send.password.auth.config"
        live_list, live_set = self.fetch_live_apollo_whitelist(query_url, config_key) if query_url else ([], set())

        # 5. 执行 3-Way Diff
        diff_result = perform_3way_diff(
            candidate_records=whitelist_candidates,
            live_keys=live_set,
            degraded_records=degraded_records,
            all_sheet_records=records,
            key_field="ucid"
        )

        # 计算纯增量人员中的超管与通宵班
        added_ucids = set(x["ucid"] for x in diff_result["added"])
        new_super_admins = [x for x in super_admins if x["ucid"] in added_ucids]
        new_night_shifts = [x for x in night_shifts if x["ucid"] in added_ucids]

        # 6. 生成交付文件
        generated_files = []

        # 6.1 Apollo 增量版
        apollo_inc_file = os.path.join(export_dir, f"{sheet_name}_Apollo增量免审批白名单_{diff_result['added_count']}人.json")
        with open(apollo_inc_file, "w", encoding="utf-8") as f:
            json.dump([x["ucid"] for x in diff_result["added"]], f, ensure_ascii=False, indent=2)
        generated_files.append({"type": "apollo_incremental", "path": apollo_inc_file, "count": diff_result["added_count"]})

        # 6.2 Apollo 全量清洗版 (推荐)
        apollo_clean_file = os.path.join(export_dir, f"{sheet_name}_Apollo全量清洗免审批白名单_{diff_result['clean_target_count']}人_推荐.json")
        with open(apollo_clean_file, "w", encoding="utf-8") as f:
            json.dump(diff_result["clean_target_keys"], f, ensure_ascii=False, indent=2)
        generated_files.append({"type": "apollo_clean", "path": apollo_clean_file, "count": diff_result["clean_target_count"]})

        # 6.3 Luke 超管新增工号名单
        luke_super_file = os.path.join(export_dir, f"{sheet_name}_Luke_服务管家门锁超级管理员_新增工号_{len(new_super_admins)}人.txt")
        with open(luke_super_file, "w", encoding="utf-8") as f:
            f.write("\n".join([x["eid"] for x in new_super_admins]))
        generated_files.append({"type": "luke_super", "path": luke_super_file, "count": len(new_super_admins), "eids": [x["eid"] for x in new_super_admins]})

        # 6.4 Luke 一线通宵班新增工号名单
        luke_night_file = os.path.join(export_dir, f"{sheet_name}_Luke_一线服务管家_新增通宵班工号_{len(new_night_shifts)}人.txt")
        with open(luke_night_file, "w", encoding="utf-8") as f:
            f.write("\n".join([x["eid"] for x in new_night_shifts]))
        generated_files.append({"type": "luke_night", "path": luke_night_file, "count": len(new_night_shifts), "eids": [x["eid"] for x in new_night_shifts]})

        # 6.5 安全预警报告 (如有降权人员)
        if diff_result["degraded_count"] > 0:
            degraded_file = os.path.join(export_dir, f"{sheet_name}_⚠️安全预警_转普通一线需从白名单剔除人员_{diff_result['degraded_count']}人.txt")
            with open(degraded_file, "w", encoding="utf-8") as f:
                for x in diff_result["degraded"]:
                    f.write(f"工号: {x['eid']}\tUCID: {x['ucid']}\t姓名: {x['name']}\t当前岗位: {x['role']}\t服务组: {x['group']}\n")
            generated_files.append({"type": "security_warning", "path": degraded_file, "count": diff_result["degraded_count"]})

        # 7. 后门接口调用
        backdoor_step = next((s for s in self.pipeline_steps if s.get("type") == "http_batch_api"), None)
        backdoor_executed = False
        backdoor_msg = "未执行 (需加 --execute-backdoor 参数)"
        all_sheet_ucids = [x["ucid"] for x in records]

        if execute_backdoor and backdoor_step:
            endpoint = backdoor_step.get("endpoint")
            ok, msg = self.invoke_backdoor_api(endpoint, all_sheet_ucids)
            backdoor_executed = ok
            backdoor_msg = "调用成功: " + msg if ok else "调用失败: " + msg

        return {
            "scenario": self.config,
            "sheet_name": sheet_name,
            "total_records": len(records),
            "all_sheet_ucids": all_sheet_ucids,
            "super_admins": super_admins,
            "night_shifts": night_shifts,
            "degraded_records": degraded_records,
            "diff_result": diff_result,
            "new_super_admins": new_super_admins,
            "new_night_shifts": new_night_shifts,
            "generated_files": generated_files,
            "backdoor_executed": backdoor_executed,
            "backdoor_msg": backdoor_msg
        }

    def print_state_checklist(self, result: Dict[str, Any]):
        """打印标准状态机防漏 Checklist"""
        sheet = result["sheet_name"]
        diff = result["diff_result"]
        total = result["total_records"]
        added = diff["added_count"]
        degraded = diff["degraded_count"]
        clean = diff["clean_target_count"]
        live = diff["live_total"]

        print(f"\n=======================================================")
        print(f"🚀 【leo-config-router】标准执行状态机 ({self.name})")
        print(f"=======================================================")
        print(f"• 当前解析工作表: {sheet} (有效记录: {total} 人)")
        print(f"• 线上 Apollo 白名单: {live} 人 | 本月需白名单: {clean} 人 | 纯增量: {added} 人")
        if degraded > 0:
            print(f"• ⚠️ 严重安全预警: 发现 {degraded} 位降权人员已转普通一线，必须从白名单剔除！")

        print(f"\n📋 流水线环节状态检查清单 (Checklist):")
        
        # Step 1: Input & Diff
        print(f" [✓] 环节 1/4: Excel 数据解析与 3-Way Diff 比对 (已完成)")
        print(f"     └─ 保持不变: {diff['retained_count']} 人 | 纯增量: {added} 人 | 降权越权: {degraded} 人")

        # Step 2: Backdoor API
        if result["backdoor_executed"]:
            print(f" [✓] 环节 2/4: 全国权限后门接口 ({result['backdoor_msg']})")
        else:
            print(f" [!] 环节 2/4: 全国权限后门接口 (待执行: 全量 {total} 人待开通 needNationData=1)")
            print(f"     └─ 执行方式: 加上 `--execute-backdoor` 参数直接执行")

        # Step 3: Apollo Whitelist
        if diff["is_perfect_match"]:
            print(f" [✓] 环节 3/4: Apollo 免审批白名单 (已 100% 匹配线上配置)")
        else:
            print(f" [!] 环节 3/4: Apollo 免审批白名单 (待确认下发: 建议采用全量清洗版 {clean} 人)")
            print(f"     └─ 清洗文件: {next((f['path'] for f in result['generated_files'] if f['type'] == 'apollo_clean'), '无')}")

        # Step 4: Luke Role Export
        super_cnt = len(result["new_super_admins"])
        night_cnt = len(result["new_night_shifts"])
        print(f" [!] 环节 4/4: Luke 角色工号名单导出与人工录入 (严禁自动化写入)")
        print(f"     ├─ 超管待配 ({super_cnt} 人): {next((f['path'] for f in result['generated_files'] if f['type'] == 'luke_super'), '无')}")
        print(f"     └─ 一线待配 ({night_cnt} 人): {next((f['path'] for f in result['generated_files'] if f['type'] == 'luke_night'), '无')}")

        print(f"\n=======================================================")
