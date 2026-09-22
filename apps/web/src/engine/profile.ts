// apps/web/src/engine/profile.ts
//
// 欄位剖面 —— 回答「這張表長什麼樣」。
//
// 為什麼要做：目前唯一的資訊是前 5 列預覽。使用者看不出 NULL 比例、基數、值域，
// 而這些正是決定下一步的依據（要不要 IMPUTE？這個 JOIN 鍵對不對？聚合結果合理嗎？）。
//
// 兩個設計約束：
//
// 1. **一次查詢算完全部**，不是每欄一個 query。欄位數一多，round-trip 就成為
//    主要成本。這裡把 N 欄 × 4 個量測全部塞進同一個 SELECT。
//
// 2. **剖面結果絕對不能寫進 config**。types/nodeConfig.ts 是「驅動 SQL 的形狀」，
//    剖面是衍生事實 —— 寫進去會污染 workflow 存檔、讓執行快取的鍵不穩定，
//    而且會隨存檔一起傳給別人。它只能活在元件的 state 裡。
//
// 本檔案只 import qi（識別字引號），因此仍可在 Node 裡直接測。

import { qi } from "./sql";

export interface ProfileColumnInput {
	name: string;
	type: string;
}

/** 四種量測。實測（duckdb-wasm / DuckDB v1.4.3）確認**所有型別**都支援這四者 —— */
/** 包括 LIST / STRUCT / BLOB / INTERVAL，所以不需要型別白名單，也就不會出現 */
/** 「為什麼這一欄沒有剖面」這種需要解釋的狀態。 */
export type ProfileMeasure = "nulls" | "distinct" | "min" | "max";

/** 量測 → 欄位別名後綴 */
const MEASURE_SUFFIX: Record<ProfileMeasure, string> = {
	nulls: "nn",
	distinct: "nd",
	min: "mn",
	max: "mx",
};

export interface ProfileField {
	alias: string;
	column: string;
	measure: ProfileMeasure;
}

export interface ProfileQuery {
	sql: string;
	/** 總列數的別名 */
	rowsAlias: string;
	/** 別名 → (欄位, 量測)。解析結果時靠它對回去 */
	fields: ProfileField[];
}

export interface ColumnProfile {
	name: string;
	type: string;
	/** NULL 的列數 */
	nulls: number | null;
	/** distinct 值數（NULL 不計） */
	distinct: number | null;
	/** 最小值，已轉成顯示字串 */
	min: string | null;
	/** 最大值，已轉成顯示字串 */
	max: string | null;
}

export interface TableProfile {
	rows: number;
	columns: ColumnProfile[];
}

/** 顯示字串的長度上限 —— 一個 10MB 的字串最小值不該進到 UI */
const MAX_DISPLAY = 80;

/**
 * 把任何值轉成短的可顯示字串。
 *
 * 為什麼要有上限：`MIN()` 作用在一個超長 VARCHAR 上會回傳整個字串。
 * 剖面是「看一眼」的工具，不是資料本身；不設限會讓一個無害的按鈕吃掉幾十 MB。
 */
export function displayValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else if (typeof value === "number" || typeof value === "bigint") {
		text = String(value);
	} else if (typeof value === "boolean") {
		text = value ? "true" : "false";
	} else if (value instanceof Date) {
		// Arrow 的 DATE / TIMESTAMP 到這一層已經是 Date；ISO 比 epoch 毫秒可讀
		text = value.toISOString();
	} else {
		// LIST / STRUCT 之類：JSON 是唯一合理的顯示形式
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	return text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY - 1)}…` : text;
}

/** 把一個量測的結果轉成數字（NULL 保持 null，不要變成 0） */
function toCount(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * 產生剖面查詢。
 *
 * 別名用 `"<欄位>__<後綴>"` 並且**引號包裹**。引號是必要的：實測顯示引號會讓
 * 別名變成大小寫敏感，所以 `"i__nn"` 不會被折成 `i__NN`，解析時可以精確比對。
 *
 * 別名衝突（欄位就叫 `a__nn`，或同時有 `A` 與 `a`）用序號後綴解掉。
 * DuckDB 其實允許重複別名（實測通過），但那樣結果物件只會留一個鍵 ——
 * SQL 不報錯、解析卻默默少一欄，正是最難查的那種 bug。
 */
export function buildProfileQuery(
	table: string,
	columns: readonly ProfileColumnInput[],
): ProfileQuery {
	const rowsAlias = "__rows";
	const used = new Set<string>([rowsAlias]);
	const fields: ProfileField[] = [];
	const projections: string[] = [`COUNT(*) AS ${qi(rowsAlias)}`];

	for (const col of columns) {
		const name = String(col.name ?? "").trim();
		if (!name) continue;

		for (const measure of Object.keys(MEASURE_SUFFIX) as ProfileMeasure[]) {
			let alias = `${name}__${MEASURE_SUFFIX[measure]}`;
			// 衝突就加序號，直到唯一
			let n = 2;
			while (used.has(alias)) {
				alias = `${name}__${MEASURE_SUFFIX[measure]}_${n}`;
				n += 1;
			}
			used.add(alias);

			const expr =
				measure === "nulls"
					? `COUNT(${qi(name)})`
					: measure === "distinct"
						? `COUNT(DISTINCT ${qi(name)})`
						: measure === "min"
							? `MIN(${qi(name)})`
							: `MAX(${qi(name)})`;

			projections.push(`${expr} AS ${qi(alias)}`);
			fields.push({ alias, column: name, measure });
		}
	}

	return {
		sql: `SELECT ${projections.join(", ")} FROM ${qi(table)}`,
		rowsAlias,
		fields,
	};
}

/**
 * 把查詢結果的一列解析成剖面。
 *
 * 查詢一定是單列（全是聚合函式，沒有 GROUP BY），所以只取第一列。
 */
export function parseProfileRow(
	row: Record<string, unknown> | undefined,
	query: ProfileQuery,
	columns: readonly ProfileColumnInput[],
): TableProfile {
	const rows = toCount(row?.[query.rowsAlias]) ?? 0;

	// 依輸入順序輸出，而不是依別名順序 —— 使用者看到的欄位順序應該是表的順序
	const byColumn = new Map<string, ColumnProfile>();
	for (const col of columns) {
		const name = String(col.name ?? "").trim();
		if (!name) continue;
		byColumn.set(name, {
			name,
			type: col.type || "UNKNOWN",
			nulls: null,
			distinct: null,
			min: null,
			max: null,
		});
	}

	for (const f of query.fields) {
		const target = byColumn.get(f.column);
		if (!target) continue;
		const raw = row?.[f.alias];
		if (f.measure === "nulls") target.nulls = toCount(raw);
		else if (f.measure === "distinct") target.distinct = toCount(raw);
		else if (f.measure === "min") target.min = displayValue(raw);
		else target.max = displayValue(raw);
	}

	return { rows, columns: [...byColumn.values()] };
}

/**
 * NULL 佔比。
 *
 * 列數為 0 時回 **null 而不是 0** —— 「空表」與「沒有 NULL」是完全不同的事實，
 * 顯示 0% 會把前者說成後者。UI 應該顯示「—」。
 */
export function nullRatio(col: ColumnProfile, rows: number): number | null {
	if (!Number.isFinite(rows) || rows <= 0) return null;
	if (col.nulls === null) return null;
	return col.nulls / rows;
}
