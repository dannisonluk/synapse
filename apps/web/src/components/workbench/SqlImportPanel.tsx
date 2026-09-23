// apps/web/src/components/workbench/SqlImportPanel.tsx
//
// 貼上一段 SQL → 轉成畫布節點。
//
// 解析在後端做（需要 sqlglot）。這個元件只負責「輸入 → 呼叫 → 把結果交給
// patch 預覽面板」。
//
// **刻意不在這裡直接套用**：轉換結果會經過與 Hermes 完全相同的預覽流程，
// 所以「SQL 匯入」與「AI 產生」的信任機制是同一套，而不是兩套。
import React, { useState } from "react";
import { ui, TYPE } from "../../theme/ui";
import type { AstPatch } from "../../engine/patch";

export interface SqlImportResult {
	/** 與 `engine/patch.ts` 的 `AstPatch` 同一個形狀，所以可以直接餵給 resolveAstPatch */
	patch: AstPatch;
	/** 轉換過程的說明（例如「有 2 處無法轉換」） */
	notes: string[];
	/** **沒有**進入這張圖的語句。這是重點：認不出來的不會硬塞一個節點型別。 */
	unhandled: string[];
}

export interface SqlImportPanelProps {
	open: boolean;
	onClose: () => void;
	/** 轉換成功 → 交給呼叫端去解析與預覽 */
	onImported: (result: SqlImportResult) => void;
}

/** 後端位址與 chaos / hermes 一致（見 NymphCanvas 的 chaosRepair） */
const API = "http://localhost:8000/api/v1/sql/import";

export const SqlImportPanel: React.FC<SqlImportPanelProps> = ({
	open,
	onClose,
	onImported,
}) => {
	const [sql, setSql] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!open) return null;

	const run = async () => {
		if (!sql.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sql }),
			});
			if (!res.ok) {
				// 後端離線是最常見的情況 —— 講清楚是「連不上」而不是「SQL 有錯」，
				// 否則使用者會一直改一段本來就沒問題的 SQL。
				setError(
					res.status === 0 || res.status >= 500
						? `後端沒有回應（HTTP ${res.status}）—— 請確認 apps/server 正在執行。`
						: `匯入失敗（HTTP ${res.status}）`,
				);
				return;
			}
			const body = await res.json();
			onImported({
				patch: body.patch ?? { nodes: [], edges: [] },
				notes: body.notes ?? [],
				unhandled: body.unhandled ?? [],
			});
			setSql("");
			onClose();
		} catch (err: any) {
			setError(
				`連不上後端：${err?.message || err} —— 匯入 SQL 需要 sqlglot，那是後端套件。`,
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/35"
			onMouseDown={onClose}
			role="dialog"
			aria-modal="true"
			aria-label="匯入 SQL"
		>
			<div
				onMouseDown={(e) => e.stopPropagation()}
				className={`w-[620px] max-w-[94vw] rounded-lg border overflow-hidden ${ui.card} ${ui.border} ${ui.shadow}`}
			>
				<div className={`px-3 py-2 ${ui.divider}`}>
					<div className={`${TYPE.title} ${ui.text}`}>匯入 SQL</div>
					<div className={`${TYPE.caption} ${ui.textMuted} mt-0.5`}>
						貼上一段 SQL（支援 WITH / SELECT 家族）。轉換結果會先經過預覽，
						確認後才套用到畫布。
					</div>
				</div>

				<textarea
					value={sql}
					onChange={(e) => setSql(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							onClose();
						}
						// ⌘/Ctrl+Enter 送出 —— 在一個多行輸入框裡，Enter 必須能換行
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void run();
						}
					}}
					rows={12}
					autoFocus
					placeholder={"WITH filtered AS (\n  SELECT * FROM sales WHERE amount > 1000\n)\nSELECT * FROM filtered;"}
					className={`w-full px-3 py-2 ${TYPE.mono} bg-[var(--syn-bg-input)] text-[var(--syn-text-primary)] placeholder:text-[var(--syn-text-muted)] focus:outline-none resize-y`}
				/>

				{error && (
					<div className={`px-3 py-2 ${TYPE.caption} ${ui.textDanger} break-all`}>
						{error}
					</div>
				)}

				<div className={`px-3 py-2 flex items-center justify-end gap-2 ${ui.divider}`}>
					<span className={`${TYPE.caption} ${ui.textMuted} mr-auto`}>
						<kbd className="font-mono">⌘Enter</kbd> 匯入 · <kbd className="font-mono">Esc</kbd> 關閉
					</span>
					<button type="button" onClick={onClose} className={ui.btn}>
						取消
					</button>
					<button
						type="button"
						onClick={() => void run()}
						disabled={busy || !sql.trim()}
						className={ui.btnPrimary}
					>
						{busy ? "轉換中…" : "轉換並預覽"}
					</button>
				</div>
			</div>
		</div>
	);
};
