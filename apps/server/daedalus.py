import os
import json
import re
from typing import Dict, Any, Optional
from dotenv import load_dotenv
from pydantic import SecretStr
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage

load_dotenv()

nemotron_key = os.getenv("OPENROUTER_NEMOTRON3point5_API_KEY", "")
glm_key = os.getenv("OPENROUTER_GLM2_API_KEY", "")

api_key_str = nemotron_key or glm_key

# 1. 修正 OpenRouter 模型 Slug 名稱
# 若 nemotron Key 存在，使用 OpenRouter 上的 Nemotron 70B/Lightning 模型；否則 fallback 到 GLM 5.2 (free)
model_name = "nvidia/nemotron-3.5-lightning:free" if nemotron_key else "z-ai/glm-5.2:free"

# 2. 配置 ChatOpenAI，並加上 OpenRouter 要求的 HTTP Headers
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

SYSTEM_PROMPT = """You are Daedalus, the AI Architect of Synapse Data Platform.
Your task is to convert natural language data manipulation requests into a visual DAG (Directed Acyclic Graph) JSON structure.

Rules for Node Generation:
1. Break down complex requests into multi-stage nodes (e.g., Node 1 filters data, Node 2 aggregates).
2. DO NOT repeat identical SQL queries across connected nodes.
3. Automatically space out coordinates vertically.

Return ONLY a valid JSON object matching this schema:
{
  "dagId": "dag-<random_id>",
  "nodes": [
    {
      "id": "node-1",
      "type": "SQL_CUSTOM",
      "label": "1. Extract & Filter",
      "position": {"x": 250, "y": 100},
      "data": {
        "sqlQuery": "CREATE TEMP TABLE raw_data AS SELECT * FROM transactions WHERE year = 2026;"
      }
    },
    {
      "id": "node-2",
      "type": "SQL_CUSTOM",
      "label": "2. Aggregate Metrics",
      "position": {"x": 250, "y": 260},
      "data": {
        "sqlQuery": "SELECT COUNT(DISTINCT user_id) AS total_users, AVG(amount) AS avg_amount FROM raw_data;"
      }
    }
  ],
  "edges": [
    {
      "id": "edge-1-2",
      "source": "node-1",
      "target": "node-2",
      "animated": true
    }
  ]
}
"""

def extract_json_payload(text: str) -> str:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        return match.group(0)
    return text.strip()

async def run_daedalus_agent(
    prompt: str, 
    current_dag: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:

    if not api_key_str:
        print("⚠️ [Daedalus] No API Key found in .env, returning demo DAG.")
        return {
            "dagId": "dag-demo-001",
            "nodes": [
                {
                    "id": "node-daedalus-1",
                    "type": "SQL_CUSTOM",
                    "label": "Agent Auto-Generated Node",
                    "position": {"x": 300, "y": 200},
                    "data": {
                        "sqlQuery": f"-- Agent Prompt: {prompt}\nSELECT 'Daedalus Online' AS agent_status, 2026 AS year;"
                    }
                }
            ],
            "edges": []
        }

    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"User Request: {prompt}\nCurrent DAG State: {json.dumps(current_dag or {})}")
    ]

    try:
        response = await llm.ainvoke(messages)
        raw_content = response.content
        content_str = raw_content if isinstance(raw_content, str) else str(raw_content)

        json_str = extract_json_payload(content_str)
        return json.loads(json_str)

    except Exception as e:
        # 在控制台詳細印出錯誤原因
        print(f"❌ [Daedalus LLM Call Error]: {type(e).__name__} - {e}")
        return {
            "dagId": "dag-generated-fallback",
            "nodes": [
                {
                    "id": f"node-{os.urandom(3).hex()}",
                    "type": "SQL_CUSTOM",
                    "label": "Generated Query (Fallback)",
                    "position": {"x": 350, "y": 200},
                    "data": {
                        "sqlQuery": f"-- Query: {prompt}\nSELECT 'Daedalus Processed' AS status, 2026 AS year;"
                    }
                }
            ],
            "edges": []
        }