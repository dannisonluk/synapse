// apps/web/src/theme/tokens.ts
//
// 兩套主題的**唯一真相**。
//
// 為什麼要重做：舊版只有 11 個 token，而元件裡有 101 處 `isLight ? "..." : "..."`
// 的硬編碼 Tailwind class。那代表「配色」實際上散在五個檔案裡，token 只是
// 其中一部分 —— 兩套主題遲早會走樣，而且改一個顏色要改很多地方。
//
// 現在的做法：
//   1. token 是語意的（bgPanel / textMuted / accentSoft…），不是顏色的名字
//   2. token 會展開成 CSS 自訂屬性（`--syn-*`），元件用 `var(--syn-…)` 取用
//   3. 元件**不再判斷主題** —— 同一個 class 在兩套主題下都成立
//
// 配色取向：**傳統、常見的中性色系**。淺色是白／淺灰＋標準藍，深色是
// GitHub 那套石墨灰＋藍。沒有暖米色、沒有紫調底色、強調色不用高飽和橘 ——
// 那些在資料工具上會讓眼睛累，而且不容易通過對比度檢查。
//
// 本檔案不 import 任何東西，可以在 Node 裡直接測（對比度檢查就靠這點）。

export type ThemeMode = "light" | "dark";

export interface ThemeTokens {
	// --- 表面 ---
	/** 畫布底色（最底層） */
	bgCanvas: string;
	/** 面板／抽屜底色 */
	bgPanel: string;
	/** 卡片／節點底色 */
	bgCard: string;
	/** 輸入框底色 */
	bgInput: string;
	/** hover 態底色 */
	bgHover: string;
	/** 選取／按下態底色 */
	bgActive: string;
	/** 程式碼區塊底色（兩套主題都偏暗，見下面的說明） */
	bgCode: string;

	// --- 邊框 ---
	border: string;
	borderHover: string;
	/** 聚焦環（鍵盤操作要看得見） */
	borderFocus: string;

	// --- 文字 ---
	textPrimary: string;
	textSecondary: string;
	/** 第三層：提示、單位、次要說明 */
	textMuted: string;
	/** 放在 accent 底色上的文字 */
	textOnAccent: string;
	/** 程式碼區塊裡的文字 */
	textCode: string;

	// --- 強調色 ---
	accent: string;
	accentHover: string;
	/** 淡強調底（選取列、標籤底） */
	accentSoft: string;
	/** 淡強調底上的文字 */
	accentSoftText: string;

	// --- 語意色 ---
	danger: string;
	dangerSoft: string;
	success: string;
	successSoft: string;
	warning: string;
	warningSoft: string;

	// --- 畫布專用 ---
	gridColor: string;
	edgeStroke: string;
	edgeGlow: string;
	shadow: string;
}

/**
 * 淺色主題：白底 + 中性灰 + 標準藍。
 *
 * 這是開發工具裡最常見的一組（GitHub Light 系），好處是使用者不需要重新
 * 學習任何東西，而且對比度是別人已經調過的。
 */
const LIGHT: ThemeTokens = {
	bgCanvas: "#FFFFFF",
	bgPanel: "#F6F8FA",
	bgCard: "#FFFFFF",
	bgInput: "#FFFFFF",
	bgHover: "#F3F4F6",
	bgActive: "#EAEEF2",
	// 程式碼區塊在淺色主題下刻意仍用深底：SQL 的語法色是為深底調的，
	// 而且深底能讓「這是唯讀的程式碼，不是可編輯欄位」一眼可辨。
	bgCode: "#24292F",

	border: "#D0D7DE",
	borderHover: "#AFB8C1",
	borderFocus: "#0969DA",

	textPrimary: "#1F2328",
	// 三層文字刻意拉開（實測對比度，白底）：
	//   primary 15.0 : secondary 9.0 : muted 5.2
	// 舊版的 secondary #78716C 只有 4.6、muted 更低，而 muted 最常被用在
	// **10px 的提示文字**上 —— 小字需要的是更高的對比，不是更低。
	textSecondary: "#424A53",
	textMuted: "#656D76",
	textOnAccent: "#FFFFFF",
	textCode: "#C9D1D9",

	accent: "#0969DA",
	accentHover: "#0550AE",
	accentSoft: "#DDF4FF",
	accentSoftText: "#0550AE",

	danger: "#CF222E",
	dangerSoft: "#FFEBE9",
	success: "#1A7F37",
	successSoft: "#DAFBE1",
	warning: "#9A6700",
	warningSoft: "#FFF8C5",

	gridColor: "#EAEEF2",
	// 邊線用中性灰而不是強調色：一張 20 條線的圖如果全部是飽和藍，
	// 節點反而看不清楚。強調色留給「選中」與「主要動作」。
	edgeStroke: "#8C959F",
	edgeGlow: "rgba(9, 105, 218, 0.12)",
	shadow: "rgba(31, 35, 40, 0.12)",
};

