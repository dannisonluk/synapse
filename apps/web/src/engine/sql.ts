// apps/web/src/engine/sql.ts
// SQL literal / identifier 安全層（zero dependencies —— main thread 與 Web Worker
// 都要使用，因此不可 import 任何 React component）。
//
// 設計原則：任何由 UI / LLM / 檔名流入 SQL 的值，都必須經本模組處理。
// 不存在「直接將字串 interpolation 進 SQL」的路徑。

/** 雙引號 identifier（escape 內含的雙引號） */
export function qi(identifier: string): string {
	return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * Value literal：純數字 / 布林保留原樣（方便 `WHERE amount > 1000`），
 * 其餘一律以 single quote 包裹並 escape。
 */
export function lit(value: unknown): string {
	const trimmed = String(value ?? "").trim();
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return trimmed;
	if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase();
	if (/^null$/i.test(trimmed)) return "NULL";
	return strLit(trimmed);
}

/** 強制為 string literal（例如 LIKE pattern 必須是 string，不可變成裸數字） */
export function strLit(value: unknown): string {
	return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/** 非負整數（LIMIT / OFFSET 使用） */
export function intLit(value: unknown, fallback = 0): number {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * FILTER operator 白名單 —— 舊版直接將 config.op 插入 SQL。
 */
const ALLOWED_OPS = new Set([
	"=", "==", "!=", "<>", ">", ">=", "<", "<=",
	"LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE", "IS", "IS NOT",
]);

export function safeOp(op: unknown, fallback = "="): string {
	const normalized = String(op ?? "").trim().toUpperCase().replace(/\s+/g, " ");
	return ALLOWED_OPS.has(normalized) ? normalized : fallback;
}

/**
 * Aggregate function 白名單。
 * COUNT_DISTINCT 是 UI 用的虛擬名稱 → 由 astCompiler 展開成 `COUNT(DISTINCT x)`
 * （DuckDB 沒有 count_distinct 這個函數名）。
 */
const ALLOWED_FUNCS = new Set([
	"SUM",
	"AVG",
	"COUNT",
	"COUNT_DISTINCT",
	"MIN",
	"MAX",
	"STDDEV",
	"MEDIAN",
	"ANY_VALUE",
	// CROSS_TAB（PIVOT ... USING FIRST(...)）需要 —— DuckDB 的 first() 聚合
	"FIRST",
]);

export function safeFunc(fn: unknown, fallback = "SUM"): string {
	const normalized = String(fn ?? "").trim().toUpperCase();
	return ALLOWED_FUNCS.has(normalized) ? normalized : fallback;
}

/** IMPUTE 補值方式白名單 */
const ALLOWED_IMPUTE_METHODS = new Set(["CONSTANT", "MEAN"]);

export function safeImputeMethod(m: unknown, fallback = "CONSTANT"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_IMPUTE_METHODS.has(normalized) ? normalized : fallback;
}

/** RANK 排名方式白名單（值同時是 DuckDB 的視窗函數名） */
const ALLOWED_RANK_METHODS = new Set(["RANK", "DENSE_RANK", "ROW_NUMBER"]);

export function safeRankMethod(m: unknown, fallback = "RANK"): string {
	const normalized = String(m ?? "").trim().toUpperCase().replace(/\s+/g, "_");
	return ALLOWED_RANK_METHODS.has(normalized) ? normalized : fallback;
}

/**
 * FIND_REPLACE 未命中時的處理。
 *   KEEP → 保留來源原值（LEFT JOIN + COALESCE）
 *   NULL → 設為空值
 */
const ALLOWED_UNMATCHED = new Set(["KEEP", "NULL"]);

export function safeUnmatched(m: unknown, fallback = "KEEP"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_UNMATCHED.has(normalized) ? normalized : fallback;
}

/** JOIN type 白名單 */
const ALLOWED_JOIN_TYPES = new Set(["INNER", "LEFT", "RIGHT", "FULL", "LEFT OUTER", "RIGHT OUTER", "FULL OUTER", "CROSS"]);

export function safeJoinType(t: unknown, fallback = "INNER"): string {
	const normalized = String(t ?? "").trim().toUpperCase().replace(/\s+/g, " ");
	return ALLOWED_JOIN_TYPES.has(normalized) ? normalized : fallback;
}

/**
 * UNION 的欄位對齊方式。
 *   BY_NAME  → `UNION ALL BY NAME`：按欄位名對齊，缺欄位補 NULL（Alteryx 的 Union 語意）
 *   POSITION → `UNION ALL`：按位置對齊
 */
const ALLOWED_UNION_MODES = new Set(["BY_NAME", "POSITION"]);

export function safeUnionMode(m: unknown, fallback = "BY_NAME"): string {
	const normalized = String(m ?? "").trim().toUpperCase().replace(/\s+/g, "_");
	return ALLOWED_UNION_MODES.has(normalized) ? normalized : fallback;
}

/** SAMPLE 取樣方式白名單 */
const ALLOWED_SAMPLE_MODES = new Set(["FIRST", "RANDOM"]);

export function safeSampleMode(m: unknown, fallback = "FIRST"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_SAMPLE_MODES.has(normalized) ? normalized : fallback;
}

/**
 * FORMULA expression：本質上是自由 SQL 片段，無法完全參數化，
 * 因此做「結構性拒絕」—— 只擋多語句與註解，保留正常運算表達式。
 * （`;` 與 `--` / `/*` 在一個 scalar expression 內永遠不會合法）
 */
export function safeExpr(expr: unknown, fallback = "1"): string {
	const raw = String(expr ?? "").trim();
	if (!raw) return fallback;
	if (raw.length > 2000) return fallback;
	if (raw.includes(";") || raw.includes("--") || raw.includes("/*") || raw.includes("*/")) {
		return fallback;
	}
	// 只允許單層 expression：拒絕以 DDL / DML 關鍵字開頭
	if (/^\s*(drop|delete|insert|update|create|alter|attach|copy|pragma|install|load|export|import)\b/i.test(raw)) {
		return fallback;
	}
	return raw;
}

/** 產生「安全的虛擬檔名」：使用節點 id，而非使用者上傳的檔名 */
export function safeVirtualFileName(tableName: string, fileName: string): string {
	const ext = /\.parquet$/i.test(fileName) ? "parquet" : "csv";
	const safeBase = String(tableName).replace(/[^A-Za-z0-9_]/g, "_");
	return `${safeBase}.${ext}`;
}

/** 由檔名推斷 reader function */
export function readerFor(fileName: string): string {
	return /\.parquet$/i.test(fileName) ? "read_parquet" : "read_csv_auto";
}

/**
 * 大 CSV / Parquet 讀取參數。
 * sample_size = 100000：百萬行檔案需要足夠樣本推斷型別，
 * 避免預設 20480 抽樣不足而將數字欄位誤判成 VARCHAR。
 */
export const READER_OPTS: Record<string, string> = {
	csv: "sample_size = 100000, auto_detect = true, ignore_errors = true, null_padding = true",
	parquet: "",
};

/** 將欄位清單組成「跨欄位全文搜尋」的 SQL predicate（用於 Data Drawer 搜尋） */
export function buildSearchPredicate(columns: string[], needle: string): string {
	const q = needle.trim();
	if (!q || columns.length === 0) return "";
	const parts = columns.map((c) => `CAST(${qi(c)} AS VARCHAR)`);
	return `concat_ws(' ', ${parts.join(", ")}) ILIKE ${strLit(`%${q}%`)}`;
}
