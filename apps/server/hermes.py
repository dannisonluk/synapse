from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import os
import json
import re
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
from pydantic import SecretStr

# 舊版沒有呼叫 load_dotenv()：llm 在 import 時就建立，全靠 chaos.py 先 import
# 過來「順便」載入 .env。這個隱性耦合一旦改動 import 次序就會靜靜地壞掉。
load_dotenv()

router = APIRouter(prefix="/api/v1/hermes", tags=["Hermes Agent"])


class HermesRequest(BaseModel):
    prompt: str
    execution_mode: str  # "SILENT" | "CANVAS_FOCUS"
    current_dag: Optional[Dict[str, Any]] = None


class HermesResponse(BaseModel):
    status: str
    action_type: str  # "INLINE_SQL" | "MUTATE_AST" | "MESSAGE"
    message: str
    sql_query: Optional[str] = None
    ast_patch: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# LLM 設定（同 daedalus.py / chaos.py 一致：Nemotron 優先，GLM 後備）
# ---------------------------------------------------------------------------
nemotron_key = os.getenv("OPENROUTER_NEMOTRON3point5_API_KEY", "")
glm_key = os.getenv("OPENROUTER_GLM2_API_KEY", "")
api_key_str = nemotron_key or glm_key
model_name = (
    "nvidia/nemotron-3.5-lightning:free" if nemotron_key else "z-ai/glm-5.2:free"
)

llm: Optional[ChatOpenAI] = None
if api_key_str:
    llm = ChatOpenAI(
        model=model_name,
        api_key=SecretStr(api_key_str),
        base_url="https://openrouter.ai/api/v1",
        temperature=0.1,
        default_headers={
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "Synapse Data Platform",
        },
    )

# ---------------------------------------------------------------------------
# 節點能力目錄
# ---------------------------------------------------------------------------
# 這份清單以前是手寫在這裡的，於是與 apps/web/src/engine/astCompiler.ts 的
# switch 各寫一份，最後漂移掉了：少了 SELECT / UNION / SAMPLE / RENAME，
# SUMMARIZE 的描述停在「單一 groupBy + 單一聚合」的舊格式，SORT 的鍵名也寫錯
# （寫 groupBy，但編譯器讀的是 field）。結果是 AI 根本產生不出這些節點。
#
# 現在唯一真相來源是 apps/web/src/engine/nodeCatalog.ts，由
# `node scripts/gen_node_catalog.mjs` 匯出成 node_catalog.json。這裡只負責讀。
# scripts/verify.mjs 會斷言「磁碟上的 JSON == 目錄重新產生一次的結果」，
# 所以忘記重新產生會直接讓驗證紅燈，而不是靜默地讓 agent 少會幾個工具。
CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "node_catalog.json")

# 內建後備：只有在 node_catalog.json 不存在 / 壞掉時才會用到，
# 目的是「檔案不在也能開機」。內容刻意寫得保守，不追求完整。
_FALLBACK_TYPES = [
    "INPUT_DUCKDB", "FILTER", "FORMULA", "SUMMARIZE", "JOIN", "SORT", "SELECT",
    "UNION", "SAMPLE", "RENAME", "VIZ_CHART",
]
_FALLBACK_PROMPT_SECTION = "\n".join(f"- {t}" for t in _FALLBACK_TYPES)
_FALLBACK_HINT_KEYS = [
    "field", "groupBy", "target", "leftKey", "rightKey", "outputColumn",
    "fileName", "columns", "partitionBy", "orderBy",
]


