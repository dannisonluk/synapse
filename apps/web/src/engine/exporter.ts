// apps/web/src/engine/exporter.ts
// Synapse 匯出 / 匯入層 —— 這是「工作流可以離開瀏覽器」的唯一出口。
//
// 兩件事：
//   1. exportToSqlCte()   —— 將成個 DAG 編譯成「一條」DuckDB CTE 查詢
//   2. exportWorkflowJson / importWorkflowJson —— 工作流存檔 / 讀檔
//
// 設計原則：
//   - SQL 本體完全由 astCompiler.compileNodeSelect() 產生（唯一來源），
//     因此「匯出的 SQL」與「畫布實際執行的 SQL」永遠一致，不會各自漂移。
//   - CTE 名 = 節點 id —— 因為節點輸出表名本身就是 nodeId，
//     上游引用 `${qi(sourceTable)}` 直接變成 CTE 引用，零改寫。
//   - 本檔案不可 import React component（測試會在 Node 直接 import 它）。
import type { Edge, Node } from "@xyflow/react";
import { orderUpstreamSources, topologicalSort } from "./scheduler";
import { compileNodeSelect, resolveSourceTables, requiredExtensions } from "./astCompiler";
import { qi } from "./sql";
import { narrateNode } from "./narrate";

// ---------------------------------------------------------------------------
// SQL CTE 匯出
// ---------------------------------------------------------------------------

export interface SqlExportResult {
	/** 可直接貼到 DuckDB / CLI 執行的完整 SQL */
	sql: string;
	/**
	 * 只有 `WITH … SELECT` 那一段，不含檔頭註解與 `LOAD`。
	 *
	 * 需要它的地方是「把整條管線當成子查詢」——例如
	 * `CREATE TABLE out.t AS <query>`（寫入外部資料庫）。用 `sql` 會把
	 * `LOAD spatial;` 一起塞進去，而那不是合法的子查詢。
	 */
	query: string;
	/** 不由工作流產生的來源表（執行前要自行註冊，例如 raw_data、上傳檔案） */
	externalSources: string[];
	/** 被略過的節點 id（VIZ_CHART 是終端檢視節點，不建立資料表） */
	skipped: string[];
}

/** 由 raw SQL 節點的 sqlQuery 抽出 SELECT 本體（剝走 DDL 外殼） */
const DDL_PREFIX =
	/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\s+AS\s+/i;

export function rawSqlBody(sql: unknown): string {
	let s = String(sql ?? "").trim();
	s = s.replace(/;+\s*$/, "").trim();
	s = s.replace(DDL_PREFIX, "").trim();
	return s || "SELECT 1";
}

function indentBlock(text: string, spaces: number): string {
	const pad = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => (line.trim() ? pad + line : line))
		.join("\n");
}

/**
 * 將整個 DAG 編譯成單一 CTE 查詢。
 *
 * 回傳 null = 圖含循環依賴（不可線性化成 SQL），與 scheduler 的契約一致。
 *
 * @param opts.sink 指定最終 SELECT 的節點；預設自動挑選終點
 *                  （有 VIZ_CHART → 挑選它的來源；否則挑選最後一個無出邊的節點）
 */
