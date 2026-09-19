// apps/web/src/engine/ikaros/core.ts
// Ikaros 執行核心 —— 完全不知道「DuckDB 宿主在哪一條 thread」。
//
// 正常路徑：core 位於 Web Worker 內（見 worker.ts），main thread 不會接觸 WASM，
//          也不會做任何「把 N 行結果轉成 JS object」的工作。
// Fallback：如果瀏覽器不支援 nested worker，core 直接位於 main thread（見 client.ts）。
//
// ⚠️ 所有跨越邊界的結果集都必須是「有界」的。舊版 `result.toArray().map(toJSON)`
// 會把整張表（百萬行）搬到 main thread，UI 直接 freeze —— 這正是根本問題。
import * as duckdb from "@duckdb/duckdb-wasm";
import { arrowTableToJSON, getArrowSchemaMetadata } from "@synapse/ikaros-arrow";
import {
	qi,
	strLit,
	intLit,
	readerFor,
	READER_OPTS,
	buildSearchPredicate,
	safeVirtualFileName,
} from "../sql";

export interface ColumnInfo {
	name: string;
	type: string;
	nullable?: boolean;
}

export interface PageResult {
	columns: ColumnInfo[];
	rows: Record<string, any>[];
	total: number;
}

export interface FileRegistration {
	rowCount: number;
	columns: string[];
}

/** 單次查詢回傳到 main thread 的行數上限（防止意外搬運整張表） */
export const DEFAULT_MAX_ROWS = 5000;

export class IkarosCore {
	private conn: duckdb.AsyncDuckDBConnection | null = null;

	constructor(private readonly db: duckdb.AsyncDuckDB) {}

	get database(): duckdb.AsyncDuckDB {
		return this.db;
	}

	/** 建立連線 + 準備 raw_data 備用表（未連線的節點不會立即報錯） */
	async connect(): Promise<void> {
		if (this.conn) return;
		this.conn = await this.db.connect();
		await this.exec(
			"CREATE TABLE IF NOT EXISTS raw_data AS SELECT 101 AS id, 'Sample Product' AS item, 1000.0 AS amount, 2026 AS year;",
		);
	}

	private require(): duckdb.AsyncDuckDBConnection {
		if (!this.conn) throw new Error("Ikaros 連線尚未就緒（請先 await ready）");
		return this.conn;
	}

	/** 執行 SQL，只回傳受影響行數（DDL / DML 用，不需要搬運資料） */
	async exec(sql: string): Promise<number> {
		const table = await this.require().query(sql);
		return table.numRows;
	}

	/**
	 * 執行 SQL 並回傳 JSON 行。
	 * 轉換在此處（worker thread）完成，main thread 只會收到已經處理好的 object。
	 * 超過 maxRows 的行會被截斷並回報 truncated。
	 */
	async query(
		sql: string,
		maxRows: number = DEFAULT_MAX_ROWS,
	): Promise<{ rows: Record<string, any>[]; truncated: boolean; totalRows: number }> {
		// maxRows <= 0 一律視為預設上限：永遠不存在「無上限」這個選項，
		// 否則一次手誤就可以把整張百萬行表搬到 main thread。
		const cap = maxRows > 0 ? maxRows : DEFAULT_MAX_ROWS;

		const table = await this.require().query(sql);
		const totalRows = table.numRows;
		let source: any = table;
		let truncated = false;

		if (totalRows > cap) {
			truncated = true;
			try {
				source = table.slice(0, cap);
			} catch {
				source = table; // slice 不支援時照樣回傳（下方仍有 hard cap）
			}
		}

		const rows = arrowTableToJSON(source) as Record<string, any>[];
		if (rows.length > cap) rows.length = cap;
		return { rows, truncated, totalRows };
	}

