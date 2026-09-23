// apps/web/src/theme/ui.ts
//
// 共用的 class 字串。
//
// 為什麼要有這一層：舊版把配色寫成 `isLight ? "bg-stone-50 border-stone-200"
// : "bg-slate-900 border-slate-800"`，在五個檔案裡出現 101 次。那等於配色散在
// 元件裡 —— 改一個顏色要改很多地方，而且兩套主題遲早會分岔（實際上也已經分岔了：
// 有些地方淺色用 stone、有些用 gray，深色有的 slate 有的 gray-900）。
//
// 現在元件寫 `ui.panel`，顏色來自 `--syn-*`，**不需要判斷主題**。
//
// ⚠ 這些字串必須是靜態的完整字面值：Tailwind 是在原始碼裡掃字串，
// 用模板拼接（`` `bg-[var(--syn-${x})]` ``）它掃不到，class 不會被產生。
//
// 用法：
//   <div className={`${ui.card} ${ui.border} p-3`}>
//
// 只放「跨元件重複」的東西。一次性的排版留在元件裡。

// ---------------------------------------------------------------------------
// 字體層級
// ---------------------------------------------------------------------------
//
// 四級，刻意收斂。舊版同時存在 9 / 10 / 11 / 12 / 13px 五種尺寸，而且是隨手
// 挑的 —— 沒有層級就沒有節奏，使用者要靠猜才知道哪個比較重要。
//
// **9px 退場**：它在一般 DPI 下已經低於可讀下限，而它最常被用在
// 「其實很重要的提示文字」上（例如「未設定左右鍵 → 這個節點會直接通過」）。
//
//   title   13px  節點標題、面板標題
//   body    12px  內文、按鈕文字
//   mono    11px  數值、SQL、識別字
//   caption 10px  次要說明、單位、提示
//
// 行高一律寫進常數：小字配大字距會鬆散、配小行高會擠，這兩個都是一起調的。
export const TYPE = {
	title: "text-[13px] font-semibold leading-snug",
	body: "text-[12px] leading-snug",
	mono: "font-mono text-[11px] leading-tight",
	caption: "text-[10px] leading-tight",
	/** 區塊標籤：小字＋全大寫＋字距，用來分段而不搶焦點 */
	label: "text-[10px] font-bold font-mono tracking-wider uppercase leading-tight",
} as const;

