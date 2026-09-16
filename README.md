# Synapse: Web-Based Visual Data Engineering Platform
## Technical Architecture & System Specification (v1.0 MVP)

---

## 1. Executive Summary

**Synapse** is a modern, client-side visual data engineering platform. By combining an in-browser WebAssembly database (**DuckDB-WASM**), a React Flow canvas (**Nymph**), and a dual-agent AI engine (**Daedalus** & **Chaos**), Synapse delivers a complete end-to-end data pipeline loop: turning natural language prompts into DAG topology, executing memory-native queries with zero network latency, and automatically repairing runtime exceptions.

### Core Value Proposition
* **Zero-Latency In-Browser Compute**: Runs DuckDB-WASM inside background Web Workers, paired with Apache Arrow IPC stream zero-copy transfer for high-performance memory analysis without backend roundtrips.
* **Text-to-DAG Architecture**: Daedalus Agent parses natural language requests into multi-stage ETL nodes and auto-spaces coordinates.
* **Self-Correction Loop**: Chaos Agent intercepts runtime SQL errors (e.g., missing tables, syntax issues), generates mock data or SQL fixes, and resumes pipeline execution seamlessly.

---

## 2. System Architecture Overview

Synapse operates on a decoupled architecture: a React monorepo for UI and local WASM execution, paired with a Python/FastAPI backend dedicated to LLM agent state machines.

