import os
import json
import re
from typing import Dict, Any, Optional
from dotenv import load_dotenv
from pydantic import SecretStr, BaseModel
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage

load_dotenv()

nemotron_key = os.getenv("OPENROUTER_NEMOTRON3point5_API_KEY", "")
glm_key = os.getenv("OPENROUTER_GLM2_API_KEY", "")
api_key_str = nemotron_key or glm_key

model_name = "nvidia/nemotron-3.5-lightning:free" if nemotron_key else "z-ai/glm-5.2:free"

llm = ChatOpenAI(
    model=model_name,
    api_key=SecretStr(api_key_str) if api_key_str else None,
    base_url="https://openrouter.ai/api/v1",
    temperature=0.1,
    default_headers={
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "Synapse Data Platform",
    }
)

CHAOS_SYSTEM_PROMPT = """You are Chaos, the Self-Correction Agent for Synapse Data Platform.
A SQL query in a visual DAG failed during DuckDB execution. Your task is to analyze the error and fix the SQL query.

Rules:
1. Analyze the DuckDB error message (e.g., table not found, syntax error, column mismatch).
2. If a table doesn't exist (e.g., 'transactions'), generate DuckDB SQL that creates mock/sample data or fixes the table reference.
3. Return ONLY a valid JSON object matching this schema:
{
  "fixedSqlQuery": "<Corrected DuckDB SQL Query>",
  "explanation": "<Short one-sentence explanation of what was fixed>"
}
"""

def extract_json_payload(text: str) -> str:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        return match.group(0)
    return text.strip()

async def run_chaos_fix(
    node_id: str,
    failed_sql: str,
    error_message: str,
    full_dag: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    
    if not api_key_str:
        return {
            "fixedSqlQuery": f"-- [Chaos Auto-Fixed]\nCREATE TABLE IF NOT EXISTS transactions AS SELECT 1 AS user_id, 100 AS amount, 2026 AS year;\n{failed_sql}",
            "explanation": "Generated mock table for missing data."
        }

    messages = [
        SystemMessage(content=CHAOS_SYSTEM_PROMPT),
        HumanMessage(content=f"Node ID: {node_id}\nFailed SQL: {failed_sql}\nError Message: {error_message}\nDAG Context: {json.dumps(full_dag or {})}")
    ]

    try:
        response = await llm.ainvoke(messages)
        content_str = str(response.content)
        json_str = extract_json_payload(content_str)
        return json.loads(json_str)
    except Exception as e:
        print(f"❌ [Chaos Agent Error]: {e}")
        # 保底修復
        return {
            "fixedSqlQuery": f"-- [Chaos Fallback Fix]\nSELECT 'Fixed Status' AS status, 2026 AS year;",
            "explanation": "Fallback SQL fix applied."
        }