#!/usr/bin/env python
# scripts/fallback_pipelines.py
# 把 LLM 離線時的決定性 fallback 對每個代表 prompt 產生的 patch，以 JSON 印出來。
#
# 由 scripts/verify.mjs 呼叫（用 apps/server/venv 的 python），把結果交給
# verify_duckdb_wasm.mjs 餵進**真實的 duckdb-wasm 引擎**執行。
#
# 為什麼要做這件事：先前只斷言了「fallback 產出的節點類型對」與
# 「hermes.py 的 VALID_NODE_TYPES 等於目錄」—— 兩者都只證明「知道有哪些工具」。
# 使用者真正在意的是「講一句話，東西跑得動」。fallback 的 config 是手寫的
# 字串（欄位名、聚合函式、分隔符號），從來沒有被任何引擎執行過。
#
# 輸出：{"pipelines": [{"prompt": str, "nodes": [...], "edges": [...]}, ...]}
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "server"))

import hermes  # noqa: E402
from fallback_cases import CASES  # noqa: E402

pipelines = []
for prompt, _expected in CASES:
    fb = hermes._fallback_ast_patch(prompt)
    # 走與真實請求相同的驗證路徑，確保測的是使用者會拿到的那份 patch
    validated = hermes._validate_ast_patch(fb)
    if validated is None:
        validated = {"nodes": [], "edges": []}
    pipelines.append({
        "prompt": prompt,
        "nodes": validated.get("nodes", []),
        "edges": validated.get("edges", []),
    })

# ensure_ascii=False 保留中文可讀性；消費端以 UTF-8 解讀
sys.stdout.write(json.dumps({"pipelines": pipelines}, ensure_ascii=False))
