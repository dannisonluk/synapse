// apps/web/src/components/workbench/CommandPalette.tsx
//
// ⌘K 命令面板。
//
// 排序邏輯全部在 engine/palette.ts（純函式，可測）；這個元件只負責「輸入 → 顯示
// → 選取」。
//
// 為什麼要有：28 種節點用拖的已經開始吃力，而且「執行 / 匯出 / 跳到某節點」
// 目前只能靠滑鼠。搜尋語料是目錄的 whenToUse —— 那本來就是寫給 LLM 看的
// 自然語言描述，跟使用者會打的字是同一種語言。
//
// 這個檔案是**主題的參考實作**：沒有任何 `isLight ? ... : ...`，顏色一律來自
// `theme/ui.ts` 的語意常數（底層是 `--syn-*` CSS 變數）。兩套主題下版面、
// 字級、互動狀態完全一致，因為它們本來就是同一份 class。
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	rankActions,
	rankNodeTypes,
	type PaletteAction,
	type PaletteCandidate,
} from "../../engine/palette";
import { ui, TYPE } from "../../theme/ui";

/** 清單裡的一列：可能是節點，也可能是動作 */
type Row =
	| { kind: "node"; key: string; label: string; hint: string; type: string }
	| { kind: "action"; key: string; label: string; hint: string; id: string };

export interface CommandPaletteProps {
	open: boolean;
	onClose: () => void;
	/** 目錄的候選節點（由呼叫端從 nodeCatalog 投影出來） */
	candidates: readonly PaletteCandidate[];
	/** 可用的動作（執行 / 匯出 / 復原…） */
	actions: readonly PaletteAction[];
	/** 選了一個節點類型 → 呼叫端負責新增節點 */
	onPickNode: (type: string) => void;
	/** 選了一個動作 → 呼叫端負責執行 */
	onRunAction: (id: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
	open,
	onClose,
	candidates,
	actions,
	onPickNode,
	onRunAction,
}) => {
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// 每次打開都回到乾淨狀態 —— 上次打了一半的查詢不該留著
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setCursor(0);
		// 焦點要在下一個 frame 才抓得到（overlay 還沒掛上去）
		const t = setTimeout(() => inputRef.current?.focus(), 0);
		return () => clearTimeout(t);
	}, [open]);

	/**
	 * 節點排前面、動作排後面。
	 *
	 * 面板的主要用途是「加一個節點」，動作出現的頻率低得多；把動作放前面會讓
	 * 打「join」的人第一眼看到的是「匯出 SQL」。
	 */
	const rows = useMemo<Row[]>(() => {
		if (!open) return [];
		const nodes = rankNodeTypes(query, candidates, query.trim() ? 8 : 10).map(
			(h): Row => ({
				kind: "node",
				key: `n:${h.type}`,
				label: h.label,
				hint: `${h.category} · ${h.type}`,
				type: h.type,
			}),
		);
		const acts = rankActions(query, actions, query.trim() ? 5 : 6).map(
			(a): Row => ({
				kind: "action",
				key: `a:${a.id}`,
				label: a.label,
				hint: a.hint ?? "",
				id: a.id,
			}),
		);
		return [...nodes, ...acts];
	}, [open, query, candidates, actions]);

	// 查詢變了就把游標歸零，否則會停在一個已經不存在的索引上
	useEffect(() => {
		setCursor(0);
	}, [query]);

	// 讓選取的那一列保持可見（鍵盤操作時的必要條件）
	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	if (!open) return null;

	const commit = (row: Row) => {
		if (row.kind === "node") onPickNode(row.type);
		else onRunAction(row.id);
		onClose();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const row = rows[cursor];
			if (row) commit(row);
		}
	};

	return (
		// 遮罩：點外面關閉。深淺色都用同一個半透明黑 —— 它不是主題色，
		// 而是「把背景壓暗」這個動作本身。
		<div
			className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/35"
			onMouseDown={onClose}
			role="dialog"
			aria-modal="true"
			aria-label="命令面板"
		>
			<div
				// 面板本身不要冒泡到遮罩的 onMouseDown，否則點清單會關掉面板
				onMouseDown={(e) => e.stopPropagation()}
				className={`w-[460px] max-w-[92vw] rounded-lg border overflow-hidden ${ui.card} ${ui.border} ${ui.shadow}`}
			>
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="輸入節點名稱或動作…（例如 join / 下載 / 執行）"
					aria-label="搜尋節點或動作"
					className={`w-full px-3 py-2.5 ${TYPE.body} bg-transparent ${ui.text} placeholder:text-[var(--syn-text-muted)] focus:outline-none`}
				/>

				<div
					ref={listRef}
					className={`max-h-[340px] overflow-y-auto ${ui.divider}`}
					role="listbox"
				>
					{rows.length === 0 && (
						<div className={`px-3 py-5 ${TYPE.body} ${ui.textMuted}`}>
							沒有符合的節點或動作
						</div>
					)}

					{rows.map((row, i) => {
						const active = i === cursor;
						// 節點與動作之間插一條分隔標籤，讓兩類結果不會混在一起
						const showHeader = i === 0 || rows[i - 1].kind !== row.kind;
						return (
							<React.Fragment key={row.key}>
								{showHeader && (
									<div className={`px-3 pt-2.5 pb-1 ${TYPE.label} ${ui.textMuted}`}>
										{row.kind === "node" ? "節點" : "動作"}
									</div>
								)}
								<button
									type="button"
									data-row={i}
									role="option"
									aria-selected={active}
									// 用滑鼠移入更新游標，鍵盤與滑鼠才不會各有一套選取狀態
									onMouseEnter={() => setCursor(i)}
									onClick={() => commit(row)}
									className={`w-full text-left px-3 py-2 flex items-baseline justify-between gap-3 transition-colors ${
										active ? ui.active : ui.rowHover
									}`}
								>
									<span className={`${TYPE.body} ${ui.text}`}>{row.label}</span>
									<span className={`${TYPE.caption} font-mono shrink-0 ${ui.textMuted}`}>
										{row.hint}
									</span>
								</button>
							</React.Fragment>
						);
					})}
				</div>

				{/* 鍵盤提示。用 kbd 語意元素而不是純文字，螢幕閱讀器才讀得出來 */}
				<div
					className={`px-3 py-2 flex items-center gap-3 ${TYPE.caption} ${ui.textMuted} ${ui.divider}`}
				>
					<span>
						<kbd className="font-mono">↑↓</kbd> 選擇
					</span>
					<span>
						<kbd className="font-mono">Enter</kbd> 確認
					</span>
					<span>
						<kbd className="font-mono">Esc</kbd> 關閉
					</span>
				</div>
			</div>
		</div>
	);
};
