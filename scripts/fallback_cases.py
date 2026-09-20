#!/usr/bin/env python
# scripts/fallback_cases.py
# LLM 離線時走的決定性 fallback：代表性 prompt → 期望的節點序列。
#
# 為什麼要獨立一個檔案：這份清單有兩個消費端，而且它們必須永遠一致 ——
#   * scripts/verify_hermes.py     —— 斷言 fallback 產出的節點序列正確
#   * scripts/fallback_pipelines.py —— 把同一批 patch 交給真實 DuckDB 執行
# 若各寫一份，就會出現「後端斷言說對了、SQL 其實跑不動」這種兩邊都綠燈的假象。
#
# 「unpivot 含 pivot」的遮蔽案例一定要留著：子字串比對會讓 CROSS_TAB 與
# TRANSPOSE 同時命中，產生 INPUT → CROSS_TAB → TRANSPOSE —— 不報錯，
# 只是中間結果是錯的。

CASES = [
    # (prompt, 期望的節點類型序列)
    ("dedupe the rows", ["INPUT_DUCKDB", "UNIQUE"]),
    ("impute missing amount", ["INPUT_DUCKDB", "IMPUTE"]),
    ("clean whitespace", ["INPUT_DUCKDB", "DATA_CLEANSING"]),
    ("split item by comma", ["INPUT_DUCKDB", "TEXT_TO_COLUMNS"]),
    # REGEX 的關鍵字刻意與 TEXT_TO_COLUMNS 分開：單講「split」不該拉進 REGEX，
    # 單講「regex」也不該被當成拆欄。這兩條就是在釘住那條界線。
    ("regex extract digits from item", ["INPUT_DUCKDB", "REGEX"]),
    ("用正規表示式擷取 item 裡的數字", ["INPUT_DUCKDB", "REGEX"]),
    ("pivot category", ["INPUT_DUCKDB", "CROSS_TAB"]),
    ("unpivot amount", ["INPUT_DUCKDB", "TRANSPOSE"]),
    ("rank by amount", ["INPUT_DUCKDB", "RANK"]),
    ("cumulative amount", ["INPUT_DUCKDB", "RUNNING_TOTAL"]),
    ("running total", ["INPUT_DUCKDB", "RUNNING_TOTAL"]),
    ("previous row amount", ["INPUT_DUCKDB", "MULTI_ROW_FORMULA"]),
    # MULTI_ROW_FORMULA 是跨列、MULTI_FIELD_FORMULA 是跨欄 —— 這兩條釘住
    # 「講多欄不要被當成跨列，講上一列也不要被當成多欄」。
    ("multi-field formula on all fields", ["INPUT_DUCKDB", "MULTI_FIELD_FORMULA"]),
    ("把所有欄位都套用 UPPER", ["INPUT_DUCKDB", "MULTI_FIELD_FORMULA"]),
    ("sort by amount", ["INPUT_DUCKDB", "SORT"]),
    ("chart of amount", ["INPUT_DUCKDB", "VIZ_CHART"]),
    ("total amount", ["INPUT_DUCKDB", "SUMMARIZE"]),
    # 多工具串連（含中文關鍵字）
    ("載入銷量，過濾 amount 大於 1000，再按 year 加總，最後出圖",
     ["INPUT_DUCKDB", "FILTER", "SUMMARIZE", "VIZ_CHART"]),
    ("去重、補值，然後按 year 加總",
     ["INPUT_DUCKDB", "UNIQUE", "IMPUTE", "SUMMARIZE"]),
]
