from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import os
import json
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage

router = APIRouter(prefix="/api/v1/hermes", tags=["Hermes Agent"])

class HermesRequest(BaseModel):
    prompt: str
    execution_mode: str  # "SILENT" | "CANVAS_FOCUS"
    current_dag: Dict[str, Any]

class HermesResponse(BaseModel):
    status: str
    action_type: str  # "INLINE_SQL" | "MUTATE_AST"
    message: str
    sql_query: Optional[str] = None
    ast_patch: Optional[Dict[str, Any]] = None

from pydantic import BaseModel, SecretStr

llm = ChatOpenAI(
    model="nvidia/nemotron-3.5-lightning:free",
    api_key=SecretStr(os.getenv("OPENROUTER_NEMOTRON3point5_API_KEY", "dummy")),
    base_url="https://openrouter.ai/api/v1",
)

@router.post("/chat", response_model=HermesResponse)
async def chat_with_hermes(req: HermesRequest):
    try:
        # 提取當前畫布中已存在的節點與表名資訊
        active_nodes = req.current_dag.get("nodes", [])
        table_context = ", ".join([f"{n.get('id')} ({n.get('data', {}).get('type', 'Table')})" for n in active_nodes]) or "raw_data (default)"

        if req.execution_mode == "SILENT":
            sys_msg = SystemMessage(
                content=f'You are Hermes Data Agent. Available tables in DuckDB-WASM: [{table_context}]. '
                        f'Respond ONLY with a valid JSON: {{"message": "brief explanation", "sql": "SELECT ... FROM raw_data;"}}'
            )
            user_msg = HumanMessage(content=f"User Query: {req.prompt}")
            res = llm.invoke([sys_msg, user_msg])
            
            content_str = str(res.content)
            parsed = json.loads(content_str)
            
            return HermesResponse(
                status="SUCCESS", 
                action_type="INLINE_SQL", 
                message=parsed.get("message", "Calculated."), 
                sql_query=parsed.get("sql", "SELECT 1;")
            )
        
        else:
            # 模式 2：Canvas Focus 生成新 Alteryx 節點並掛載於畫布
            node_id = f"node_{int(os.urandom(2).hex(), 16)}"
            ast_patch = {
                "nodes": [{
                    "id": node_id,
                    "type": "alteryxNode",
                    "position": {"x": 400, "y": 250},
                    "data": {
                        "label": f"Filter: {req.prompt[:12]}",
                        "type": "FILTER",
                        "config": {"field": "amount", "op": ">", "val": "1000"},
                        "sqlQuery": f"CREATE TEMP TABLE {node_id} AS SELECT * FROM raw_data WHERE amount > 1000;"
                    }
                }],
                "edges": []
            }
            return HermesResponse(
                status="SUCCESS", 
                action_type="MUTATE_AST", 
                message=f"Created visual node on canvas for: {req.prompt}", 
                ast_patch=ast_patch
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))