	/** 讀取表的欄位型別（Data Drawer badge 使用） */
	async describe(tableName: string): Promise<ColumnInfo[]> {
		const rows = await this.query(
			`DESCRIBE SELECT * FROM ${qi(tableName)}`,
			DEFAULT_MAX_ROWS,
		);
		return rows.rows.map((r) => ({
			name: String(r.column_name ?? r.name ?? ""),
			type: String(r.column_type ?? r.type ?? "UNKNOWN"),
			nullable: String(r.null ?? "YES").toUpperCase() === "YES",
		}));
	}

	/**
	 * SQL 側分頁 + 跨欄位搜尋。
	 * 關鍵：main thread 永遠只收到 limit 行（預設 100），因此 100 萬行的表也不會 freeze。
	 */
	async page(
		tableName: string,
		opts: { offset?: number; limit?: number; search?: string } = {},
	): Promise<PageResult> {
		const offset = intLit(opts.offset, 0);
		const limit = Math.min(intLit(opts.limit, 100) || 100, 1000);

		let columns: ColumnInfo[] = [];
		try {
			columns = await this.describe(tableName);
		} catch {
			return { columns: [], rows: [], total: 0 };
		}

		const predicate = buildSearchPredicate(
			columns.map((c) => c.name),
			opts.search ?? "",
		);
		const where = predicate ? ` WHERE ${predicate}` : "";

		const countRes = await this.query(
			`SELECT COUNT(*) AS total FROM ${qi(tableName)}${where};`,
			1,
		);
		const total = Number(countRes.rows[0]?.total ?? 0);

		const dataRes = await this.query(
			`SELECT * FROM ${qi(tableName)}${where} LIMIT ${limit} OFFSET ${offset};`,
			limit,
		);

		return { columns, rows: dataRes.rows, total };
	}

	/** 列出目前 DuckDB 內所有表（Hermes context / debug 使用） */
	async tables(): Promise<string[]> {
		const res = await this.query(
			"SELECT table_name FROM information_schema.tables ORDER BY table_name;",
			200,
		);
		return res.rows.map((r) => String(r.table_name));
	}

	/**
	 * 將上傳檔案註冊入 DuckDB 並建成實體表。
	 *
	 * 安全修復：舊版將**使用者原始檔名**直接插入 read_csv_auto('...') ——
	 * 檔名含單引號就會破壞 SQL / 可被注入。現在改用節點 id 生成虛擬檔名
	 * （src_<hex>.csv），原始檔名只作顯示用，永遠不進入 SQL。
	 */
	async registerFile(
		tableName: string,
		fileName: string,
		bytes: ArrayBuffer | Uint8Array,
	): Promise<FileRegistration> {
		const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		const virtualName = safeVirtualFileName(tableName, fileName);

		await this.db.registerFileBuffer(virtualName, buffer);

		const reader = readerFor(fileName);
		const opts = reader === "read_csv_auto" ? READER_OPTS.csv : READER_OPTS.parquet;
		const optsSql = opts ? `, ${opts}` : "";
		const from = `${reader}(${strLit(virtualName)}${optsSql})`;

		await this.exec(
			`CREATE OR REPLACE TABLE ${qi(tableName)} AS SELECT * FROM ${from};`,
		);

		const columns = await this.describe(tableName);
		const countRes = await this.query(
			`SELECT COUNT(*) AS total FROM ${qi(tableName)};`,
			1,
		);

		return {
			rowCount: Number(countRes.rows[0]?.total ?? 0),
			columns: columns.map((c) => c.name),
		};
	}

	/** 刪除表（重新上傳前清理使用） */
	async dropTable(tableName: string): Promise<void> {
		await this.exec(`DROP TABLE IF EXISTS ${qi(tableName)};`);
	}

	/** 供 schema metadata 使用（例如匯出 / 型別推斷） */
	async schemaMetadata(tableName: string) {
		const table = await this.require().query(
			`SELECT * FROM ${qi(tableName)} LIMIT 0;`,
		);
		return getArrowSchemaMetadata(table as any);
	}
}
