#!/usr/bin/env python
# scripts/probe_engines.py
# 手動診斷工具 —— **不屬於 `pnpm verify`**。
#
# 用途：新增節點類型或修改 Polars 匯出時，先在這裡把 DuckDB 與 Polars 的
# 行為並排印出來，確認兩邊語意是否一致，再動手寫 emitter。
#
# 為什麼要有這支：本專案已經踩過 6 個跨引擎差異，全部是「兩邊看起來都對、
# 但算出來的數字不同」的類型 —— 這種 bug 靠讀文件找不到，只能實測。
# 已發現並記錄在 exportPolars.ts 與 README 的差異：
#   1. Polars `list.get(i)` 越界會 throw；DuckDB `string_split(s,',')[i]` 回 NULL
#      → 匯出要用 `list.get(i, null_on_oob=True)`
#   2. Polars `cum_sum()` 會傳播 NULL；DuckDB `SUM(…) OVER (ROWS …)` 忽略 NULL
#      → 匯出要先 `.fill_null(0)`（殘留差異：整幀全 NULL 時 DuckDB 回 NULL、Polars 回 0）
#   3. `pivot` 的 NULL pivot 值：Polars 產生字面 `"null"` 欄、DuckDB 丟棄該列
#   4. `pivot` 缺失組合：Polars 補 0、DuckDB 補 NULL
#   5. `rank()` 對 NULL 輸入：Polars 回 null、DuckDB 照排名
#   6. `rename`：兩邊都保留欄位順序（一致）
#
# 用法（需要 duckdb 與 polars；可用 requirements-dev.txt 安裝）：
#   apps/server/venv/Scripts/python.exe scripts/probe_engines.py
#   或任何裝了 duckdb + polars 的直譯器。
#
# 注意：polars-runtime 啟動時的 CPU feature probe 在部分機器上會失敗
# （`RuntimeError: unknown feature flag: 'sse3'`），所以下面先設好環境變數。

import os

os.environ.setdefault("POLARS_SKIP_CPU_CHECK", "1")

import duckdb  # noqa: E402
import polars as pl  # noqa: E402

RULE = "=" * 72


def show(label, fn):
    """印出一個探測結果；例外也印出來（例外本身就是答案）。"""
    try:
        print(f"  {label:<34} {fn()}")
    except Exception as exc:  # noqa: BLE001 — 例外是預期結果之一
        print(f"  {label:<34} !! {type(exc).__name__}: {str(exc)[:110]}")


def section(title):
    print()
    print(RULE)
    print(title)
    print(RULE)


# --------------------------------------------------------------------------
# 共用資料
# --------------------------------------------------------------------------
con = duckdb.connect()
con.execute(
    "CREATE TABLE c AS SELECT * FROM (VALUES (1,100),(2,NULL),(3,300),(4,300),(5,400)) AS x(seq,amount)"
)
cdf = pl.DataFrame({"seq": [1, 2, 3, 4, 5], "amount": [100, None, 300, 300, 400]})

# --------------------------------------------------------------------------
# 1. list.get / string_split 越界
# --------------------------------------------------------------------------
section("1. 索引越界：Polars list.get vs DuckDB string_split[i]")
con.execute("CREATE TABLE s AS SELECT * FROM (VALUES ('a,b')) AS x(v)")
show("duckdb (string_split(v,','))[3]",
     lambda: con.execute("SELECT (string_split(v, ','))[3] FROM s").fetchall())
show("duckdb (string_split(v,','))[1]",
     lambda: con.execute("SELECT (string_split(v, ','))[1] FROM s").fetchall())
sdf = pl.DataFrame({"v": ["a,b"]})
show("polars list.get(2)  # 會 throw",
     lambda: sdf.with_columns(pl.col("v").str.split(",").list.get(2))["v"].to_list())
show("polars list.get(2, null_on_oob=True)",
     lambda: sdf.with_columns(pl.col("v").str.split(",").list.get(2, null_on_oob=True))["v"].to_list())

# --------------------------------------------------------------------------
# 2. 累計加總對 NULL 的處理
# --------------------------------------------------------------------------
section("2. 累計加總：NULL 是否被傳播")
show("duckdb SUM(…) OVER (ROWS …)",
     lambda: con.execute(
         "SELECT SUM(amount) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) "
         "FROM c ORDER BY seq"
     ).fetchall())
show("polars cum_sum()",
     lambda: cdf.with_columns(pl.col("amount").cum_sum().over(order_by="seq"))["amount"].to_list())
show("polars fill_null(0).cum_sum()",
     lambda: cdf.with_columns(pl.col("amount").fill_null(0).cum_sum().over(order_by="seq"))["amount"].to_list())