def _load_catalog():
    """讀取節點目錄快照 → (合法類型集合, prompt 用的 schema 段落, canvas hint 鍵)"""
    try:
        with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        types = data.get("types")
        section = data.get("promptSection")
        hints = data.get("hintKeys")
        if isinstance(types, list) and types and isinstance(section, str) and section:
            return set(types), section, list(hints or [])
        print("⚠️ [Hermes] node_catalog.json 內容不完整 —— 改用內建後備清單")
    except FileNotFoundError:
        print(
            "⚠️ [Hermes] 找不到 node_catalog.json —— 改用內建後備清單。\n"
            "   請執行 `node scripts/gen_node_catalog.mjs` 產生它。"
        )
    except Exception as exc:  # noqa: BLE001 —— 開機不該因為這個檔案而失敗
        print(f"⚠️ [Hermes] 讀取 node_catalog.json 失敗（{type(exc).__name__}）—— 改用內建後備清單")

    return set(_FALLBACK_TYPES), _FALLBACK_PROMPT_SECTION, list(_FALLBACK_HINT_KEYS)


VALID_NODE_TYPES, _NODE_SCHEMA_SECTION, _CANVAS_HINT_KEYS = _load_catalog()

MUTATE_SYSTEM_PROMPT = """You are Hermes, the AI Copilot of Synapse, an in-browser visual data engineering platform.
Convert the user's natural-language request into a MULTI-NODE Alteryx-style pipeline JSON. Break the request into discrete processing steps (input → preparation → transform → aggregate → visualize), one node per step.

Allowed node types and their config schemas (this list is generated from the platform's own node catalogue, so it is always current — do not assume any other type exists):
""" + _NODE_SCHEMA_SECTION + """

Respond with ONLY a valid JSON object (no markdown fences):
{"nodes": [{"id": "n0", "type": "<TYPE>", "label": "<short label>", "config": {...}}, ...],
 "edges": [{"source": "n0", "target": "n1", "targetHandle": "left"}],
 "message": "<one-sentence summary of the pipeline>"}

Rules:
1. The FIRST node MUST be INPUT_DUCKDB (the platform defaults it to an existing "raw_data" table or a file upload).
2. Node ids are index labels n0, n1, n2... strictly sequential.
3. Default the targetHandle of every edge to "left"; only the second input of JOIN / APPEND_FIELDS / FIND_REPLACE uses "right".
4. If the request extends data already on the canvas, use that EXISTING node id (see canvas context) as the edge source instead of creating a new INPUT_DUCKDB.
5. Do NOT invent exotic column names — prefer common ones (id, amount, year, category, country, sales, qty, date).
6. "by X" / "group by X" / "per X" → SUMMARIZE with groupBy=["X"] and an aggregations entry.
7. "filter/過濾/大於/小於/only/where" → FILTER node.
8. "chart/圖/visualize" → end with a VIZ_CHART node.
9. Only use the config keys listed for that node type above. Do not invent keys.
10. Max 6 nodes per pipeline."""

INLINE_SYSTEM_PROMPT = """You are Hermes Data Copilot of Synapse. Available tables in DuckDB-WASM:
{canvas_context}

The user asked a direct calculation question. Respond ONLY with valid JSON (no markdown):
{{"message": "brief explanation", "sql": "SELECT ... ;"}}
Use DuckDB SQL syntax. Do not create temp tables."""


def extract_json_payload(text: str) -> str:
    """去除 markdown code fence 並抽出首個 JSON 物件/陣列。"""
    cleaned = re.sub(r"```(?:json)?", "", text).strip("` \n")
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        return match.group(0)
    return cleaned


def _render_hint(value: Any) -> str:
    """
    把 config 值攤成一行可讀文字。

    舊版直接 f-string 插值，於是陣列會變成 Python repr（groupBy=['year','region']），
    而 groupBy 現在本來就可能是多鍵陣列 —— agent 看到的是它的語法而不是語意。
    """
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_render_hint(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k}: {_render_hint(v)}" for k, v in value.items()) + "}"
    return str(value)


