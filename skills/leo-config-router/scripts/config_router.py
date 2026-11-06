#!/usr/bin/env python3
"""
leo-config-router CLI Entrypoint
企业级全量配置、白名单与权限编排路由引擎
"""

import os
import sys
import argparse
from typing import Dict, Any, List

# 将根目录加到 sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

from core.pipeline import ScenarioPipeline


def list_available_scenarios() -> List[Dict[str, Any]]:
    scenarios_dir = os.path.join(ROOT_DIR, "scenarios")
    if not os.path.exists(scenarios_dir):
        return []
    
    results = []
    for f in os.listdir(scenarios_dir):
        if f.endswith(".yaml") or f.endswith(".json"):
            path = os.path.join(scenarios_dir, f)
            try:
                pipe = ScenarioPipeline.from_file(path)
                results.append({
                    "id": pipe.scenario_id,
                    "name": pipe.name,
                    "description": pipe.description,
                    "triggers": pipe.config.get("triggers", []),
                    "path": path
                })
            except Exception as e:
                pass
    return results


def resolve_scenario(scenario_id: str = None) -> ScenarioPipeline:
    scenarios = list_available_scenarios()
    if not scenarios:
        raise ValueError("系统中未发现任何已注册的场景配置文件 (scenarios/*.yaml)")

    if scenario_id:
        match = next((s for s in scenarios if s["id"] == scenario_id), None)
        if not match:
            raise ValueError(f"未找到场景 '{scenario_id}'，可用场景: {[s['id'] for s in scenarios]}")
        return ScenarioPipeline.from_file(match["path"])

    # 默认返回 sm_lock
    default_match = next((s for s in scenarios if s["id"] == "sm_lock"), scenarios[0])
    return ScenarioPipeline.from_file(default_match["path"])


def main():
    parser = argparse.ArgumentParser(description="leo-config-router: 企业级配置与权限编排路由引擎")
    parser.add_argument("--scenario", "-s", default="sm_lock", help="目标场景标识 (如 sm_lock, 默认: sm_lock)")
    parser.add_argument("--file", "-f", required=False, help="输入的 Excel 表格路径")
    parser.add_argument("--sheet", help="指定工作表名称 (默认自动检测当前可见/激活 Sheet)")
    parser.add_argument("--execute-backdoor", action="store_true", help="是否执行后端后门接口批量刷新")
    parser.add_argument("--list-scenarios", action="store_true", help="列出当前系统所有支持的配置场景")
    parser.add_argument("--export-dir", default="~/Downloads", help="产物导出目录 (默认: ~/Downloads)")

    args = parser.parse_args()

    if args.list_scenarios:
        scenarios = list_available_scenarios()
        print("\n📋 【leo-config-router】已注册的场景目录:")
        for s in scenarios:
            print(f"  • [{s['id']}] {s['name']}: {s['description']}")
            print(f"    触发词: {', '.join(s['triggers'])}")
        print()
        sys.exit(0)

    if not args.file:
        print("❌ 错误: 请通过 --file 参数指定输入的 Excel 文件路径", file=sys.stderr)
        sys.exit(1)

    try:
        pipeline = resolve_scenario(args.scenario)
        result = pipeline.run(
            excel_path=args.file,
            explicit_sheet=args.sheet,
            execute_backdoor=args.execute_backdoor,
            export_dir=args.export_dir
        )
        pipeline.print_state_checklist(result)
    except Exception as e:
        print(f"\n❌ 执行失败: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
