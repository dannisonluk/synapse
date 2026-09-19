import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
	},
	/**
	 * DuckDB-WASM 的 worker 腳本是「classic worker」（使用 importScripts / 自己
	 * 載入 wasm），不可經 Vite 的 ESM 轉換。將它們當成靜態資產原樣送出，
	 * 保證 dev 同 build 兩邊行為一致。
	 */
	assetsInclude: ["**/*.wasm", "**/duckdb-*.worker.js"],
	build: {
		sourcemap: false,
		// DuckDB wasm（~35MB）本來就會被 browser 按需要 lazy fetch，
		// 不應觸發 chunk size 警告。
		chunkSizeWarningLimit: 1024,
	},
});