def _describe_canvas(current_dag: Optional[Dict[str, Any]]) -> str:
    """
    將畫布 DAG 轉成給 LLM 看的 schema context。

    🐛 舊版 bug：讀 `n.get("data", {}).get("type")`，但前端傳來的 shape 是
    flat 的 `{id, label, type, config}`（沒有 `data` 這一層），所以 type 永遠
    退回成 "Table" —— LLM 完全看不到畫布上真正有什麼節點與欄位。
    這裡同時接受兩種 shape，並附上每個節點的輸出表名。

    要攤開哪些 config 鍵，由 node_catalog.json 的 hintKeys 決定（不再手寫）。
    """
    nodes = (current_dag or {}).get("nodes") or []
    if not nodes:
        return "raw_data (platform default sample table; columns: id, item, amount, year)"

    lines: List[str] = []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        data = n.get("data") if isinstance(n.get("data"), dict) else {}
        nid = str(n.get("id") or data.get("id") or "?")
        ntype = str(data.get("type") or n.get("type") or "TABLE")
        label = str(n.get("label") or data.get("label") or "")
        cfg = data.get("config") or n.get("config") or {}

        hints: List[str] = []
        if isinstance(cfg, dict):
            for key in _CANVAS_HINT_KEYS:
                val = cfg.get(key)
                # 空字串 / 空陣列等於「沒設定」，寫出來只會干擾判斷
                if val is None or val == "" or val == []:
                    continue
                hints.append(f"{key}={_render_hint(val)}")

        detail = f" [{', '.join(hints)}]" if hints else ""
        lines.append(f"- id={nid} type={ntype} label=\"{label}\"{detail}")

    lines.append(
        "Each node materialises its result into a DuckDB table named exactly "
        "after its id, so upstream references use those ids."
    )
    return "\n".join(lines)


def _canvas_node_ids(current_dag: Optional[Dict[str, Any]]) -> set:
    """畫布上已存在的節點 id（容許 patch 邊線連到它們）。"""
    nodes = (current_dag or {}).get("nodes") or []
    ids = set()
    for n in nodes:
        if isinstance(n, dict) and n.get("id"):
            ids.add(str(n["id"]))
    return ids


def _validate_ast_patch(
    patch: Dict[str, Any],
    external_ids: Optional[set] = None,
) -> Optional[Dict[str, Any]]:
    """
    LLM 輸出防呆：過濾無效節點/邊，保證最少 1 節點。

    external_ids：畫布上已存在的節點 id。rule 4 要求 LLM 可以延伸現有 DAG
    （例如 edge.source 指向畫布上某個節點），因此這些 id 必須視為合法端點，
    否則這些邊會在後端就被剝走，AI 生成的 pipeline 永遠連不到現有節點。
    """
    nodes = patch.get("nodes")
    if not isinstance(nodes, list) or len(nodes) == 0:
        return None

    seen_ids = set()
    cleaned_nodes = []
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            continue
        ntype = str(n.get("type", "")).upper()
        if ntype not in VALID_NODE_TYPES:
            continue

        raw_id = str(n.get("id") or "").strip()
        # 只接受 n0..nN 形式；其他一律用索引補回，並保證唯一
        nid = raw_id if re.fullmatch(r"n\d+", raw_id) else f"n{i}"
        if nid in seen_ids:
            nid = f"n{i}"
            while nid in seen_ids:
                nid = f"n{len(seen_ids) + i + 1}"
        seen_ids.add(nid)

        cfg = n.get("config") if isinstance(n.get("config"), dict) else {}
        cleaned_nodes.append({
            "id": nid,
            "sourceIndex": i,
            "type": ntype,
            "label": str(n.get("label") or ntype),
            "config": cfg,
        })

    if not cleaned_nodes:
        return None

    # 合法端點 = patch 內部節點 ∪ 畫布現有節點
    id_set = {n["id"] for n in cleaned_nodes} | set(external_ids or ())
    edges = patch.get("edges")
    cleaned_edges = []
    if isinstance(edges, list):
        for e in edges:
            if not isinstance(e, dict):
                continue
            src, tgt = e.get("source"), e.get("target")
            if src in id_set and tgt in id_set and src != tgt:
                cleaned_edges.append({
                    "source": src,
                    "target": tgt,
                    "targetHandle": "right" if e.get("targetHandle") == "right" else "left",
                })

    return {"nodes": cleaned_nodes, "edges": cleaned_edges}


