/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
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
