// packages/synapse-schema/src/audit.ts
// 以目錄為依據的 payload 稽核（**零依賴**，不碰 zod）。
//
// 為什麼要跟 zod 分開放：畫布前端只想在套用 LLM 產生的 pipeline 之前
// 「問幾個關於目錄的問題」（這個型別存在嗎？有沒有幻覺欄位？enum 值合法嗎？），
// 這些全部是對 generated.ts 的純資料查表，不需要任何驗證框架。
// 若把它跟 zod schema 放在同一個模組，前端就會為了查表而把 zod 打包進 bundle。
// 所以 zod 版 schema 另開 `@synapse/schema/zod` 入口，只有後端 / 驗證腳本用。
import { NODE_FIELDS, NODE_TYPES, type NodeType } from "./generated";

const TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

/** 這個字串是目錄裡的節點型別嗎？（同時也是 type guard） */
export function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && TYPE_SET.has(value);
}

function asConfig(config: unknown): Record<string, unknown> {
	return config && typeof config === "object" && !Array.isArray(config)
		? (config as Record<string, unknown>)
		: {};
}

/** 目錄沒宣告、但 config 裡出現的鍵（LLM 幻覺欄位，例如把 groupBy 寫成 groupby） */
export function unknownConfigKeys(type: NodeType, config: unknown): string[] {
	const known = new Set(NODE_FIELDS[type].map((f) => f.name));
	return Object.keys(asConfig(config)).filter((k) => !known.has(k));
}

/** 目錄標為 required、但 config 沒有實質值的欄位（空字串視為沒填） */
export function missingRequiredFields(type: NodeType, config: unknown): string[] {
	const cfg = asConfig(config);
	return NODE_FIELDS[type]
		.filter((f) => f.required)
		.map((f) => f.name)
		.filter((name) => {
			const v = cfg[name];
			return v === undefined || v === null || v === "";
		});
}

/** enum 欄位收到合法值以外的東西 */
export function invalidEnumFields(
	type: NodeType,
	config: unknown,
): Array<{ field: string; value: unknown; allowed: readonly string[] }> {
	const cfg = asConfig(config);
	const out: Array<{ field: string; value: unknown; allowed: readonly string[] }> = [];
	for (const f of NODE_FIELDS[type]) {
		if (f.kind !== "enum" || !f.values || f.values.length === 0) continue;
		const v = cfg[f.name];
		if (v === undefined || v === null || v === "") continue;
		if (typeof v !== "string" || !f.values.includes(v)) {
			out.push({ field: f.name, value: v, allowed: f.values });
		}
	}
	return out;
}

export type PatchIssueKind = "malformed" | "unknown-type" | "unknown-key" | "missing-required" | "bad-enum";

export interface PatchIssue {
	/** 節點在 patch.nodes 中的索引；-1 表示整份 patch 層級的錯誤 */
	nodeIndex: number;
	/** 後端給的 ref（"n0"…），主要供訊息顯示 */
	nodeId: string;
	kind: PatchIssueKind;
	detail: string;
}

/**
 * 稽核一份後端回來的 AST patch，回傳**所有**問題（而不是第一個）。
 *
 * 為什麼不直接用 zod 然後 early-return：這裡的用途是「套用前先把可疑之處
 * 一次講清楚」，所以刻意收集全部問題。真正的 schema 驗證請用
 * `@synapse/schema/zod` 的 AstPatchSchema。
 *
 * 不回傳 boolean —— 呼叫端通常想把問題原文寫進 log / 提示，所以直接把
 * 問題清單給他，空陣列即代表乾淨。
 */
export function auditAstPatch(patch: unknown): PatchIssue[] {
	const issues: PatchIssue[] = [];
	const nodes = (patch as { nodes?: unknown } | null | undefined)?.nodes;

	if (!Array.isArray(nodes)) {
		return [{ nodeIndex: -1, nodeId: "", kind: "malformed", detail: "patch.nodes 不是陣列" }];
	}

	nodes.forEach((n, index) => {
		if (!n || typeof n !== "object") {
			issues.push({ nodeIndex: index, nodeId: "", kind: "malformed", detail: "節點不是物件" });
			return;
		}
		const raw = n as Record<string, unknown>;
		const nodeId = String(raw.id ?? raw.sourceIndex ?? "");
		const rawType = String(raw.type ?? "");

		if (!isNodeType(rawType)) {
			issues.push({
				nodeIndex: index,
				nodeId,
				kind: "unknown-type",
				detail: `型別 "${rawType || "(空)"}" 不在節點目錄內`,
			});
			// 型別都不認識了，config 的欄位清單也就無從比對
			return;
		}

		const cfg = raw.config;
		const unknown = unknownConfigKeys(rawType, cfg);
		if (unknown.length) {
			issues.push({
				nodeIndex: index,
				nodeId,
				kind: "unknown-key",
				detail: `${rawType} 不接受 config 鍵：${unknown.join(", ")}`,
			});
		}

		const missing = missingRequiredFields(rawType, cfg);
		if (missing.length) {
			issues.push({
				nodeIndex: index,
				nodeId,
				kind: "missing-required",
				detail: `${rawType} 缺少必填欄位：${missing.join(", ")}`,
			});
		}

		for (const bad of invalidEnumFields(rawType, cfg)) {
			issues.push({
				nodeIndex: index,
				nodeId,
				kind: "bad-enum",
				detail: `${rawType}.${bad.field} = ${JSON.stringify(bad.value)}，合法值：${bad.allowed.join(" | ")}`,
			});
		}
	});

	return issues;
}