# 關鍵字 → 節點模板。順序就是 pipeline 的順序（清理 → 整形 → 篩選 → 聚合 → 排序 → 視覺化）。
#
# 舊版是四個獨立的 if，只認得 FILTER / SUMMARIZE / VIZ_CHART —— 新增的
# 11 種工具它一概不知道，於是 LLM 一掛掉，fallback 產出的 pipeline 就退回
# 「Input → 可能有的 Filter → 可能有的 Summarize → 可能有的 Chart」。
# 改成表驅動之後，加一個工具只要加一列。
_FALLBACK_STEPS: List[Dict[str, Any]] = [
    {
        "patterns": ["dedup", "dedupe", "去重", "去除重複", "unique", "distinct", "重複"],
        "type": "UNIQUE", "label": "Unique",
        "config": {"columns": []},
    },
    {
        "patterns": ["clean", "清理", "去空白", "trim", "格式"],
        "type": "DATA_CLEANSING", "label": "Data Cleansing",
        "config": {"columns": [], "trim": True, "collapse": False, "emptyToNull": True},
    },
    {
        "patterns": ["impute", "補值", "填補", "缺漏", "空值", "missing", "null"],
        "type": "IMPUTE", "label": "Impute",
        "config": {"columns": ["amount"], "method": "CONSTANT", "fillValue": "0"},
    },
    {
        "patterns": ["split", "拆欄", "分隔", "分割"],
        "type": "TEXT_TO_COLUMNS", "label": "Text to Columns",
        "config": {"field": "item", "separator": ",", "outputColumns": ["part_1", "part_2"]},
    },
    {
        "patterns": ["filter", "過濾", "only", "where", "大於", "小於", "篩選"],
        "type": "FILTER", "label": "Filter",
        "config": {"field": "amount", "op": ">", "val": "1000"},
    },
    {
        "patterns": ["pivot", "樞紐", "列轉欄", "展開"],
        "type": "CROSS_TAB", "label": "Cross Tab",
        "config": {"pivotColumn": "category", "valueColumn": "amount",
                   "aggFunc": "SUM", "groupBy": ["year"]},
    },
    {
        "patterns": ["unpivot", "轉置", "欄轉列", "寬轉長"],
        "type": "TRANSPOSE", "label": "Transpose",
        "config": {"columns": ["amount"], "nameColumn": "metric", "valueColumn": "value"},
    },
    {
        "patterns": ["rank", "排名", "名次", "排行"],
        "type": "RANK", "label": "Rank",
        "config": {"target": "amount", "outputColumn": "amount_rank",
                   "method": "RANK", "partitionBy": [], "descending": True},
    },
    {
        "patterns": ["running", "cumulative", "累計", "累加"],
        "type": "RUNNING_TOTAL", "label": "Running Total",
        "config": {"target": "amount", "outputColumn": "amount_running",
                   "partitionBy": [], "orderBy": "id"},
    },
    {
        "patterns": ["previous", "lag", "上一列", "前一筆", "前值"],
        "type": "MULTI_ROW_FORMULA", "label": "Multi-Row Formula",
        "config": {"outputColumn": "prev_amount", "expression": "LAG(amount, 1)",
                   "partitionBy": [], "orderBy": "id", "descending": False},
    },
    {
        "patterns": ["sum", "avg", "total", "加總", "平均", "count", "合計",
                     "aggregat", "group", "按", "各"],
        "type": "SUMMARIZE", "label": "Summarize",
        "config": {"groupBy": ["year"],
                   "aggregations": [{"func": "SUM", "target": "amount"}]},
    },
    {
        "patterns": ["sort", "排序", "由大到小", "由小到大", "order"],
        "type": "SORT", "label": "Sort",
        "config": {"field": "amount", "descending": True},
    },
    {
        "patterns": ["chart", "graph", "plot", "圖", "視覺", "visual",
                     "bar", "pie", "line"],
        "type": "VIZ_CHART", "label": "Chart",
        "config": {"chartType": "BAR", "xAxis": "year", "yAxis": "amount_sum"},
    },
]


