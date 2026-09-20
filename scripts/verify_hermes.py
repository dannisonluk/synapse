#!/usr/bin/env python
"""
scripts/verify_hermes.py
Hermes 後端回歸驗證（由 scripts/verify.mjs 以 apps/server/venv 的 python 執行）。

守住的是兩個真實 bug：
  1. _describe_canvas 讀 n["data"]["type"]，但前端傳 flat {id,label,type,config}
     → LLM 看到的 canvas context 永遠是空 / 全部 "Table"。
  2. _validate_ast_patch 只認 patch 內部 id → LLM 依 rule 4 連去畫布上
     現有節點的邊會在後端就被剝走。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "server"))

import hermes  # noqa: E402

FAILS = []


def check(name, actual, expected):
    if actual == expected:
        print(f"PASS  {name}")
    else:
        FAILS.append(name)
        print(f"FAIL  {name}\n      got      {actual!r}\n      expected {expected!r}")


# ---------------------------------------------------------------------------
# _describe_canvas
# ---------------------------------------------------------------------------
FRONTEND_DAG = {
    "nodes": [
        {"id": "node_ab12cd", "label": "Input Data", "type": "INPUT_DUCKDB",
         "config": {"tableName": "src_node_ab12cd", "fileName": "sales.csv"}},
        {"id": "node_ef34gh", "label": "Filter", "type": "FILTER",
         "config": {"field": "amount", "op": ">", "val": "1000"}},
    ],
    "edges": [{"source": "node_ab12cd", "target": "node_ef34gh", "targetHandle": "left"}],
}

ctx = hermes._describe_canvas(FRONTEND_DAG)
check("context sees INPUT_DUCKDB type (not 'Table')", "type=INPUT_DUCKDB" in ctx, True)
check("context sees FILTER type", "type=FILTER" in ctx, True)
check("context carries node ids (rule 4 reuse)", "id=node_ab12cd" in ctx, True)
check("context carries column hints", "field=amount" in ctx, True)
check("empty canvas mentions raw_data", "raw_data" in hermes._describe_canvas(None), True)

legacy = {"nodes": [{"id": "node-x", "data": {"type": "SUMMARIZE",
                                              "config": {"groupBy": "year"}}}]}
check("legacy nested {data:{type}} shape still read",
      "type=SUMMARIZE" in hermes._describe_canvas(legacy), True)

# ---------------------------------------------------------------------------
# _validate_ast_patch
# ---------------------------------------------------------------------------
patch = hermes._validate_ast_patch({
    "nodes": [
        {"id": "n0", "type": "INPUT_DUCKDB", "label": "In", "config": {}},
        {"id": "n1", "type": "FILTER", "label": "F", "config": {}},
        {"id": "n2", "type": "BOGUS", "label": "bad", "config": {}},
        {"id": "n3", "type": "SUMMARIZE", "label": "S", "config": {}},
    ],
    "edges": [
        {"source": "n0", "target": "n1"},
        {"source": "n1", "target": "n3"},
        {"source": "n1", "target": "n2"},   # invalid target
        {"source": "n0", "target": "n0"},   # self loop
        {"source": "n9", "target": "n3"},   # unknown source
    ],
})
check("invalid node type filtered", [x["id"] for x in patch["nodes"]], ["n0", "n1", "n3"])
check("only valid edges survive", len(patch["edges"]), 2)
check("self loop dropped", all(e["source"] != e["target"] for e in patch["edges"]), True)
check("sourceIndex preserved", [x["sourceIndex"] for x in patch["nodes"]], [0, 1, 3])
check("targetHandle defaults to left", patch["edges"][0]["targetHandle"], "left")

check("empty nodes -> None", hermes._validate_ast_patch({"nodes": []}), None)
check("non-list nodes -> None", hermes._validate_ast_patch({"nodes": "x"}), None)
check("all-invalid -> None",
      hermes._validate_ast_patch({"nodes": [{"id": "n0", "type": "HACK"}]}), None)

# external canvas ids must be accepted as edge endpoints (rule 4)
canvas = {"nodes": [{"id": "node_existing", "type": "FILTER", "config": {}}]}
ext = hermes._canvas_node_ids(canvas)
check("canvas node ids extracted", ext, {"node_existing"})
bridged = hermes._validate_ast_patch(
    {"nodes": [{"id": "n0", "type": "FILTER", "config": {}}],
     "edges": [{"source": "node_existing", "target": "n0"}]},
    ext,
)
check("edge from existing canvas node preserved", len(bridged["edges"]), 1)
check("edge to bogus id still dropped", len(hermes._validate_ast_patch(
    {"nodes": [{"id": "n0", "type": "FILTER", "config": {}}],
     "edges": [{"source": "n0", "target": "nope"}]}, ext)["edges"]), 0)

# ---------------------------------------------------------------------------
# extract_json_payload / fallback
# ---------------------------------------------------------------------------
check("fenced json unwrapped",
      json.loads(hermes.extract_json_payload('```json\n{"a": 1}\n```'))["a"], 1)

fb = hermes._fallback_ast_patch("載入銷量數據，過濾 amount 大於 1000，再按 year 加總，最後出圖")
check("fallback builds full chain",
      [x["type"] for x in fb["nodes"]],
      ["INPUT_DUCKDB", "FILTER", "SUMMARIZE", "VIZ_CHART"])
check("fallback edges chain", len(fb["edges"]), 3)

# --- fallback 關鍵字遮蔽 -----------------------------------------------------
# 「unpivot」包含「pivot」，所以子字串比對會讓 CROSS_TAB 與 TRANSPOSE 同時命中，
# 產生 INPUT → CROSS_TAB → TRANSPOSE —— 使用者要的是轉置，卻先被樞紐了一次。
# 這類 bug 不會報錯，只會給出錯的中間結果，所以必須逐條釘住。
#
# 案例清單放在 scripts/fallback_cases.py，由這裡與 fallback_pipelines.py
# 共用 —— 後者會把同一批 patch 交給真實 DuckDB 執行。
from fallback_cases import CASES as FALLBACK_CASES  # noqa: E402

for prompt, want in FALLBACK_CASES:
    got = [x["type"] for x in hermes._fallback_ast_patch(prompt)["nodes"]]
    check(f"fallback {prompt!r}", got, want)

check("fallback picks exactly one node for unpivot (not pivot+transpose)",
      "CROSS_TAB" in [x["type"] for x in hermes._fallback_ast_patch("unpivot amount")["nodes"]],
      False)
check("every fallback node type is in the catalogue",
      sorted({s["type"] for s in hermes._FALLBACK_STEPS} - set(hermes.VALID_NODE_TYPES)), [])

# --- fallback 的 config，不只是節點型別 ---------------------------------------
# 上面那批只證明「挑對了節點型別」。節點型別對、config 錯的 pipeline 一樣跑得動，
# 只是算出來的東西不對 —— 所以最關鍵的那幾個 config 值要單獨釘住。
# _fallback_ast_patch 一定會在最前面補一個 INPUT_DUCKDB，這裡只看工具節點。
def _tools(prompt):
    return [n for n in hermes._fallback_ast_patch(prompt)["nodes"]
            if n["type"] != "INPUT_DUCKDB"]


check("the MULTI_FIELD_FORMULA fallback carries a _CurrentField_ expression",
      [("_CurrentField_" in str(n["config"].get("expression", "")))
       for n in _tools("multi-field formula on all fields")], [True])

# 「用樣式拆欄」必須只產生**一個**節點，而且它的 config 必須真的切到 REGEX。
# 少了 splitMode=REGEX 的話 pipeline 照樣跑得動，只是按字面逗號拆 —— 沒有錯誤訊息。
_split = _tools("split by regex")
check("the regex-split fallback actually sets splitMode=REGEX",
      [n["config"].get("splitMode") for n in _split], ["REGEX"])
check("regex splitting produces exactly one node (it shadows both 'split' and 'regex')",
      len(_split), 1)
check("the plain split fallback stays on SEPARATOR mode",
      [n["config"].get("splitMode") for n in _tools("split item by comma")], [None])

# ---------------------------------------------------------------------------
print(f"\n{len(FAILS)} failed" if FAILS else "\nALL PASS")
sys.exit(1 if FAILS else 0)
