// apps/web/src/engine/ikaros/dispatch.ts
// Ikaros 請求分派 —— Web Worker 同主線程 fallback 共用同一份實作，
// 保證兩條路徑的行為完全一致（不會出現「worker 可以、fallback 不行」）。
import { IkarosCore, DEFAULT_MAX_ROWS } from "./core";
import { instantiateDuckDB } from "./bundles";

/** 建立一個已連線、已備好 raw_data 的 Ikaros core */
export async function createCore(): Promise<IkarosCore> {
	const db = await instantiateDuckDB();
	const core = new IkarosCore(db);
	await core.connect();
	return core;
}

/**
 * 單一請求分派器。payload 必須是 structured-clone 友好的資料。
 * 回傳值會直接成為 response 的內容（不包含 id / ok）。
 */
export async function dispatch(
	core: IkarosCore,
	op: string,
	payload: any,
): Promise<any> {
	switch (op) {
		case "INIT":
			return { engine: "duckdb-wasm" };

		case "EXEC": {
			const res = await core.query(
				String(payload?.sql ?? ""),
				payload?.maxRows ?? DEFAULT_MAX_ROWS,
			);
			return {
				rows: res.rows,
				truncated: res.truncated,
				totalRows: res.totalRows,
			};
		}

		case "EXEC_DDL":
			// DDL / DML：只需要行數，完全不搬運資料
			return { rowCount: await core.exec(String(payload?.sql ?? "")) };

		case "REGISTER_FILE": {
			const reg = await core.registerFile(
				String(payload.table),
				String(payload.fileName ?? "upload.csv"),
				payload.bytes,
			);
			return { rowCount: reg.rowCount, columns: reg.columns };
		}

		case "DESCRIBE":
			return { columns: await core.describe(String(payload.table)) };

		case "PAGE": {
			const res = await core.page(String(payload.table), {
				offset: payload?.offset,
				limit: payload?.limit,
				search: payload?.search,
			});
			return { columns: res.columns, rows: res.rows, total: res.total };
		}

		case "TABLES":
			return { tables: await core.tables() };

		case "SCHEMA":
			return { metadata: await core.schemaMetadata(String(payload.table)) };

		case "DROP":
			await core.dropTable(String(payload.table));
			return { dropped: true };

		default:
			throw new Error(`未知的 Ikaros op: ${op}`);
	}
}
