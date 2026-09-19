#!/usr/bin/env python
# scripts/run_duckdb_sql.py
# 執行一段 SQL（由 stdin 讀入）並以 JSON 輸出結果。
# 用途：驗證 exporter 產生的 CTE SQL「真的能被 DuckDB 執行」，
# 而不只是字串長得像。
#
# 需要 duckdb 套件；沒有安裝則由呼叫方跳過。
import json
import sys
from decimal import Decimal


def norm(value):
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, (float, Decimal)):
        return float(value)
    return str(value)


def main():
    sql = sys.stdin.read()
    try:
        import duckdb
    except ImportError as exc:  # 呼叫方應該先檢查
        print(json.dumps({"ok": False, "error": f"duckdb not installed: {exc}"}))
        return 2

    con = duckdb.connect()
    try:
        cursor = con.execute(sql)
        rows = cursor.fetchall()
        columns = [d[0] for d in cursor.description] if cursor.description else []
        print(json.dumps({
            "ok": True,
            "columns": columns,
            "rows": [[norm(v) for v in row] for row in rows],
        }))
        return 0
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }))
        return 1
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
