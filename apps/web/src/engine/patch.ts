// apps/web/src/engine/patch.ts
// Hermes AST patch → 畫布節點/邊 的映射邏輯（純函數，無 React 依賴 → 可以獨立測試）。
//
// 本檔案存在的原因：這段邏輯出過一個致命 bug，而且是「後端與前端各自看起來
// 都沒問題、但合起來就靜靜地壞」的類型 —— 一定要有測試守住。
//
// 🐛 舊版 bug：
//     idByIndex.set(n.sourceIndex, n.id)   // key = number 0
//     idByIndex.has(ref.slice(1))          // 查 "0"（string）
//   Map 用 SameValueZero 比較，"0" !== 0 → 永遠 miss → 每條邊 fallback 成
//   字面值 "n0" → 全部邊都是懸空 → Hermes 生成的節點之間沒有任何連線，
//   每個節點都各自讀 raw_data，pipeline 等於沒有連過。

import type { Edge, Node } from "@xyflow/react";
// 稽核工具來自 @synapse/schema 的**主要**入口（零依賴，不拉 zod）。
// 需要真正的 schema 驗證時走子入口 "@synapse/schema/zod"。
import { auditAstPatch, type PatchIssue } from "@synapse/schema";
import { NODE_CATALOG, normalizeConfig } from "./nodeCatalog";
import type { AlteryxNodeType } from "../types/workbench";

export interface AstPatchNode {
	id?: string;
	sourceIndex?: number | string;
	type?: string;
	nodeType?: string;
	label?: string;
	config?: Record<string, any>;
	position?: { x: number; y: number };
}

export interface AstPatchEdge {
	source?: unknown;
	target?: unknown;
	targetHandle?: string;
}

export interface AstPatch {
	nodes?: AstPatchNode[];
	edges?: AstPatchEdge[];
}

export interface ResolvedNode {
	/** 後端使用的 ref（例如 "n0"），主要供 debug / log */
	ref: string;
	sourceIndex?: number | string;
	newNodeId: string;
	/** 邏輯節點類型（FILTER / SUMMARIZE / VIZ_CHART…） */
	nodeType: string;
	/** React Flow 節點類型（alteryxNode / vizChartNode…） */
	flowNodeType: string;
	label: string;
	config: Record<string, any>;
	position: { x: number; y: number };
}

export interface ResolvedEdge {
	source: string;
	target: string;
	targetHandle?: string;
}

export interface ResolutionResult {
	nodes: ResolvedNode[];
	edges: ResolvedEdge[];
	/** 因為對照不到節點而丟棄的邊數（> 0 應該 warn） */
	droppedEdges: number;
	/**
	 * 後端 payload 相對目錄的結構問題（未知型別、幻覺 config 鍵、非法 enum 值…）。
	 *
	 * 為什麼要有：`resolveAstPatch` 的設計是**寬鬆**的 —— 未知型別退回 FILTER、
	 * 未知鍵被 normalizeConfig 丟掉，好處是壞 payload 不會讓畫布整片掛掉，
	 * 代價是「後端給了錯的東西」這件事本身沒有任何痕跡。
	 * 這裡把那些痕跡留下來，交給呼叫端顯示，而不是靜默吞掉。
	 */
	issues: PatchIssue[];
}

const DEFAULT_NODE_TYPE = "FILTER";

/** 這個類型在目錄裡嗎？（後端過濾過一次，前端仍要自己擋 —— 舊版存檔也可能有壞值） */
export function isKnownNodeType(type: string): type is AlteryxNodeType {
	return Object.prototype.hasOwnProperty.call(NODE_CATALOG, type);
}

/**
 * 將 Hermes 的 patch 映射成真實節點 id 與邊。
 *
 * @param existingNodeIds 畫布上已存在的節點 id（容許 Hermes 延伸現有 DAG）
 * @param newNodeId       產生新節點 id 的函數（注入以便測試）
 */