# --------------------------------------------------------------------------
# 3. 整幀全 NULL 的殘留差異
# --------------------------------------------------------------------------
section("3. 整幀全 NULL（已知殘留差異：NULL vs 0）")
con.execute("CREATE TABLE n AS SELECT * FROM (VALUES (1,NULL),(2,NULL)) AS x(seq,amount)")
show("duckdb all-NULL frame",
     lambda: con.execute(
         "SELECT SUM(amount) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) "
         "FROM n ORDER BY seq"
     ).fetchall())
ndf = pl.DataFrame({"seq": [1, 2], "amount": [None, None]}, schema={"seq": pl.Int64, "amount": pl.Int64})
show("polars fill_null(0).cum_sum()",
     lambda: ndf.with_columns(pl.col("amount").fill_null(0).cum_sum().over(order_by="seq"))["amount"].to_list())

# --------------------------------------------------------------------------
# 4. 排名對 NULL 的處理
# --------------------------------------------------------------------------
section("4. RANK 對 NULL 輸入")
show("duckdb RANK() OVER (ORDER BY amount DESC)",
     lambda: con.execute("SELECT seq, RANK() OVER (ORDER BY amount DESC) FROM c ORDER BY seq").fetchall())
show("polars rank(method='min', descending=True)",
     lambda: cdf.with_columns(pl.col("amount").rank(method="min", descending=True))["amount"].to_list())
show("polars rank(method='dense', descending=True)",
     lambda: cdf.with_columns(pl.col("amount").rank(method="dense", descending=True))["amount"].to_list())
show("polars rank(method='ordinal', descending=True)",
     lambda: cdf.with_columns(pl.col("amount").rank(method="ordinal", descending=True))["amount"].to_list())

# --------------------------------------------------------------------------
# 5. PIVOT：NULL pivot 值與缺失組合
# --------------------------------------------------------------------------
section("5. PIVOT：NULL pivot 值 / 缺失組合")
con.execute(
    "CREATE TABLE p AS SELECT * FROM (VALUES ('HK','a',100),('HK','b',200),('TW','a',300),('TW',NULL,400)) "
    "AS x(country,category,amount)"
)
pdf = pl.DataFrame(
    {"country": ["HK", "HK", "TW", "TW"], "category": ["a", "b", "a", None], "amount": [100, 200, 300, 400]}
)
show("duckdb PIVOT … ON category",
     lambda: con.execute("PIVOT p ON category USING SUM(amount) GROUP BY country").fetchall())
show("polars pivot(on='category', index=['country'])",
     lambda: pdf.pivot(on="category", index=["country"], values="amount", aggregate_function="sum").to_dicts())
show("duckdb PIVOT（無 GROUP BY）",
     lambda: con.execute("PIVOT p ON category USING SUM(amount)").fetchall())
show("polars pivot（index=[]）",
     lambda: pdf.pivot(on="category", values="amount", aggregate_function="sum").to_dicts())

# --------------------------------------------------------------------------
# 6. 其他 emitter 會用到的建構
# --------------------------------------------------------------------------
section("6. 其他建構")
df = pl.DataFrame(
    {
        "country": ["HK", "HK", "TW", "TW", "TW"],
        "category": ["a", "b", "a", "a", None],
        "amount": [100, None, 300, 300, 400],
        "name": ["  a   b  ", "x", "", None, "z"],
        "seq": [1, 2, 3, 4, 5],
    }
)
show("unique(subset, keep='first').height", lambda: df.unique(subset=["country"], keep="first").height)
show("unique().height", lambda: df.unique().height)
show("fill_null(mean())", lambda: df.with_columns(pl.col("amount").fill_null(pl.col("amount").mean()))["amount"].to_list())
show("replace('', None)", lambda: df.with_columns(pl.col("name").replace("", None))["name"].to_list())
show("str.replace_all(r'\\s+',' ').str.strip_chars()",
     lambda: df.with_columns(pl.col("name").str.replace_all(r"\s+", " ").str.strip_chars())["name"].to_list())
show("unpivot(on=[amount, seq])",
     lambda: df.select(["country", "amount", "seq"])
     .unpivot(on=["amount", "seq"], variable_name="metric", value_name="value")
     .height)
show("shift(1).over(country, order_by=seq)",
     lambda: df.with_columns(pl.col("amount").shift(1).over("country", order_by="seq"))["amount"].to_list())
show("shift(-1)", lambda: df.with_columns(pl.col("amount").shift(-1))["amount"].to_list())
show("coalesce([amount, lit(None)])",
     lambda: df.with_columns(pl.coalesce([pl.col("amount"), pl.lit(None)]).alias("c"))["c"].to_list())
show("sort(descending=True)", lambda: df.sort("amount", descending=True)["amount"].to_list())
show("rename() 是否保留順序", lambda: df.rename({"amount": "amt"}).columns)
show("cross join height",
     lambda: df.select(["country"]).unique().join(df.select(["category"]).unique(), how="cross").height)

print()
print(RULE)
print("完成。若上面出現與 exportPolars.ts 註解不符的結果，代表該註解需要更新。")
print(RULE)
