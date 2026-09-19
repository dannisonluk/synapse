// apps/web/src/engine/ikaros/bundles.ts
// DuckDB-WASM 資產解析。
//
// 舊版用 getJsDelivrBundles() + Blob/importScripts 去繞 CDN 同源限制 ——
// 這樣一來每次開 app 都要打 CDN（離線即掛），二來 CSP 嚴格的環境會直接失敗。
// 改用 Vite 的 `?url` 將 wasm / worker 腳本收進自己的 bundle，完全本機載入。
import * as duckdb from "@duckdb/duckdb-wasm";

import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

/**
 * 只註冊 mvp + eh。
 *
 * coi（cross-origin isolation / pthreads）需要 server 送 COOP+COEP header，
 * 這個 app 沒有設定，所以 selectBundle 永遠不會挑選它 —— 但註冊了就會讓
 * build output 多背 34MB 的死 wasm。要開 coi 的話連 header 一起加回：
 *   coi: { mainModule: duckdbCoiWasm, mainWorker: coiWorker,
 *          pthreadWorker: coiPthreadWorker }
 */
export const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
	mvp: { mainModule: duckdbMvpWasm, mainWorker: mvpWorker },
	eh: { mainModule: duckdbEhWasm, mainWorker: ehWorker },
};

/**
 * 建立一個已連線、已備好 raw_data 的 Ikaros core。
 * main thread（fallback）與 Web Worker（正常路徑）都走這個函數，
 * 差別只在於 AsyncDuckDB 宿主在哪一條 thread。
 */
export async function instantiateDuckDB(): Promise<duckdb.AsyncDuckDB> {
	const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
	if (!bundle.mainWorker) {
		throw new Error("DuckDB bundle 沒有提供 mainWorker（無法啟動 WASM 引擎）");
	}
	const worker = new Worker(bundle.mainWorker);
	const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
	await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
	return db;
}
