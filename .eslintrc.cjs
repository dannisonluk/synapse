// .eslintrc.cjs
// 全 repo 共用一份 ESLint 設定（ESLint 8 的 eslintrc 格式）。
//
// 為什麼不是「每個 package 各一份、由 turbo 逐包跑」：
//   pnpm 的 node_modules 是嚴格的 —— 每個套件只能用到自己 dependencies 裡的
//   binary。要逐包跑就得在 apps/web、packages/* 各再列一次 eslint 與全部
//   plugin（純噪音，而且多一個漏更新的地方）。這裡改成 root 跑一次，
//   一次涵蓋 apps/web 與 packages/*。
//
// 最有價值的兩條是 react-hooks：dependency array 寫錯會造成 stale closure，
// 而且**不會有任何型別錯誤** —— tsc 抓不到，只有這條規則抓得到。
//
// 注意：eslint 尚未安裝（`pnpm lint` 之前要先 `pnpm install`）。
//   見 README「已知缺口」。
module.exports = {
	root: true,
	env: { browser: true, es2022: true, node: true },
	parser: "@typescript-eslint/parser",
	parserOptions: {
		ecmaVersion: "latest",
		sourceType: "module",
		ecmaFeatures: { jsx: true },
	},
	plugins: ["@typescript-eslint", "react-hooks"],
	extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
	// .mjs / .cjs 是產生器與設定檔（含 eslint 自己的設定），不進 lint 範圍；
	// apps/server 是 Python。dist 是建置產物。
	ignorePatterns: [
		"node_modules/",
		"**/dist/",
		"**/dist.bak/",
		".turbo/",
		"**/venv/",
		"**/__pycache__/",
		"apps/server/",
		"*.mjs",
		"*.cjs",
	],
	rules: {
		"react-hooks/rules-of-hooks": "error",
		"react-hooks/exhaustive-deps": "warn",
		// 這個專案刻意在邊界使用 any：後端 payload、React Flow 的 data、
		// 以及 DuckDB 回傳的動態列。強制 unknown 只會換來一堆無意義的斷言。
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-unused-vars": [
			"warn",
			{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
		],
	},
};
