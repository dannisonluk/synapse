// apps/web/src/engine/patchPreview.ts
//
// 把一份 Hermes patch 的解析結果轉成「套用前給人看的摘要」。
//
// 為什麼要有：`resolveAstPatch` 的設計是**寬鬆**的（未知型別退回 FILTER、
// 未知鍵丟掉），好處是壞 payload 不會讓畫布整片掛掉。代價是**畫布會安靜地變成
// 一個跟 AI 說的不一樣的樣子** —— 使用者只看到節點出現了，看不出其中有東西被改寫。
//
// 所以套用前先講清楚：會新增什麼、每一句是什麼意思、哪裡與目錄不符。
//
// 嚴重性的分法刻意不對稱：
//   - `unknown-type` → **error**：節點會變成 FILTER，也就是做一件跟要求不同的事
//   - `unknown-key` / `bad-enum` → warn：節點仍做對的事，只是少了／換了某個參數
// 這個區別讓「可以直接按套用」與「先看一眼」有客觀依據，而不是憑感覺。
//
// 本檔案只 import engine 模組，可以在 Node 裡直接測。

import type { PatchIssue } from "@synapse/schema";
import type { ResolutionResult } from "./patch";
import { narrateNode } from "./narrate";

export type PreviewSeverity = "info" | "warn" | "error";

export interface PatchPreviewItem {
	severity: PreviewSeverity;
	text: string;
}

export interface PatchPreview {
	nodeCount: number;
	edgeCount: number;
	droppedEdges: number;
	issueCount: number;
	items: PatchPreviewItem[];
	/** 有 error 級項目 → 不該直接套用（仍然可以，但使用者要先看到） */
	canApply: boolean;
}

/** 問題種類 → 嚴重性。見檔頭的說明：差別在「節點還做不做對的事」。 */
const ISSUE_SEVERITY: Record<PatchIssue["kind"], PreviewSeverity> = {
	// payload 本身壞掉（不是物件、nodes 不是陣列…）
	malformed: "error",
	// 型別不在目錄裡 → 會退化成 FILTER，做的**不是**被要求的事
	"unknown-type": "error",
	// 幻覺 config 鍵 → 被丟掉，其餘照做
	"unknown-key": "warn",
	// 必填欄位缺 → 用預設值，通常可以接受
	"missing-required": "warn",
	// 非法 enum → 退回預設值，節點仍運作但行為與要求不同
	"bad-enum": "warn",
};

/** 問題種類的中文標籤（顯示用；缺漏就退回原字串） */
const ISSUE_LABEL: Record<PatchIssue["kind"], string> = {
	malformed: "payload 結構錯誤",
	"unknown-type": "未知節點類型",
	"unknown-key": "未知設定欄位",
	"missing-required": "缺少必填欄位",
	"bad-enum": "非法的選項值",
};

export function issueSeverity(kind: string): PreviewSeverity {
	return ISSUE_SEVERITY[kind as PatchIssue["kind"]] ?? "warn";
}

/**
 * 產生摘要。
 *
 * 節點用 `narrateNode` 描述 —— 與匯出腳本裡的註解是同一句話，所以
 * 「AI 說要做的」「畫布上真的做的」「匯出後會做的」三者用同一套語言表達。
 */
export function buildPatchPreview(resolved: ResolutionResult): PatchPreview {
	const items: PatchPreviewItem[] = [];

	for (const n of resolved.nodes) {
		const narration = narrateNode({
			type: n.nodeType,
			config: n.config ?? {},
			// patch 裡的邊還沒接上，所以用 ref 顯示「上游是 n0」這種說法
			upstreamLabels: [],
		});
		items.push({
			severity: "info",
			text: `新增「${n.label || n.newNodeId}」（${n.nodeType}）：${narration}`,
		});
	}

	for (const e of resolved.edges) {
		// 邊的兩端用 ref（n0 → n1）表示，因為節點 id 是剛生成的
		items.push({
			severity: "info",
			text: `連線 ${e.source} → ${e.target}${e.targetHandle ? `（${e.targetHandle} 埠）` : ""}`,
		});
	}

	if (resolved.droppedEdges > 0) {
		items.push({
			severity: "warn",
			text: `有 ${resolved.droppedEdges} 條連線對不到節點，已丟棄（避免懸空連線）`,
		});
	}

	for (const issue of resolved.issues) {
		items.push({
			severity: issueSeverity(issue.kind),
			text: `${ISSUE_LABEL[issue.kind as PatchIssue["kind"]] ?? issue.kind}：${issue.detail}`,
		});
	}

	return {
		nodeCount: resolved.nodes.length,
		edgeCount: resolved.edges.length,
		droppedEdges: resolved.droppedEdges,
		issueCount: resolved.issues.length,
		items,
		canApply: items.every((i) => i.severity !== "error"),
	};
}

/** 一行摘要（給通知列用） */
export function summarizePreview(p: PatchPreview): string {
	const parts = [`新增 ${p.nodeCount} 個節點、${p.edgeCount} 條連線`];
	if (p.droppedEdges > 0) parts.push(`丟棄 ${p.droppedEdges} 條對不上的連線`);
	if (p.issueCount > 0) parts.push(`${p.issueCount} 處與節點目錄不符`);
	return parts.join("，");
}