| Layer | Subsystem / Module | Technology Stack | Primary Responsibility |
| :--- | :--- | :--- | :--- |
| **UI / Canvas** | Nymph Canvas Engine | React 18, React Flow (`@xyflow/react`), Tailwind CSS | Visual DAG canvas, custom node/edge rendering, dynamic auto-offsetting, and `fitView` focus. |
| **In-Browser Compute** | Ikaros Engine & Arrow IPC | DuckDB-WASM, Apache Arrow IPC, Web Worker | Web Worker lifecycle, in-memory SQL execution, zero-copy Arrow stream serialization, BigInt safety normalization. |
| **AI Architect Agent** | Daedalus Agent | FastAPI, LangChain, NVIDIA Nemotron 3.5 Lightning | Natural language Text-to-DAG translation, multi-stage ETL breakdown, and JSON topology generation. |
| **Self-Correction Agent** | Chaos Agent | FastAPI, LangChain, OpenRouter API | Runtime exception interception, schema gap analysis, inline `VALUES` mock data injection, and SQL repair. |
| **Orchestration** | Topological Scheduler | TypeScript (Kahn's Algorithm) | DAG dependency resolution, topological sorting, and sequential upstream-to-downstream execution. |

---

## 3. Subsystem Specifications

### 3.1 Nymph Canvas Engine (Frontend Canvas)
* **Custom `SqlNode`**: Features SQL preview, execution status indicators (`IDLE`, `RUNNING`, `SUCCESS`, `ERROR`), and manual trigger buttons.
* **`ParticleEdge`**: Custom animated edges representing dynamic stream flow from upstream output to downstream input.
* **Dynamic Auto-Offsetting**: Calculates the maximum Y-coordinate on the current canvas to position newly generated DAGs at a safe offset (`baseOffsetY = maxY + 200px`), preventing card overlaps.
* **Smooth Viewport Focus**: Calls `fitView({ duration: 800, padding: 0.2 })` upon topology generation to smoothly re-center all nodes within the viewport.

### 3.2 Ikaros Execution Engine (WASM & Arrow Data Layer)
Ikaros runs DuckDB in a dedicated Web Worker thread. Data transfer between the worker and the main UI thread utilizes Apache Arrow IPC streams for zero-copy memory exchange.

```typescript
// Worker Arrow IPC Stream Response Handling (worker.ts)
import * as duckdb from "@duckdb/duckdb-wasm";
import { tableToIPC } from "apache-arrow";

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;
  if (type === "EXECUTE_SQL") {
    const arrowTable = await conn.query(payload.sql);
    // Serialize Arrow Table to Binary IPC Stream
    const ipcBuffer = tableToIPC(arrowTable as any, "stream");
    self.postMessage({ id, type: "SUCCESS", result: ipcBuffer });
  }
};
```

#### BigInt Safe Serialization
To prevent `TypeError: Do not know how to serialize a BigInt` during UI state rendering, BigInt fields from DuckDB aggregations (`COUNT`, `SUM`) are converted dynamically:

```typescript
// Safe JSON Replacer for BigInt Serialization
JSON.stringify(
  queryResult, 
  (key, value) => (typeof value === "bigint" ? Number(value) : value), 
  2
);
```

### 3.3 Daedalus AI Architect (Text-to-DAG)
Powered by `nvidia/nemotron-3.5-lightning:free` via OpenRouter. Daedalus splits complex requests into multi-stage pipelines and outputs structured JSON conforming to platform schemas.

```json
{
  "dagId": "dag-7f3a9b2c",
  "nodes": [
    {
      "id": "node-1",
      "type": "SQL_CUSTOM",
      "label": "1. Extract & Filter",
      "position": { "x": 250, "y": 100 },
      "data": {
        "sqlQuery": "CREATE TEMP TABLE raw_data AS SELECT * FROM transactions WHERE year = 2026;"
      }
    },
    {
      "id": "node-2",
      "type": "SQL_CUSTOM",
      "label": "2. Aggregate Metrics",
      "position": { "x": 250, "y": 280 },
      "data": {
        "sqlQuery": "SELECT COUNT(DISTINCT user_id) AS total_users FROM raw_data;"
      }
    }
  ],
  "edges": [
    { "id": "edge-1-2", "source": "node-1", "target": "node-2", "animated": true }
  ]
}
```

### 3.4 Chaos Self-Correction Agent
If Ikaros throws a runtime error (e.g., `Table 'transactions' does not exist`), Chaos intercepts the error message and DAG context, repairing the SQL with self-contained mock data using DuckDB `VALUES` constructs:

```sql
-- Chaos Auto-Injected Mock Query Fix
CREATE TEMP TABLE filtered_customers AS 
SELECT * FROM (VALUES (2026, 1500, 1), (2026, 2000, 2), (2025, 500, 3)) 
AS t(year, amount, user_id) 
WHERE year = 2026 AND amount > 1000;
```

### 3.5 Topological Pipeline Scheduler
Implements Kahn's Algorithm to sort nodes based on edge dependencies, ensuring upstream nodes execute and materialize before downstream queries run.

```typescript
function getTopologicalOrder(nodes: Node[], edges: Edge[]): Node[] {
  const inDegree: Record<string, number> = {};
  const adjList: Record<string, string[]> = {};

  nodes.forEach((n) => { inDegree[n.id] = 0; adjList[n.id] = []; });
  edges.forEach((e) => {
    adjList[e.source].push(e.target);
    inDegree[e.target] = (inDegree[e.target] || 0) + 1;
  });

  const queue: string[] = nodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const currId = queue.shift()!;
    order.push(currId);
    (adjList[currId] || []).forEach((neighbor) => {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    });
  }

  return order.map((id) => nodes.find((n) => n.id === id)!).filter(Boolean);
}
```

---

## 4. End-to-End Execution Lifecycle

```
[ User Input Prompt ]
        │
        ▼
[ Daedalus Agent ] ──(Generates Schema)──► [ Nymph Canvas Rendering ]
                                                    │
                                           (Click "Run Pipeline")
                                                    │
                                                    ▼
                                       [ Topological Order Sorting ]
                                                    │
                                                    ▼
                                       [ Ikaros DuckDB-WASM Worker ]
                                                    │
                             ┌──────────────────────┴──────────────────────┐
                       (On Success)                                   (On Error)
                             │                                             │
                             ▼                                             ▼
                 [ Render IPC Result ]                           [ Chaos Agent Repair ]
                                                                           │
                                                                 (Auto-Inject Mock SQL)
                                                                           │
                                                                           ▼
                                                                 [ Resume Pipeline ]
```

---

## 5. Environment Setup & Execution

### Backend Setup (FastAPI / Python `venv`)

```powershell
# 1. Navigate to server directory and create venv
cd apps/server
python -m venv venv
.\venv\Scripts\Activate.ps1

# 2. Install dependencies
pip install fastapi uvicorn langgraph langchain-openai pydantic python-dotenv

# 3. Configure API Key in apps/server/.env
OPENROUTER_NEMOTRON3point5_API_KEY="sk-or-v1-..."

# 4. Start Uvicorn backend server
python -m uvicorn main:app --reload --port 8000
```

### Frontend Setup (React / Vite / `pnpm`)

```bash
# 1. Build internal packages from monorepo root
pnpm --filter @synapse/ikaros-arrow build
pnpm --filter @synapse/schema build

# 2. Launch Vite dev server
pnpm --filter @synapse/web dev
# Access UI at http://localhost:5173/
```

---

## 6. Verification Checklist

* [x] **DuckDB-WASM Worker**: Initializes properly with zero main-thread blocking.
* [x] **Arrow IPC Transfer**: Memory stream conversion working across worker boundaries.
* [x] **Text-to-DAG Pipeline**: Daedalus generates multi-stage SQL node graphs dynamically.
* [x] **Topological Execution**: Sequential execution works for multi-node chains.
* [x] **Self-Correction Loop**: Chaos intercepts missing table errors, injects `VALUES` mock datasets, updates nodes, and completes pipeline execution with verified output.