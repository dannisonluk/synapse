from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Any, Optional
from chaos import run_chaos_fix

app = FastAPI(title="Synapse Backend API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class ChaosFixRequest(BaseModel):
    node_id: str
    failed_sql: str
    error_message: str
    full_dag: Optional[Dict[str, Any]] = None

@app.get("/")
def read_root():
    return {"status": "Synapse Hermes & Chaos Service Active", "version": "0.1.0"}

@app.post("/api/v1/chaos/fix")
async def fix_sql(req: ChaosFixRequest):
    try:
        fix_result = await run_chaos_fix(req.node_id, req.failed_sql, req.error_message, req.full_dag)
        return {"status": "SUCCESS", "fix": fix_result}
    except Exception as e:
        print(f"❌ Chaos Execution Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

from hermes import router as hermes_router
app.include_router(hermes_router)


# ---------------------------------------------------------------------------
# SQL → AST patch
# ---------------------------------------------------------------------------
# 放在後端而不是前端：解析要 sqlglot，而那是 Python 套件。
#
# 為什麼不叫 LLM 做：這是一個**語法**問題（「這是不是 GROUP BY」），
# sqlglot 給的是確定的答案；LLM 會給出看起來合理但不存在的節點。
# 同一條理由已經寫在 hermes 的註解裡，這裡再套用一次。
from sql_import import convert as convert_sql


class SqlImportRequest(BaseModel):
    sql: str


@app.post("/api/v1/sql/import")
async def import_sql(req: SqlImportRequest):
    """
    把一段 SQL 轉成 AST patch。

    回傳 `{patch, notes, unhandled}`。**`unhandled` 是重點**：認不出來的
    語句會被列出來，而不是被硬塞一個節點型別 —— 猜錯的結果是一張看起來對、
    跑起來錯的圖。
    """
    try:
        result = convert_sql(req.sql)
        return {"status": "SUCCESS", **result}
    except Exception as e:
        print(f"❌ SQL Import Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))