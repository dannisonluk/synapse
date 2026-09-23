"""
apps/server/sql_import.py

SQL → Synapse AST patch。

## 範圍刻意收窄

任意 SQL 轉成一張圖是不可能的（每個方言、每個函式都可能沒有對應節點）。
所以這裡只做兩件事：

1. **認得我們自己匯出的形狀** —— 也就是 `exportToSqlCte` 產生的
   `WITH a AS (...), b AS (...) SELECT * FROM b`。那讓「匯出 → 拿去改 → 匯回來」
   成為一條閉環，而那是這個功能最主要的用途。
2. **認得簡單的單一 SELECT** —— `SELECT ... FROM t WHERE ... GROUP BY ...`。

其他一律**誠實回報**「這個 CTE 認不出來」，而不是猜一個節點型別。
猜錯的結果是一張看起來對、跑起來錯的圖，那比明講「這裡我做不到」糟得多。

## 為什麼不用 LLM

同一個理由：LLM 會給出看起來合理但不存在的節點。sqlglot 給的是**語法樹**，
所以「這是不是一個 GROUP BY」是確定的問題，不是判斷題。

## 用法

    python sql_import.py < file.sql          # 印出 patch JSON
    python sql_import.py --self-test         # 內建斷言，印 PASS/FAIL
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

try:
    import sqlglot
    from sqlglot import exp
except ModuleNotFoundError:  # pragma: no cover - 環境問題，不是邏輯問題
    print(
        "缺少 sqlglot。安裝：python -m pip install sqlglot",
        file=sys.stderr,
    )
    raise SystemExit(2)


# ---------------------------------------------------------------------------
# 節點型別判斷
# ---------------------------------------------------------------------------

#: 這些聚合函式出現 → 這個 CTE 是 SUMMARIZE
AGGREGATES = {"SUM", "AVG", "COUNT", "MIN", "MAX", "STDDEV", "MEDIAN", "ARRAY_AGG"}

#: 這些是「遠端讀取」函式 → INPUT_DUCKDB。
#:
#: 用 sqlglot 的**類別名**而不是 Anonymous 的函式名：`read_parquet('x')` 在
#: duckdb 方言下會被解析成 `exp.ReadParquet`（一個具名的 Func），
#: 掛在 Table 的 `this` 上。用 Anonymous 找會找不到，於是遠端來源被當成
#: 一張普通的外部表 —— 節點型別就錯了。
REMOTE_READERS = {"ReadParquet", "ReadCSV", "ReadJSON"}


def _table_name(node: exp.Expression) -> Optional[str]:
    """把一個 table 表達式轉成名字（`read_parquet('x')` → `read_parquet`）"""
    if isinstance(node, exp.Table):
        # 函式型的表：名字在 this 上（ReadParquet 之類）
        if isinstance(node.this, exp.Func):
            return node.this.sql_name()
        return node.name
    if isinstance(node, exp.Anonymous):
        return node.name
    if isinstance(node, exp.Func):
        return node.sql_name()
    return None


def _sources(select: exp.Select) -> List[str]:
    """這個 SELECT 讀了哪些表（去掉 sqlglot 自己加的 __unnest 之類）"""
    out: List[str] = []
    for t in select.find_all(exp.Table):
        name = _table_name(t)
        if name and name not in out:
            out.append(name)
    return out


def _has_aggregate(select: exp.Select) -> bool:
    for fn in select.find_all(exp.Func):
        name = getattr(fn, "sql_name", lambda: "")()
        if name.upper() in AGGREGATES:
            return True
        if isinstance(fn, exp.Anonymous) and fn.name.upper() in AGGREGATES:
            return True
    return False


def _remote_url(select: exp.Select) -> Optional[str]:
    """
    `read_parquet('https://…')` → 那個 URL；沒有就回 None。

    參數的位置**兩種都要看**：sqlglot 對不同的函式會把第一個參數放在
    `.this` 或 `.expressions[0]`，而 `ReadParquet` 是後者（實測 `this` 是 None）。
    只認一種的結果是遠端來源被當成普通外部表，節點型別就錯了。
    """
    for fn in select.find_all(exp.Func):
        if type(fn).__name__ not in REMOTE_READERS:
            continue
        candidates = [getattr(fn, "this", None)] + list(getattr(fn, "expressions", []) or [])
        for arg in candidates:
            if isinstance(arg, exp.Literal) and arg.is_string:
                url = str(arg.this)
                if url.startswith("http://") or url.startswith("https://"):
                    return url
    return None


def _computed_columns(select: exp.Select) -> List[Tuple[str, str]]:
    """投影裡「不是單純欄位」的欄位 → [(輸出欄名, SQL 運算式)]"""
    out: List[Tuple[str, str]] = []
    for proj in select.expressions:
        if isinstance(proj, exp.Star):
            continue
        alias = proj.alias
        inner = proj.this if isinstance(proj, exp.Alias) else proj
        # 單純的欄位引用不是「計算」
        if isinstance(inner, exp.Column) and not alias:
            continue
        if isinstance(inner, exp.Column):
            continue
        name = alias or (inner.output_name if hasattr(inner, "output_name") else "")
        if name:
            out.append((name, inner.sql(dialect="duckdb")))
    return out


def classify(select: exp.Select, known_ctes: List[str]) -> Tuple[str, Dict[str, Any]]:
    """
    把一個 SELECT 分類成節點型別 + config。

    回傳 `("UNKNOWN", {})` 表示認不出來 —— 呼叫端要把它列進 unhandled，
    而不是硬塞一個型別。**這是刻意的**：猜錯會產生一張看起來對、跑起來錯的圖。
    """
    srcs = _sources(select)
    # 去掉 CTE 名字：它們是上游節點，不是外部表
    external = [s for s in srcs if s not in known_ctes]

    # --- 遠端讀取 ---
    url = _remote_url(select)
    if url:
        return "INPUT_DUCKDB", {"sourceUrl": url}

    # --- 沒有上游 → 外部表（INPUT_DUCKDB）---
    if not external and len(srcs) == 0:
        return "UNKNOWN", {}

    # --- 多個來源 → JOIN ---
    if len(srcs) > 1:
        join = next(select.find_all(exp.Join), None)
        if join is not None:
            on = join.args.get("on")
            keys = []
            if on is not None:
                for eq in on.find_all(exp.EQ):
                    left, right = eq.left, eq.right
                    keys.append(
                        (
                            left.name if isinstance(left, exp.Column) else "",
                            right.name if isinstance(right, exp.Column) else "",
                        )
                    )
            if keys:
                left_key, right_key = keys[0]
                if left_key and right_key:
                    return "JOIN", {"leftKey": left_key, "rightKey": right_key}
            return "JOIN", {}

    # --- 聚合 ---
    group = select.args.get("group")
    if group is not None or _has_aggregate(select):
        # 用 `.name` 而不是 `.sql()`：後者會帶引號（`"country"`），
        # 而 config 裡的欄位名不該有引號 —— 引號是編譯器加上的。
        groups = []
        if group is not None:
            groups = [e.name for e in group.expressions if getattr(e, "name", "")]
        target = ""
        func = "SUM"
        for proj in select.expressions:
            inner = proj.this if isinstance(proj, exp.Alias) else proj
            if isinstance(inner, exp.Func):
                name = getattr(inner, "sql_name", lambda: "")().upper()
                if name in AGGREGATES:
                    func = name
                    # 聚合的參數在 `.this`（不是 `.expressions`）：
                    # `SUM(amount)` 是 Sum(this=Column(amount))
                    arg = getattr(inner, "this", None)
                    if isinstance(arg, exp.Column):
                        target = arg.name
                    break
                if isinstance(inner, exp.Anonymous) and inner.name.upper() in AGGREGATES:
                    func = inner.name.upper()
                    if inner.expressions and isinstance(inner.expressions[0], exp.Column):
                        target = inner.expressions[0].name
                    break
        if groups or target:
            return "SUMMARIZE", {"groupBy": groups, "func": func, "target": target}
        return "UNKNOWN", {}

    # --- 去重 ---
    if select.args.get("distinct") is not None:
        return "UNIQUE", {}

    # --- 排序 ---
    order = select.args.get("order")
    if order is not None:
        first = order.expressions[0] if order.expressions else None
        col = first.this.name if first is not None and isinstance(first.this, exp.Column) else ""
        if col:
            return "SORT", {"field": col, "descending": bool(first.args.get("desc"))}
        return "SORT", {}

    # --- 計算欄位 → FORMULA ---
    computed = _computed_columns(select)
    if computed:
        name, expr = computed[0]
        return "FORMULA", {"outputColumn": name, "expression": expr}

    # --- 條件 → FILTER ---
    where = select.args.get("where")
    if where is not None:
        cond = where.this
        if isinstance(cond, exp.EQ) or isinstance(cond, exp.NEQ) or isinstance(cond, exp.GT) or isinstance(cond, exp.GTE) or isinstance(cond, exp.LT) or isinstance(cond, exp.LTE):
            left, right = cond.left, cond.right
            if isinstance(left, exp.Column) and isinstance(right, exp.Literal):
                ops = {
                    exp.EQ: "=", exp.NEQ: "!=", exp.GT: ">",
                    exp.GTE: ">=", exp.LT: "<", exp.LTE: "<=",
                }
                return "FILTER", {
                    "field": left.name,
                    "op": ops.get(type(cond), "="),
                    "val": str(right.this),
                }
        return "UNKNOWN", {}

    # --- 純投影 ---
    cols = [p.output_name for p in select.expressions if not isinstance(p, exp.Star)]
    if cols:
        return "SELECT", {"columns": cols}
    # `SELECT * FROM <單一來源>` = passthrough。這在我們自己的匯出裡是常態
    # （終點那條 `SELECT * FROM "node_s"`），不認得的話每次往返都會少一個節點。
    if len(srcs) == 1:
        return "SELECT", {"columns": []}

    return "UNKNOWN", {}


# ---------------------------------------------------------------------------
# 主轉換
# ---------------------------------------------------------------------------

def convert(sql: str) -> Dict[str, Any]:
    """
    SQL 腳本 → `{patch, notes, unhandled}`。

    patch 的形狀與 `engine/patch.ts` 的 `AstPatch` 一致，所以可以直接餵給
    `resolveAstPatch`，也可以直接顯示在 patch 預覽面板上。
    """
    notes: List[str] = []
    unhandled: List[str] = []
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    try:
        statements = sqlglot.parse(sql, dialect="duckdb")
    except Exception as exc:  # sqlglot 的 ParseError 種類很多，一律接住
        return {
            "patch": {"nodes": [], "edges": []},
            "notes": [f"SQL 解析失敗：{exc}"],
            "unhandled": [],
        }

    # 只處理 SELECT 家族；DDL / DML 一律回報
    selects: List[exp.Select] = []
    for st in statements:
        if st is None:
            continue
        if isinstance(st, exp.Select):
            selects.append(st)
        else:
            unhandled.append(f"{type(st).__name__}（只支援 SELECT 家族）")

    cte_names: List[str] = []
    plan: List[Tuple[str, exp.Select]] = []

    for select in selects:
        # sqlglot 的 arg 鍵是 `with_`（不是 `with` —— 後者會拿到 None，
        # 於是 CTE 全部被當成不存在，轉換結果是空的一張圖）。
        with_clause = select.args.get("with_")
        # 外層查詢要**去掉 WITH** 再判斷：不去掉的話它的來源會包含所有 CTE
        # 與遠端函式（實測會變成 4 個來源），於是每個匯出檔的終點都被判成 JOIN。
        outer = select.copy()
        outer.args.pop("with_", None)

        if with_clause is not None:
            for cte in with_clause.expressions:
                name = cte.alias
                cte_names.append(name)
                inner = cte.this
                if isinstance(inner, exp.Select):
                    plan.append((name, inner))
                else:
                    unhandled.append(f"CTE `{name}`（不是 SELECT）")
        plan.append(("result", outer))

    for label, select in plan:
        node_type, config = classify(select, cte_names)
        if node_type == "UNKNOWN":
            unhandled.append(
                f"`{label}` 認不出對應的節點型別（語法正確，但形狀不在支援範圍內）"
            )
            continue
        nodes.append(
            {
                "id": label,
                "type": node_type,
                "label": label,
                "config": config,
            }
        )

    # 邊：依 FROM 的來源決定上游
    emitted = {n["id"] for n in nodes}
    for label, select in plan:
        if label not in emitted:
            continue
        for src in _sources(select):
            if src in emitted and src != label:
                edges.append({"source": src, "target": label})

    if unhandled:
        notes.append(
            f"有 {len(unhandled)} 處無法轉換 —— 它們**沒有**進入這張圖，請手動處理。"
        )
    if not nodes:
        notes.append("沒有轉換出任何節點。")

    return {
        "patch": {"nodes": nodes, "edges": edges},
        "notes": notes,
        "unhandled": unhandled,
    }


# ---------------------------------------------------------------------------
# 自我測試（scripts/verify_sql_import.py 會呼叫這裡的斷言）
# ---------------------------------------------------------------------------

def _self_test() -> int:
    failures = 0
    checks = 0

    def check(name: str, actual: Any, expected: Any) -> None:
        nonlocal failures, checks
        checks += 1
        if actual == expected:
            print(f"PASS {name}")
        else:
            failures += 1
            print(f"FAIL {name}")
            print(f"     got      {actual!r}")
            print(f"     expected {expected!r}")

    # --- 我們自己匯出的形狀（最重要的往返案例）---
    ours = """
    WITH
    "node_in" AS (SELECT * FROM read_parquet('https://x.dev/a.parquet')),
    "node_f" AS (SELECT * FROM "node_in" WHERE "amount" > 1000),
    "node_s" AS (SELECT "country", SUM("amount") AS "s" FROM "node_f" GROUP BY "country")
    SELECT * FROM "node_s";
    """
    out = convert(ours)
    types = [(n["id"], n["type"]) for n in out["patch"]["nodes"]]
    check("our own export round-trips: node types", types, [
        ("node_in", "INPUT_DUCKDB"),
        ("node_f", "FILTER"),
        ("node_s", "SUMMARIZE"),
        ("result", "SELECT"),
    ])
    check("our own export round-trips: edges", out["patch"]["edges"], [
        {"source": "node_in", "target": "node_f"},
        {"source": "node_f", "target": "node_s"},
        # 匯出檔的終點是 `SELECT * FROM "node_s"` —— 它也會變成一個節點，
        # 所以這條邊是對的（不是多出來的）。
        {"source": "node_s", "target": "result"},
    ])
    check("the remote URL is carried through",
          out["patch"]["nodes"][0]["config"], {"sourceUrl": "https://x.dev/a.parquet"})
    check("the filter condition is carried through",
          out["patch"]["nodes"][1]["config"],
          {"field": "amount", "op": ">", "val": "1000"})
    check("the grouping is carried through",
          out["patch"]["nodes"][2]["config"],
          {"groupBy": ["country"], "func": "SUM", "target": "amount"})
    check("nothing was left unhandled", out["unhandled"], [])

    # --- 簡單的單一 SELECT ---
    check("a bare filter is recognised",
          convert('SELECT * FROM t WHERE a > 1')["patch"]["nodes"][0]["type"], "FILTER")
    check("a distinct is recognised as UNIQUE",
          convert('SELECT DISTINCT * FROM t')["patch"]["nodes"][0]["type"], "UNIQUE")
    check("an order by is recognised as SORT",
          convert('SELECT * FROM t ORDER BY a DESC')["patch"]["nodes"][0]["type"], "SORT")
    check("a computed column is recognised as FORMULA",
          convert('SELECT *, a * 2 AS b FROM t')["patch"]["nodes"][0]["type"], "FORMULA")
    check("a join is recognised",
          convert('SELECT * FROM a JOIN b ON a.id = b.id')["patch"]["nodes"][0]["type"], "JOIN")
    check("...and its keys are extracted",
          convert('SELECT * FROM a JOIN b ON a.id = b.id')["patch"]["nodes"][0]["config"],
          {"leftKey": "id", "rightKey": "id"})

    # --- 誠實回報：認不出來的不可以硬塞一個型別 ---
    unhandled_case = convert('SELECT * FROM t WHERE a > 1 AND b < 2')
    check("a compound WHERE is reported, not guessed",
          unhandled_case["patch"]["nodes"], [])
    check("...and the reason is listed",
          len(unhandled_case["unhandled"]), 1)
    check("...and a note says they did not enter the graph",
          any("沒有" in n for n in unhandled_case["notes"]), True)

    check("a DDL statement is reported",
          convert('CREATE TABLE x AS SELECT 1')["unhandled"],
          ["Create（只支援 SELECT 家族）"])
    check("a syntax error is reported, not thrown",
          convert('SELECT FROM WHERE')["unhandled"], [])
    check("...with a note", len(convert('SELECT FROM WHERE')["notes"]), 1)
    check("empty input produces nothing", convert('')["patch"]["nodes"], [])

    print(f"\n{checks - failures}/{checks} passed")
    return failures


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(1 if _self_test() else 0)
    raw = sys.stdin.read()
    result = convert(raw)
    print(json.dumps(result, ensure_ascii=False, indent=2))
