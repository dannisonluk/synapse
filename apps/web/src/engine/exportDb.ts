// apps/web/src/engine/exportDb.ts
//
// 把工作流結果寫進外部資料庫 —— **產生語句，不執行**。
//
// 為什麼只能產生語句：DuckDB-WASM 沒有網路，`INSTALL postgres` 也是 no-op
// （已實測）。所以「連到外部 DB」在瀏覽器裡是**不可能**的，不是「還沒做」。
// 誠實的做法是產生一段可以直接拿去跑的 SQL，而不是做一個看起來能連、
// 實際上永遠失敗的節點。
//
// ## 安全：連線字串永遠不進設定
//
// 連線字串含帳號密碼。節點設定會被寫進**工作流存檔**與**分享連結**，
// 所以憑證一旦進設定，就會跟著檔案傳給別人、也會出現在 URL 裡。
//
// 因此：這裡**只產生佔位值**，不接受呼叫端傳入真實憑證。使用者拿到腳本後
// 自己填，填完的那份檔案是他的，不歸我們管。
// 這條規則由斷言守住（見 verify 的 §2l）。
//
// 本檔案只 import sql.ts 的識別字引號，可以在 Node 裡直接測。

import { qi } from "./sql";

export type DbDialect = "postgres" | "mysql" | "sqlite" | "duckdb";

export interface DbTarget {
	/** 目標資料庫種類 */
	dialect: DbDialect;
	/** 目標表名（不含 schema） */
	table: string;
	/** schema（postgres / duckdb 用）；留空 = 不指定 */
	schema?: string;
	/**
	 * 連線的**佔位值**。
	 *
	 * 呼叫端只該傳「使用者看得懂的提示」，不該傳真憑證 —— 例如
	 * `host=YOUR_HOST dbname=YOUR_DB user=YOUR_USER password=YOUR_PASSWORD`。
	 * 預設值就是這個形狀，所以正常情況下不必傳。
	 */
	connectionHint?: string;
}

export interface DbLoadScript {
	statements: string[];
	/** 需要人工注意的地方 */
	notes: string[];
}

/** 各 dialect 對應的 DuckDB 擴充 */
const EXTENSION: Record<DbDialect, string | null> = {
	postgres: "postgres",
	mysql: "mysql",
	sqlite: "sqlite",
	// 本機 .duckdb 檔不需要擴充
	duckdb: null,
};

/** ATTACH 的 TYPE 子句（duckdb 檔不需要） */
const ATTACH_TYPE: Record<DbDialect, string | null> = {
	postgres: "postgres",
	mysql: "mysql",
	sqlite: "sqlite",
	duckdb: null,
};

const DEFAULT_HINT: Record<DbDialect, string> = {
	postgres: "host=YOUR_HOST port=5432 dbname=YOUR_DB user=YOUR_USER password=YOUR_PASSWORD",
	mysql: "host=YOUR_HOST port=3306 database=YOUR_DB user=YOUR_USER password=YOUR_PASSWORD",
	sqlite: "/absolute/path/to/your.db",
	duckdb: "/absolute/path/to/your.duckdb",
};

/** 連線的別名。固定的，因為使用者要改的地方愈少愈好 */
export const ATTACH_ALIAS = "synapse_out";

/**
 * 目標表的完整名稱。
 *
 * 逐段過 `qi()`：表名與 schema 都是使用者可控的，而它們會被直接插進 SQL。
 */
export function qualifiedTable(target: DbTarget): string {
	const table = String(target.table ?? "").trim();
	const schema = String(target.schema ?? "").trim();
	if (!table) return "";
	return schema ? `${qi(schema)}.${qi(table)}` : qi(table);
}

/**
 * 產生寫入外部資料庫的腳本。
 *
 * 用 `CREATE TABLE ... AS SELECT` 而不是 `COPY ... TO 'postgres://…'`：
 * 後者的語法在不同 DuckDB 版本間變過，而 `CREATE TABLE AS` 對
 * attached database 是長期穩定的用法。**這裡的語法沒有對真實伺服器驗證過**
 * （沙箱沒有網路），所以腳本裡明講這件事，不假裝已經測過。
 */
export function buildDbLoadScript(
	selectSql: string,
	target: DbTarget,
): DbLoadScript {
	const select = String(selectSql ?? "").trim().replace(/;\s*$/, "");
	const notes: string[] = [];
	const statements: string[] = [];

	if (!select) {
		return {
			statements: [],
			notes: ["沒有可寫入的查詢 —— 先選一個終點節點。"],
		};
	}

	const ext = EXTENSION[target.dialect];
	if (ext) {
		statements.push(`INSTALL ${ext};`);
		statements.push(`LOAD ${ext};`);
	}

	const hint = String(target.connectionHint ?? "").trim() || DEFAULT_HINT[target.dialect];
	const type = ATTACH_TYPE[target.dialect];
	statements.push(
		type
			? `ATTACH '${hint.replace(/'/g, "''")}' AS ${ATTACH_ALIAS} (TYPE ${type});`
			: `ATTACH '${hint.replace(/'/g, "''")}' AS ${ATTACH_ALIAS};`,
	);

	const qualified = qualifiedTable(target);
	if (!qualified) {
		notes.push("沒有指定目標表名 —— 下面那條 CREATE TABLE 需要你自己補。");
	}
	statements.push(
		qualified
			? `CREATE TABLE ${ATTACH_ALIAS}.${qualified} AS\n${select};`
			: `-- TODO: 補上目標表名\n-- CREATE TABLE ${ATTACH_ALIAS}.<schema>.<table> AS\n-- ${select.replace(/\n/g, "\n-- ")};`,
	);

	statements.push(`DETACH ${ATTACH_ALIAS};`);

	// --- 一定要講清楚的事 ---
	notes.push(
		"這段 SQL **不能在瀏覽器裡跑** —— DuckDB-WASM 沒有網路，擴充也裝不起來。請拿到有網路的 DuckDB（CLI 或 Python）執行。",
	);
	if (ext) {
		notes.push(
			`需要 \`${ext}\` 擴充。第一次執行時 DuckDB 會自動下載它，所以那一步也需要網路。`,
		);
	}
	notes.push(
		`連線字串是**佔位值**。填上真帳密之後那份檔案請自己保管 —— 憑證永遠不會經過 Synapse，也不會進工作流存檔或分享連結。`,
	);
	if (target.dialect !== "duckdb") {
		notes.push(
			"`CREATE TABLE` 在目標表已存在時會失敗。要覆蓋請改成 `DROP TABLE` 後再建，或改用 `INSERT INTO`。",
		);
	}
	notes.push(
		"語法**未對真實伺服器驗證過**（開發環境沒有網路）。不同 DuckDB 版本的 ATTACH 選項可能不同，請以你手上的版本為準。",
	);

	return { statements, notes };
}

/** 把腳本組成一份可下載的文字，含檔頭說明 */
export function scriptToText(script: DbLoadScript, title = "Synapse → 資料庫"): string {
	const lines = [
		`-- ${title}`,
		"--",
		...script.notes.map((n) => `-- ${n}`),
		"",
		...script.statements,
		"",
	];
	return lines.join("\n");
}