/** 深色主題：石墨灰 + 藍。同一組語意，只換數值。 */
const DARK: ThemeTokens = {
	bgCanvas: "#0D1117",
	bgPanel: "#161B22",
	bgCard: "#1C2128",
	bgInput: "#0D1117",
	bgHover: "#21262D",
	bgActive: "#30363D",
	bgCode: "#0D1117",

	border: "#30363D",
	borderHover: "#484F58",
	borderFocus: "#2F81F7",

	textPrimary: "#E6EDF3",
	// 與淺色同一組層級：16.0 : 9.7 : 5.6（深底實測）
	//
	// muted 的值是被**對比度斷言**逼出來的：深色主題的 bgCard (#1C2128) 比
	// bgCanvas (#0D1117) 亮，所以同一個 muted 在卡片上只有 4.34，低於 AA。
	// 深色主題的「卡片比畫布亮」是刻意的（那是深色介面的常規），所以該調的是
	// 文字而不是卡片。
	textSecondary: "#B1BAC4",
	textMuted: "#848D97",
	textOnAccent: "#FFFFFF",
	textCode: "#C9D1D9",

	accent: "#1F6FEB",
	accentHover: "#388BFD",
	accentSoft: "#12283F",
	accentSoftText: "#79C0FF",

	danger: "#F85149",
	dangerSoft: "#3D1418",
	success: "#3FB950",
	successSoft: "#12261E",
	warning: "#D29922",
	warningSoft: "#2E2416",

	gridColor: "#21262D",
	edgeStroke: "#6E7681",
	edgeGlow: "rgba(47, 129, 247, 0.18)",
	shadow: "rgba(1, 4, 9, 0.6)",
};

export const themeTokens: Record<ThemeMode, ThemeTokens> = {
	light: LIGHT,
	dark: DARK,
};

export const DEFAULT_THEME: ThemeMode = "light";

/** 兩套主題必須定義**完全相同**的鍵，否則會出現「某個元件只在一個主題下壞掉」 */
export const TOKEN_KEYS: (keyof ThemeTokens)[] = Object.keys(LIGHT) as (keyof ThemeTokens)[];

// ---------------------------------------------------------------------------
// 顏色數學 —— 只為了對比度檢查，不是為了算圖
// ---------------------------------------------------------------------------

/** `#RGB` / `#RRGGBB` → [r, g, b]（0–255）。無法解析回 null */
export function parseHex(hex: unknown): [number, number, number] | null {
	const s = String(hex ?? "").trim().replace(/^#/, "");
	if (s.length === 3) {
		const [r, g, b] = s.split("");
		if (!/^[0-9a-f]{3}$/i.test(s)) return null;
		return [
			parseInt(r + r, 16),
			parseInt(g + g, 16),
			parseInt(b + b, 16),
		];
	}
	if (!/^[0-9a-f]{6}$/i.test(s)) return null;
	return [
		parseInt(s.slice(0, 2), 16),
		parseInt(s.slice(2, 4), 16),
		parseInt(s.slice(4, 6), 16),
	];
}

/** WCAG 相對亮度 */
export function relativeLuminance(hex: unknown): number | null {
	const rgb = parseHex(hex);
	if (!rgb) return null;
	const [r, g, b] = rgb.map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 對比度（1–21）。
 *
 * 這是**可以斷言**的部分：比起「看起來還行」，數字能守住「改配色時不要
 * 把可讀性弄壞」。回 null 表示有顏色解析不了。
 */
export function contrastRatio(a: unknown, b: unknown): number | null {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	if (la === null || lb === null) return null;
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把 token 展開成 CSS 自訂屬性。
 *
 * 鍵名 `bgPanel` → `--syn-bg-panel`。元件用 `var(--syn-bg-panel)` 取用，
 * 於是**不需要再判斷主題** —— 這是整個重構的重點。
 */
export function cssVariables(tokens: ThemeTokens): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(tokens)) {
		// camelCase → kebab-case
		const name = k.replace(/([A-Z])/g, "-$1").toLowerCase();
		out[`--syn-${name}`] = v;
	}
	return out;
}

/** 供驗證腳本使用：把 token 名轉成 CSS 變數名（單一真相） */
export function cssVariableName(key: string): string {
	return `--syn-${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
}