export function exportToSqlCte(
	nodes: Node[],
	edges: Edge[],
	opts: { sink?: string; title?: string } = {},
): SqlExportResult | null {
	const order = topologicalSort(
		nodes.map((n) => n.id),
		edges,
	);
	if (!order) return null;

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const hasOutgoing = new Set(edges.map((e) => e.source));
	const externalSources = new Set<string>();
	const skipped: string[] = [];
	const ctes: {
		id: string;
		label: string;
		type: string;
		body: string;
		/** 這個節點的人話說明（見 narrate.ts），會寫成匯出腳本裡的註解 */
		narration: string;
	}[] = [];
	// 需要 DuckDB 擴充的節點 → 腳本開頭要補 LOAD。
	// 不能塞進 WITH 裡面：LOAD 是一條獨立語句，WITH ... SELECT 是一條語句。
	const extensions = new Set<string>();

	for (const id of order) {
		const node = byId.get(id);
		if (!node) continue;
		const data: any = node.data || {};
		const type: string = data.type || "RAW_SQL";
		const label: string = data.label || id;

		// 檢視節點不產生資料表 → 不可進入 CTE
		if (type === "VIZ_CHART") {
			skipped.push(id);
			continue;
		}

		const upstream = orderUpstreamSources(id, edges);

		for (const ext of requiredExtensions(type)) extensions.add(ext);

		// 有 data.type → 由 config 重新編譯（單一來源）；
		// 沒有 data.type → 使用者自己寫的 raw SQL 節點，沿用原句
		const body = data.type
			? compileNodeSelect(id, type, data.config || {}, upstream)
			: rawSqlBody(data.sqlQuery);

		// 沒有上游 → 這個節點要讀取一個外部表；記錄下來在檔頭提醒使用者。
		// 但要確認 body 真的有引用到 —— raw SQL 節點可以完全自給自足
		// （例如 SELECT 1 AS x），無端端報「需要 raw_data」會誤導。
		if (upstream.length === 0) {
			const src =
				type === "INPUT_DUCKDB" && data.config?.fileName
					? data.config.tableName || `src_${id}`
					: "raw_data";
			if (body.includes(src)) externalSources.add(src);
		}

		// 管線說明：**確定性**地由 config 推導（見 engine/narrate.ts），
		// 不是叫 LLM 寫。讓模型自由描述一張圖會產生「看起來合理但不存在的步驟」。
		// 寫進匯出腳本當註解，零 LLM 成本就有大部分價值 —— 拿到腳本的人不必
		// 反推每一段 SQL 在做什麼。
		const narration = narrateNode({
			type,
			config: (data.config || {}) as Record<string, unknown>,
			upstreamLabels: upstream.map((uid) => {
				const up = byId.get(uid);
				return up ? (up.data as any)?.label || uid : uid;
			}),
		});

		ctes.push({ id, label, type, body, narration });
	}

	// ---- 終點選擇 ----
	let sinkTable: string | null = null;
	if (opts.sink && byId.has(opts.sink)) {
		sinkTable = opts.sink;
	} else {
		const vizId = order.find(
			(id) => (byId.get(id)?.data as any)?.type === "VIZ_CHART",
		);
		if (vizId) {
			sinkTable = resolveSourceTables(vizId, "FILTER", edges)[0] || null;
		} else {
			const sinks = order.filter((id) => !hasOutgoing.has(id));
			sinkTable =
				sinks.length > 0
					? sinks[sinks.length - 1]
					: ctes.length > 0
						? ctes[ctes.length - 1].id
						: null;
		}
	}

	// ---- 組裝 ----
	const lines: string[] = [
		"-- Synapse Workflow → DuckDB SQL (CTE)",
		"-- 節點順序 = 拓撲序（上游先於下游），同畫布實際執行次序一致。",
	];
	if (opts.title) lines.splice(1, 0, `-- ${opts.title}`);
	if (externalSources.size > 0) {
		lines.push("--");
		lines.push("-- ⚠ 以下來源表不由工作流產生，執行前請先註冊／建立：");
		for (const s of [...externalSources].sort()) lines.push(`--   ${s}`);
	}
	if (skipped.length > 0) {
		lines.push(
			`-- 已略過 ${skipped.length} 個檢視節點（VIZ_CHART 不建立資料表）：${skipped.join(", ")}`,
		);
	}
	lines.push("");

	if (ctes.length === 0) {
		lines.push("SELECT 1 AS empty_workflow;");
		return {
			sql: lines.join("\n"),
			query: "SELECT 1 AS empty_workflow",
			externalSources: [...externalSources].sort(),
			skipped,
		};
	}

	// LOAD 必須是獨立語句，所以放在 WITH 之前 —— 塞進 CTE 會是語法錯誤。
	// 排序只是為了讓同一份工作流每次匯出逐字節相同。
	for (const ext of [...extensions].sort()) {
		lines.push(`LOAD ${ext};`);
	}
	if (extensions.size > 0) lines.push("");

	// 從這裡開始是**單一查詢**（WITH … SELECT），前面那些獨立語句都不屬於它。
	// 記下起點，讓 query 可以單獨使用 —— `CREATE TABLE x AS <query>` 正是
	// 需要這個形狀，而它不能包含 LOAD 或註解。
	const queryStart = lines.length;
	lines.push("WITH");
	ctes.forEach((cte, i) => {
		const comma = i < ctes.length - 1 ? "," : "";
		lines.push(`-- ${cte.label} (${cte.type})`);
		lines.push(`-- ${cte.narration}`);
		lines.push(`${qi(cte.id)} AS (`);
		lines.push(indentBlock(cte.body, 4));
		lines.push(`)${comma}`);
	});
	lines.push("");
	lines.push(
		sinkTable
			? `SELECT * FROM ${qi(sinkTable)};`
			: "SELECT 1 AS empty_workflow;",
	);

	return {
		sql: lines.join("\n"),
		// 只有 WITH … SELECT 那一段，不含檔頭註解與 LOAD。
		// 尾端分號去掉：它會被嵌進 `CREATE TABLE … AS <query>;`。
		query: lines.slice(queryStart).join("\n").replace(/;\s*$/, ""),
		externalSources: [...externalSources].sort(),
		skipped,
	};
}

