import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvp_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { tableToIPC } from "apache-arrow";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

async function initIkarosEngine(id: string) {
	try {
		const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
			mvp: {
				mainModule: duckdb_wasm,
				mainWorker: mvp_worker,
			},
		};

		const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
		const worker = new Worker(bundle.mainWorker!);
		const logger = new duckdb.ConsoleLogger();

		db = new duckdb.AsyncDuckDB(logger, worker);
		await db.instantiate(bundle.mainModule);
		conn = await db.connect();

		self.postMessage({ id, type: "IKAROS_READY" });
	} catch (err: any) {
		console.error("Ikaros Engine Init Error:", err);
		self.postMessage({ id, type: "IKAROS_ERROR", error: err.message });
	}
}

self.onmessage = async (e: MessageEvent) => {
	const { id, type, payload } = e.data;

	if (type === "INIT") {
		await initIkarosEngine(id);
		return;
	}

	if (!conn) {
		self.postMessage({
			id,
			type: "IKAROS_ERROR",
			error: "Ikaros engine is not ready.",
		});
		return;
	}

	try {
		if (type === "EXECUTE_SQL") {
			// 1. 執行 DuckDB 查詢
			const arrowTable = await conn.query(payload.sql);
			// 2. 使用 tableToIPC 將 Arrow Table 序列化為二進位流
			// 使用 as any 避開 DuckDB 內部 Arrow 型別與 apache-arrow 的版本定義衝突
			const ipcBuffer = tableToIPC(arrowTable as any, "stream");
			// 3. 回傳 Uint8Array
			self.postMessage({ id, type: "SUCCESS", result: ipcBuffer });
		}
	} catch (err: any) {
		self.postMessage({ id, type: "IKAROS_ERROR", error: err.message });
	}
};
