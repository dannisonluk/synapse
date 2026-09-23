/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	/**
	 * `dark:` variant 綁到 `data-theme="dark"`，而不是 Tailwind 的預設（media）。
	 *
	 * 為什麼一定要設：預設值 `media` 讓 `dark:` 跟隨**作業系統**，而不是我們的
	 * 主題切換。於是「OS 是深色、使用者手動選淺色」時，`dark:` 的樣式仍然生效 ——
	 * 一個只看 OS 不看使用者的不一致，而且很難查（在切換主題的開發者機器上
	 * 完全看不出來）。
	 *
	 * ThemeContext 已經在 root 設 `data-theme`，所以這裡直接綁它，
	 * 不需要再另外加一個 `dark` class（兩份狀態會不同步）。
	 */
	darkMode: ["class", '[data-theme="dark"]'],
	theme: {
		extend: {
			// 顏色一律走 theme/tokens.ts 產生的 CSS 自訂屬性（`--syn-*`），
			// 用 Tailwind 的任意值語法取用：`bg-[var(--syn-bg-panel)]`。
			//
			// 這裡原本有一組寫死的品牌色（`#00f0ff` 霓虹青、`#7000ff` 紫），
			// 實測零使用，但留著很危險 —— 它會讓人以為「這是專案的強調色」
			// 而拿去用，結果出現一套跟主題無關的霓虹配色。所以直接刪掉。
			//
			// 要新顏色就加到 tokens.ts（兩套主題一起定義）；不要在這裡加，
			// 否則它會是唯一一個不隨主題改變的顏色。
			colors: {},
		},
	},
	plugins: [],
};