// ---------------------------------------------------------------------------
// 表面
// ---------------------------------------------------------------------------
export const ui = {
	// --- 表面 ---
	canvas: "bg-[var(--syn-bg-canvas)]",
	panel: "bg-[var(--syn-bg-panel)]",
	card: "bg-[var(--syn-bg-card)]",
	/** 節點表單裡的分組區塊：比卡片再退一階 */
	subtle: "bg-[var(--syn-bg-panel)]",
	/** 選取／按下 */
	active: "bg-[var(--syn-bg-active)]",
	/** 列 hover（用在清單項） */
	rowHover: "hover:bg-[var(--syn-bg-hover)]",
	/** 程式碼區塊：兩套主題都偏暗，見 tokens.ts 的說明 */
	code: "bg-[var(--syn-bg-code)] text-[var(--syn-text-code)]",
	/** 淡強調底（標籤、選取提示） */
	accentSoft: "bg-[var(--syn-accent-soft)] text-[var(--syn-accent-soft-text)]",

	// --- 邊框 ---
	border: "border-[var(--syn-border)]",
	borderHover: "hover:border-[var(--syn-border-hover)]",
	/**
	 * 鍵盤聚焦環。
	 *
	 * 一定要用 `focus-visible` 而不是 `focus`：滑鼠點擊不該留下一個環，
	 * 而鍵盤操作**必須**看得見焦點在哪 —— 那是無障礙的底線。
	 */
	focusRing:
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--syn-border-focus)] focus-visible:ring-offset-0",

	// --- 文字 ---
	text: "text-[var(--syn-text-primary)]",
	textSecondary: "text-[var(--syn-text-secondary)]",
	textMuted: "text-[var(--syn-text-muted)]",
	textDanger: "text-[var(--syn-danger)]",
	textSuccess: "text-[var(--syn-success)]",
	textWarning: "text-[var(--syn-warning)]",

	// --- 陰影 ---
	/** 面板／浮層 */
	shadow: "shadow-[0_2px_8px_var(--syn-shadow)]",
	/** 卡片：比面板輕 */
	shadowSm: "shadow-[0_1px_2px_var(--syn-shadow)]",

	// --- 互動元件 ---
	/** 工具列按鈕：中性底 + 邊框，主要動作才用 accent */
	btn: "inline-flex items-center gap-1.5 border border-[var(--syn-border)] bg-[var(--syn-bg-card)] text-[var(--syn-text-primary)] text-[12px] px-3 py-1.5 rounded-md shadow-[0_1px_2px_var(--syn-shadow)] hover:bg-[var(--syn-bg-hover)] transition-colors font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--syn-border-focus)] disabled:opacity-45 disabled:pointer-events-none",
	/** 主要動作（一頁只有一個） */
	btnPrimary:
		"inline-flex items-center gap-1.5 border border-transparent bg-[var(--syn-accent)] text-[var(--syn-text-on-accent)] text-[12px] px-3 py-1.5 rounded-md shadow-[0_1px_2px_var(--syn-shadow)] hover:bg-[var(--syn-accent-hover)] transition-colors font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--syn-border-focus)] disabled:opacity-45 disabled:pointer-events-none",
	/** 圖示按鈕（無邊框，hover 才出現底） */
	btnIcon:
		"inline-flex items-center justify-center p-1 rounded text-[var(--syn-text-secondary)] hover:bg-[var(--syn-bg-hover)] hover:text-[var(--syn-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--syn-border-focus)]",
	/** 純文字按鈕（連結感） */
	btnLink:
		"inline-flex items-center gap-1 text-[var(--syn-accent)] hover:text-[var(--syn-accent-hover)] underline-offset-2 hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--syn-border-focus)] rounded",

	/** 文字輸入／下拉：與 btn 同一組高度與圓角 */
	input:
		"w-full px-2 py-1 rounded-md border border-[var(--syn-border)] bg-[var(--syn-bg-input)] text-[var(--syn-text-primary)] text-[12px] font-mono placeholder:text-[var(--syn-text-muted)] focus:outline-none focus:border-[var(--syn-border-focus)] focus:ring-1 focus:ring-[var(--syn-border-focus)] transition-colors",

	/**
	 * 節點表單裡的**緊湊版**輸入框。
	 *
	 * 只給顏色與焦點態，尺寸（padding / text size / width）由呼叫端決定 ——
	 * 節點表單的欄位寬度是逐個調的（有的要 flex-1，有的固定），
	 * 硬塞一個尺寸進去只會被覆蓋，而 Tailwind 的覆蓋順序取決於 CSS 產生順序，
	 * 不是 class 的書寫順序 —— 那是「有時候有效」的來源。
	 */
	inputSm:
		"rounded border border-[var(--syn-border)] bg-[var(--syn-bg-input)] text-[var(--syn-text-primary)] font-mono placeholder:text-[var(--syn-text-muted)] focus:outline-none focus:border-[var(--syn-border-focus)] transition-colors",

	/** 可選取的小標籤（chip）：未選取 */
	chip:
		"rounded border border-[var(--syn-border)] bg-[var(--syn-bg-card)] text-[var(--syn-text-secondary)] opacity-70 hover:opacity-100 transition-colors",
	/** 可選取的小標籤：已選取。用 accent 而不是第四個顏色 —— */
	/** 顏色愈少，「選中」愈明顯。 */
	chipOn:
		"rounded border border-[var(--syn-accent)] bg-[var(--syn-accent-soft)] text-[var(--syn-accent-soft-text)] transition-colors",

	/** 分隔線 */
	divider: "border-t border-[var(--syn-border)]",
} as const;