export function resolveAstPatch(
	patch: AstPatch,
	existingNodeIds: Iterable<string>,
	newNodeId: () => string,
): ResolutionResult {
	const incoming = Array.isArray(patch?.nodes) ? patch.nodes : [];
	const existing = new Set(existingNodeIds);

	const nodes: ResolvedNode[] = incoming.map((pn, index) => {
		const raw = String(pn?.type || DEFAULT_NODE_TYPE).toUpperCase();
		// 未知類型 → 退回 FILTER（而不是讓它一路活到編譯器才靜默 passthrough）
		const type: AlteryxNodeType = isKnownNodeType(raw) ? raw : DEFAULT_NODE_TYPE;

		return {
			ref: String(pn?.id ?? ""),
			sourceIndex: pn?.sourceIndex,
			newNodeId: newNodeId(),
			nodeType: type,
			// 渲染器由目錄決定：VIZ_CHART 用專用圖表節點，其餘一律 Alteryx 卡片。
			// 舊版在這裡寫死 `type === "VIZ_CHART" ? ... : ...`，新增節點時
			// 只要不是圖表就剛好矇對，但一旦有第二種專用渲染器就會漏。
			flowNodeType: pn?.nodeType || NODE_CATALOG[type].nodeType,
			label: String(pn?.label || NODE_CATALOG[type].label),
			// 依目錄校正 config：丟掉幻覺欄位（LLM 很愛把 groupBy 寫成 groupby）、
			// 補上缺漏的預設值。舊版原封不動傳下去，錯的鍵要等到編譯才靜默失效。
			config: normalizeConfig(type, pn?.config),
			position: {
				x: pn?.position?.x ?? 400 + index * 40 + Math.random() * 60,
				y: pn?.position?.y ?? 120 + Math.random() * 100,
			},
		};
	});

	/**
	 * ref → 真實節點 id。
	 * 同時註冊後端的 ref（"n0"）與 sourceIndex（0 / "0"，一律 String() 正規化），
	 * 所以無論後端傳邊一種形式都對照得到。
	 */
	const idByRef = new Map<string, string>();
	nodes.forEach((n) => {
		if (n.ref) idByRef.set(n.ref, n.newNodeId);
		if (n.sourceIndex !== undefined && n.sourceIndex !== null) {
			idByRef.set(String(n.sourceIndex), n.newNodeId);
		}
	});

	const resolveRef = (ref: unknown): string | null => {
		const key = String(ref ?? "");
		if (!key) return null;
		const mapped = idByRef.get(key);
		if (mapped) return mapped;
		// 指向畫布上已存在的節點 → 保留原 id（延伸現有 DAG）
		if (existing.has(key)) return key;
		return null;
	};

	const edges: ResolvedEdge[] = [];
	let droppedEdges = 0;

	const incomingEdges = Array.isArray(patch?.edges) ? patch.edges : [];
	for (const pe of incomingEdges) {
		const source = resolveRef(pe?.source);
		const target = resolveRef(pe?.target);
		if (!source || !target || source === target) {
			droppedEdges += 1;
			continue;
		}
		edges.push({
			source,
			target,
			targetHandle: pe?.targetHandle,
		});
	}

	// 稽核的是**原始** payload（未經上面的型別退回與 config 正規化），
	// 否則 `SQL_CUSTOM → FILTER` 這種退化在事後就完全看不出來了。
	return { nodes, edges, droppedEdges, issues: auditAstPatch(patch) };
}

/** 幫解析結果掛上 React Flow 需要的欄位（type / animated / id） */
export function toFlowEdges(
	resolved: ResolvedEdge[],
	makeEdgeId: () => string,
	edgeType = "particleEdge",
): Edge[] {
	return resolved.map((e) => ({
		id: makeEdgeId(),
		source: e.source,
		target: e.target,
		type: edgeType,
		animated: true,
		targetHandle: e.targetHandle,
	}));
}

export type { Node };
