// apps/web/src/engine/scheduler.ts
// Synapse Topological Pipeline Scheduler (Kahn's Algorithm)
//   1. 全 DAG 拓撲排序（Kahn's Algorithm，cycle 安全）
//   2. 子圖執行：點擊任何節點 → 只執行該節點及其全部上游（祖先可達集）
//   3. JOIN 左/右埠排序（targetHandle = "left" 優先於 "right"）
import { Node, Edge } from "@xyflow/react";

export interface ExecLogEntry {
	ts: number;
	/**
	 * SKIP = 這個節點「沒有執行」，因為它的輸入與上次完全相同（執行快取命中）。
	 *
	 * 這必須是一個獨立等級而不是混進 INFO：快取命中如果看不出來，使用者會
	 * 以為資料是新的。那是快取最危險的失敗形態 —— 靜默地給出舊結果。
	 */
	level: "INFO" | "SQL" | "SUCCESS" | "ERROR" | "CHAOS" | "SKIP";
	message: string;
	nodeId?: string;
	durationMs?: number;
	rows?: number;
}

export interface PipelineExecResult {
	ok: boolean;
	order: string[]; // 已執行節點 id（拓撲序）
	logs: ExecLogEntry[];
}

/**
 * Kahn's Algorithm 拓撲排序。回傳 null 表示圖含 cycle（不可執行）。
 *
 * ⚠️ 核心陷阱（舊版的致命 bug）：判斷節點是否存在**必須**用 Set / `in`，
 * 不可依賴 truthiness。inDegree 的初始值是 0，而 `!0 === true`，所以舊寫法
 *
 *     if (!inDegree[e.target] || !adj[e.source]) return;   // ← 錯誤
 *
 * 會讓**每一條邊**都被靜默丟棄（因為所有節點一開始 inDegree 都是 0）。
 * 後果：排序結果退化成 id 字母序 → 下游節點先於上游執行 → 多節點鏈讀到
 * 過期資料；同時 cycle 永遠偵測不到。這正是「拓撲執行不存在」的真正根因。
 */
export function topologicalSort(
	nodeIds: string[],
	edges: Edge[],
): string[] | null {
	const known = new Set(nodeIds);
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();

	nodeIds.forEach((id) => {
		inDegree.set(id, 0);
		adj.set(id, []);
	});

	// 同一對 (source → target) 只計一次：JOIN 的左/右埠可能來自同一個上游，
	// 重複計數會讓 inDegree 永遠降不到 0，整條鏈卡死。
	const counted = new Set<string>();
	edges.forEach((e) => {
		if (!known.has(e.source) || !known.has(e.target)) return; // 忽略懸空邊
		const key = `${e.source}\u0000${e.target}`;
		if (counted.has(key)) return;
		counted.add(key);
		inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
		adj.get(e.source)!.push(e.target);
	});

	// 初始隊列排序 → 同一張圖的執行順序具確定性（方便重現 / debug）
	const queue = nodeIds
		.filter((id) => inDegree.get(id) === 0)
		.sort((a, b) => a.localeCompare(b));
	const order: string[] = [];

	while (queue.length > 0) {
		const curr = queue.shift()!;
		order.push(curr);
		for (const next of adj.get(curr) ?? []) {
			const deg = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, deg);
			if (deg === 0) queue.push(next);
		}
	}

	// 長度不等於節點數 → 有節點永遠進不了隊列 → 圖含 cycle
	return order.length === nodeIds.length ? order : null;
}

/**
 * 計算 nodeId 的「祖先可達集」（含自己），用於子圖執行。
 */
export function getAncestorClosure(
	nodeId: string,
	allNodes: Node[],
	edges: Edge[],
): Node[] {
	const nodeIds = allNodes.map((n) => n.id);
	const known = new Set(nodeIds);
	const reverseAdj = new Map<string, string[]>();
	nodeIds.forEach((id) => reverseAdj.set(id, []));
	edges.forEach((e) => {
		if (reverseAdj.has(e.target) && known.has(e.source)) {
			reverseAdj.get(e.target)!.push(e.source);
		}
	});

	const visited = new Set<string>();
	const stack = [nodeId];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (visited.has(cur)) continue;
		visited.add(cur);
		for (const src of reverseAdj.get(cur) ?? []) {
			if (!visited.has(src)) stack.push(src);
		}
	}

	return allNodes.filter((n) => visited.has(n.id));
}

/**
 * 以拓撲序排序一個節點子集（execution-ready）。
 * 回傳 null 表示子圖含 cycle。
 */
export function sortSubgraphTopologically(
	nodes: Node[],
	edges: Edge[],
): Node[] | null {
	const idSet = new Set(nodes.map((n) => n.id));
	const relevantEdges = edges.filter(
		(e) => idSet.has(e.source) && idSet.has(e.target),
	);
	const order = topologicalSort(nodes.map((n) => n.id), relevantEdges);
	if (!order) return null;
	const byId = new Map(nodes.map((n) => [n.id, n]));
	return order.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * 取得指向某節點的上游邊，並依「JOIN 左右埠」排序（left 優先）。
 *
 * 回傳 Edge 而不只是 source id，是因為 FILTER 節點有 true/false 兩個輸出埠，
 * 下游必須靠 `sourceHandle` 才能知道自己接的是哪一個分支
 * （見 astCompiler.branchTableName）。
 */
export function orderUpstreamEdges(nodeId: string, edges: Edge[]): Edge[] {
	return edges
		.filter((e) => e.target === nodeId)
		.sort((a, b) => {
			const aIsLeft = a.targetHandle === "left";
			const bIsLeft = b.targetHandle === "left";
			if (aIsLeft !== bIsLeft) return aIsLeft ? -1 : 1;
			return 0; // 保持 edges 原有順序
		});
}

/** JOIN 節點上游排序：targetHandle "left" 優先（左表在前）。 */
export function orderUpstreamSources(nodeId: string, edges: Edge[]): string[] {
	return orderUpstreamEdges(nodeId, edges).map((e) => e.source);
}

/**
 * 找出「因為某個上游失敗而不應該執行」的節點集合。
 * 用途：上游失敗後不可繼續執行下游，否則下游會靜默讀到過期表 → 結果錯誤。
 */
export function findDescendants(
	failedIds: Iterable<string>,
	nodes: Node[],
	edges: Edge[],
): Set<string> {
	const known = new Set(nodes.map((n) => n.id));
	const adj = new Map<string, string[]>();
	known.forEach((id) => adj.set(id, []));
	edges.forEach((e) => {
		if (adj.has(e.source) && known.has(e.target)) {
			adj.get(e.source)!.push(e.target);
		}
	});

	const blocked = new Set<string>();
	const stack = [...failedIds];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		for (const next of adj.get(cur) ?? []) {
			if (!blocked.has(next)) {
				blocked.add(next);
				stack.push(next);
			}
		}
	}
	return blocked;
}

export function makeExecLog(
	level: ExecLogEntry["level"],
	message: string,
	extra?: Partial<ExecLogEntry>,
): ExecLogEntry {
	return { ts: Date.now(), level, message, ...extra };
}
