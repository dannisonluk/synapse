// apps/web/src/components/workbench/PatchPreviewPanel.tsx
//
// Hermes patch 的套用前預覽。
//
// 為什麼要有：`resolveAstPatch` 是寬鬆的（未知型別退回 FILTER、未知鍵丟掉），
// 所以一份壞 payload 會讓畫布安靜地變成「跟 AI 說的不一樣」的樣子。
// 使用者只看到節點出現了，看不出其中有東西被改寫。
//
// 這個面板把「會新增什麼、每一句是什麼意思、哪裡與目錄不符」一次講清楚，
// 由使用者決定要不要套用。
//
// 顏色一律走 `--syn-*`（見 theme/ui.ts），所以兩套主題下行為一致。
import React from "react";
import type { PatchPreview } from "../../engine/patchPreview";
import { ui, TYPE } from "../../theme/ui";

export interface PatchPreviewPanelProps {
	open: boolean;
	preview: PatchPreview | null;
	/** 使用者按下「套用」 */
	onApply: () => void;
	/** 使用者按下「捨棄」或關閉 */
	onDiscard: () => void;
}

const SEVERITY_STYLE: Record<string, string> = {
	info: ui.text,
	warn: "text-[var(--syn-warning)]",
	error: "text-[var(--syn-danger)]",
};

const SEVERITY_MARK: Record<string, string> = {
	info: "•",
	warn: "⚠",
	error: "✕",
};

export const PatchPreviewPanel: React.FC<PatchPreviewPanelProps> = ({
	open,
	preview,
	onApply,
	onDiscard,
}) => {
	if (!open || !preview) return null;

	// Escape 關閉 = 捨棄。用 keydown 而不是只在按鈕上處理，
	// 因為這是一個模態：鍵盤使用者不該被迫用滑鼠找按鈕。
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onDiscard();
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/35"
			onMouseDown={onDiscard}
			onKeyDown={onKeyDown}
			role="dialog"
			aria-modal="true"
			aria-label="套用前的變更預覽"
		>
			<div
				onMouseDown={(e) => e.stopPropagation()}
				className={`w-[560px] max-w-[94vw] max-h-[70vh] flex flex-col rounded-lg border overflow-hidden ${ui.card} ${ui.border} ${ui.shadow}`}
			>
				<div className={`px-3 py-2 ${ui.divider}`}>
					<div className={`${TYPE.title} ${ui.text}`}>即將套用的變更</div>
					<div className={`${TYPE.caption} ${ui.textMuted} mt-0.5`}>
						新增 {preview.nodeCount} 個節點、{preview.edgeCount} 條連線
						{preview.droppedEdges > 0 ? `，丟棄 ${preview.droppedEdges} 條連線` : ""}
						{preview.issueCount > 0 ? `，${preview.issueCount} 處與節點目錄不符` : ""}
					</div>
				</div>

				<div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
					{preview.items.length === 0 && (
						<div className={`${TYPE.body} ${ui.textMuted}`}>沒有變更。</div>
					)}
					{preview.items.map((item, i) => (
						<div
							key={i}
							className={`flex items-start gap-1.5 ${TYPE.caption} ${SEVERITY_STYLE[item.severity]}`}
						>
							<span className="shrink-0 font-mono">{SEVERITY_MARK[item.severity]}</span>
							<span className="break-words">{item.text}</span>
						</div>
					))}
				</div>

				{/* 有 error 級問題時把按鈕標成「仍然套用」——
				    預設動作不該是「照著一份已知有問題的 payload 改畫布」。 */}
				<div className={`px-3 py-2 flex items-center justify-end gap-2 ${ui.divider}`}>
					{!preview.canApply && (
						<span className={`${TYPE.caption} ${ui.textDanger} mr-auto`}>
							有節點會退化成其他型別 —— 建議先看過再決定
						</span>
					)}
					<button type="button" onClick={onDiscard} className={ui.btn}>
						捨棄
					</button>
					<button
						type="button"
						onClick={onApply}
						autoFocus
						className={preview.canApply ? ui.btnPrimary : ui.btn}
					>
						{preview.canApply ? "套用" : "仍然套用"}
					</button>
				</div>
			</div>
		</div>
	);
};