// ---------------------------------------------------------------------------
// 工作流存檔 / 讀檔（.synapse / .json）
// ---------------------------------------------------------------------------

export const WORKFLOW_FORMAT = "synapse-workflow";
export const WORKFLOW_VERSION = 1;

export interface SerializedNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: {
		label: string;
		/** AlteryxNodeType；沒有 = 使用者自己寫的 raw SQL 節點 */
		type?: string;
		config?: Record<string, unknown>;
		sqlQuery?: string;
	};
}

export interface SerializedEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
}

export interface WorkflowFile {
	format: string;
	version: number;
	title: string;
	exportedAt: string;
	nodes: SerializedNode[];
	edges: SerializedEdge[];
}

/**
 * 序列化畫布 → JSON 字串。
 *
 * 只保留可持久化的欄位：onExecute / onChangeConfig 這些 callback 與
 * executionState 這些瞬態狀態一律不寫入（寫了也還原不了）。
 * sqlQuery 一定要寫 —— 否則 Chaos Agent 修復過的 SQL 一存檔就會流失。
 */
export function exportWorkflowJson(
	nodes: Node[],
	edges: Edge[],
	meta: { title?: string; now?: string } = {},
): string {
	const file: WorkflowFile = {
		format: WORKFLOW_FORMAT,
		version: WORKFLOW_VERSION,
		title: meta.title || "Untitled Workflow",
		exportedAt: meta.now || new Date().toISOString(),
		nodes: nodes.map((n) => {
			const d: any = n.data || {};
			const out: SerializedNode = {
				id: n.id,
				type: n.type || "alteryxNode",
				position: {
					x: Math.round(Number(n.position?.x) || 0),
					y: Math.round(Number(n.position?.y) || 0),
				},
				data: { label: d.label || n.id },
			};
			if (d.type) out.data.type = d.type;
			if (d.config && typeof d.config === "object") out.data.config = d.config;
			if (typeof d.sqlQuery === "string") out.data.sqlQuery = d.sqlQuery;
			return out;
		}),
		edges: edges.map((e, i) => ({
			id: e.id || `edge_${i}`,
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle ?? null,
			targetHandle: e.targetHandle ?? null,
		})),
	};
	return JSON.stringify(file, null, 2);
}

/**
 * 反序列化 JSON → 乾淨的工作流結構（不含 callback，由畫布負責注入）。
 * 任何不合法的輸入（壞 JSON / 不是我們的格式 / 缺 nodes|edges）一律回傳 null。
 * 指向不存在節點的邊會被丟棄 —— 避免載入後出現懸空連線。
 */
export function importWorkflowJson(text: string): WorkflowFile | null {
	let raw: any;
	try {
		raw = JSON.parse(String(text ?? ""));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	if (raw.format !== WORKFLOW_FORMAT) return null;
	if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;

	const seen = new Set<string>();
	const nodes: SerializedNode[] = [];
	for (const n of raw.nodes) {
		if (!n || typeof n.id !== "string" || !n.id) continue;
		if (seen.has(n.id)) continue; // 重複 id → 保留第一個
		seen.add(n.id);

		const d = n.data && typeof n.data === "object" ? n.data : {};
		const out: SerializedNode = {
			id: n.id,
			type: typeof n.type === "string" && n.type ? n.type : "alteryxNode",
			position: {
				x: Number(n.position?.x) || 0,
				y: Number(n.position?.y) || 0,
			},
			data: { label: typeof d.label === "string" ? d.label : n.id },
		};
		if (typeof d.type === "string") out.data.type = d.type;
		if (d.config && typeof d.config === "object") out.data.config = d.config;
		if (typeof d.sqlQuery === "string") out.data.sqlQuery = d.sqlQuery;
		nodes.push(out);
	}

	const known = new Set(nodes.map((n) => n.id));
	const edges: SerializedEdge[] = raw.edges
		.filter((e: any) => e && known.has(e.source) && known.has(e.target))
		.map((e: any, i: number) => ({
			id: typeof e.id === "string" && e.id ? e.id : `edge_import_${i}`,
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle ?? null,
			targetHandle: e.targetHandle ?? null,
		}));

	return {
		format: WORKFLOW_FORMAT,
		version: Number(raw.version) || WORKFLOW_VERSION,
		title: typeof raw.title === "string" ? raw.title : "Untitled Workflow",
		exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
		nodes,
		edges,
	};
}
