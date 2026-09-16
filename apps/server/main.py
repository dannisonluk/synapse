from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Any, Optional
from daedalus import run_daedalus_agent
from chaos import run_chaos_fix

app = FastAPI(title="Synapse Backend API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class PromptRequest(BaseModel):
    prompt: str
    current_dag: Optional[Dict[str, Any]] = None

class ChaosFixRequest(BaseModel):
    node_id: str
    failed_sql: str
    error_message: str
    full_dag: Optional[Dict[str, Any]] = None

@app.get("/")
def read_root():
    return {"status": "Synapse Daedalus & Chaos Service Active", "version": "0.1.0"}

@app.post("/api/v1/daedalus/generate")
async def generate_dag(req: PromptRequest):
    try:
        dag = await run_daedalus_agent(req.prompt, req.current_dag)
        return {"status": "SUCCESS", "dag": dag}
    except Exception as e:
        print(f"❌ Daedalus Execution Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/v1/chaos/fix")
async def fix_sql(req: ChaosFixRequest):
    try:
        fix_result = await run_chaos_fix(req.node_id, req.failed_sql, req.error_message, req.full_dag)
        return {"status": "SUCCESS", "fix": fix_result}
    except Exception as e:
        print(f"❌ Chaos Execution Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))