def _fallback_ast_patch(prompt: str) -> Dict[str, Any]:
    """LLM 失敗時的決定性 fallback：關鍵字 → 模板 pipeline"""
    pl = prompt.lower()
    nodes: List[Dict[str, Any]] = [
        {"id": "n0", "sourceIndex": 0, "type": "INPUT_DUCKDB",
         "label": "Input Data", "config": {}},
    ]
    edges: List[Dict[str, Any]] = []
    idx = 1

    for step in _FALLBACK_STEPS:
        if not any(k in pl for k in step["patterns"]):
            continue
        nodes.append({
            "id": f"n{idx}",
            "sourceIndex": idx,
            "type": step["type"],
            "label": step["label"],
            "config": dict(step["config"]),
        })
        edges.append({"source": f"n{idx - 1}", "target": f"n{idx}", "targetHandle": "left"})
        idx += 1

    return {"nodes": nodes, "edges": edges}


@router.post("/chat", response_model=HermesResponse)
async def chat_with_hermes(req: HermesRequest):
    try:
        canvas_context = _describe_canvas(req.current_dag)
        canvas_ids = _canvas_node_ids(req.current_dag)

        # ------------------------------------------------------------------
        # SILENT → 直接計算一條 SQL 回傳（不改畫布）
        # ------------------------------------------------------------------
        if req.execution_mode == "SILENT":
            if llm is None:
                return HermesResponse(
                    status="SUCCESS",
                    action_type="MESSAGE",
                    message=(
                        "Hermes 離線：apps/server 未設定 OPENROUTER_NEMOTRON3point5_API_KEY "
                        "或 OPENROUTER_GLM2_API_KEY，無法解析自然語言。\n"
                        "設定好 key 之後就可以用 INLINE 模式直接計數。"
                    ),
                )

            sys_msg = SystemMessage(
                content=INLINE_SYSTEM_PROMPT.format(canvas_context=canvas_context)
            )
            user_msg = HumanMessage(content=f"User Query: {req.prompt}")
            res = llm.invoke([sys_msg, user_msg])
            parsed = json.loads(extract_json_payload(str(res.content)))
            return HermesResponse(
                status="SUCCESS",
                action_type="INLINE_SQL",
                message=parsed.get("message", "Calculated."),
                sql_query=parsed.get("sql", "SELECT 1;"),
            )

        # ------------------------------------------------------------------
        # CANVAS_FOCUS → LLM 生成多節點 pipeline
        # 節點 id 用 n0..nN，前端會重新以 UUID 落地並按 id / sourceIndex 重連邊線
        # ------------------------------------------------------------------
        parsed: Optional[Dict[str, Any]] = None
        if llm is not None:
            try:
                res = llm.invoke([
                    SystemMessage(content=MUTATE_SYSTEM_PROMPT),
                    HumanMessage(content=(
                        f"Canvas context:\n{canvas_context}\n\n"
                        f"User request: {req.prompt}\n\n"
                        "Generate the pipeline JSON now."
                    )),
                ])
                parsed = json.loads(extract_json_payload(str(res.content)))
            except Exception as e:
                print(f"❌ [Hermes MUTATE LLM Error]: {type(e).__name__} - {e}")
                parsed = None

        patch = (
            _validate_ast_patch(parsed, canvas_ids)
            if isinstance(parsed, dict)
            else None
        )
        if patch is None:
            reason = "LLM 未設定" if llm is None else "LLM 輸出無效"
            print(f"⚠️ [Hermes] {reason} — 改用關鍵字 fallback pipeline。")
            patch = _validate_ast_patch(
                _fallback_ast_patch(req.prompt), canvas_ids
            ) or {
                "nodes": [{"id": "n0", "sourceIndex": 0, "type": "INPUT_DUCKDB",
                           "label": "Input Data", "config": {}}],
                "edges": [],
            }

        return HermesResponse(
            status="SUCCESS",
            action_type="MUTATE_AST",
            message=(
                (parsed or {}).get("message")
                or f"已於畫布生成 {len(patch['nodes'])} 個節點的 pipeline。"
            ),
            ast_patch=patch,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
