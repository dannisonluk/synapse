// apps/web/src/theme/ThemeContext.tsx
//
// 主題的提供者。顏色本身在 tokens.ts，這裡只負責「現在是哪一套」與「怎麼套上去」。
//
// 三個改變：
//
// 1. **模式名稱改成 light / dark。** 舊的 `claude-light` / `github-dark` 是
//    用品牌命名的，但配色已經改成中性色系，名字會誤導人（而且「claude-light」
//    現在既不特別暖也不是 Claude 的配色）。
//
// 2. **元件不再判斷主題。** token 會展開成 CSS 自訂屬性（`--syn-*`）掛在最外層，
//    子孫用 `var(--syn-bg-panel)` 取用。舊版有 101 處
//    `isLight ? "bg-stone-50" : "bg-slate-900"` —— 那等於把配色散在元件裡，
//    兩套主題遲早會走樣。
//
// 3. **偏好會被記住，而且第一次跟隨系統。** 舊版每次重新載入都回到淺色。
//
// 仍然保留 `isLight` 與 `tokens`：前者給少數真的需要分支的地方（例如圖表要
// 換一套色階），後者給需要實際色值的 inline style。但**新程式碼應該優先
// 用 CSS 變數**，那才是兩套主題不會分岔的保證。
import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	cssVariables,
	themeTokens,
	DEFAULT_THEME,
	type ThemeMode,
	type ThemeTokens,
} from "./tokens";
import { loadTheme, saveTheme } from "../engine/persistence";

export type { ThemeMode, ThemeTokens };
export { themeTokens, DEFAULT_THEME };

/** 可注入的 matchMedia，讓「跟隨系統」這件事可以在 Node 裡測 */
export type MatchMediaLike = (query: string) => { matches: boolean } | null;

/**
 * 系統偏好的主題。
 *
 * 沒有 matchMedia（SSR、舊瀏覽器、測試環境）時回 false —— 回「淺色」是
 * 刻意的：淺色在列印與截圖時比較不會失真，當成預設比較安全。
 */
export function systemPrefersDark(matchMedia?: MatchMediaLike | null): boolean {
	const mm = matchMedia ?? (globalThis as any).matchMedia;
	if (typeof mm !== "function") return false;
	try {
		return mm("(prefers-color-scheme: dark)")?.matches === true;
	} catch {
		return false;
	}
}

/**
 * 決定初始主題：**存檔優先，其次系統，最後預設**。
 *
 * 順序不能顛倒 —— 使用者手動選過的主題不該被系統設定蓋掉。
 */
export function resolveInitialMode(
	saved: string | null,
	prefersDark: boolean,
): ThemeMode {
	if (saved === "light" || saved === "dark") return saved;
	return prefersDark ? "dark" : DEFAULT_THEME;
}

interface ThemeContextType {
	mode: ThemeMode;
	/** 語意布林。元件優先序：CSS 變數 > isLight > mode 字串比較 */
	isLight: boolean;
	setMode: (mode: ThemeMode) => void;
	/** 在兩套之間切換（切換鈕用） */
	toggle: () => void;
	tokens: ThemeTokens;
}

const ThemeContext = createContext<ThemeContextType>({
	mode: DEFAULT_THEME,
	isLight: true,
	setMode: () => {},
	toggle: () => {},
	tokens: themeTokens[DEFAULT_THEME],
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	const [mode, setModeState] = useState<ThemeMode>(() =>
		resolveInitialMode(loadTheme(), systemPrefersDark()),
	);

	const setMode = useCallback((next: ThemeMode) => {
		setModeState(next);
		// 存不起來（無痕模式、配額）不影響這次的主題，只是下次不會記得
		saveTheme(next);
	}, []);

	const toggle = useCallback(() => {
		setModeState((prev) => {
			const next: ThemeMode = prev === "light" ? "dark" : "light";
			saveTheme(next);
			return next;
		});
	}, []);

	const tokens = themeTokens[mode];
	// token → CSS 自訂屬性。子孫用 var(--syn-…) 取用，不必知道主題是什麼。
	const vars = useMemo(() => cssVariables(tokens) as React.CSSProperties, [tokens]);

	useEffect(() => {
		// 讓**原生控件**跟著主題走：捲軸、下拉選單、日期選擇器、
		// 自動填入的背景色。沒有這一行，深色主題下會出現亮白捲軸。
		const root = document.documentElement;
		root.dataset.theme = mode;
		root.style.colorScheme = mode;
	}, [mode]);

	return (
		<ThemeContext.Provider
			value={{ mode, isLight: mode === "light", setMode, toggle, tokens }}
		>
			{/*
			 * 掛在最外層的 div 與舊版一致（同樣是 block，不改動既有版面），
			 * 額外掛上 data-theme 與 CSS 變數。
			 */}
			<div data-theme={mode} style={vars}>
				{children}
			</div>
		</ThemeContext.Provider>
	);
};

export const useTheme = () => useContext(ThemeContext);
