// apps/web/src/engine/astCompiler.ts
// Synapse AST → DuckDB SQL compiler
// 設計原則：
//   - 所有計算節點輸出統一為 `CREATE OR REPLACE TEMP TABLE <nodeId> AS ...`，
//     下游節點只依靠「上游節點 id」作為資料表名稱 → 重複執行 / 重新連線都安全。
//   - identifier（欄位 / 表格名）一律以雙引號包裹（DuckDB 標準），
//     literal 一律經 sql.ts 的 lit/strLit escape，operator / function / JOIN type 走白名單。
//   - 本檔案不可 import React component：Web Worker 會 import 它。
import { orderUpstreamEdges } from "./scheduler";
import {
	qi,
	lit,
	strLit,
	safeOp,
	safeFunc,
	safeJoinType,
	safeExpr,
	safeUnionMode,
	safeSampleMode,
	safeImputeMethod,
	safeRankMethod,
	safeUnmatched,
	safeRegexMode,
	regexPattern,
	safeMultiFieldOutputMode,
	safeNewFieldSuffix,
	hasCurrentField,
	applyCurrentField,
	intLit,
} from "./sql";
import type { Edge } from "@xyflow/react";

/** SUMMARIZE 的一組聚合（可多組並存） */
export interface SummarizeAggregation {
	/** SUM / AVG / COUNT / COUNT_DISTINCT / MIN / MAX / STDDEV / MEDIAN / ANY_VALUE */
	func?: string;
	/** 目標欄位；`*` 代表 COUNT(*) */
	target?: string;
}

/** RENAME 的一組改名（可多組並存） */
export interface RenamePair {
	from?: string;
	to?: string;
}

/** 節點配置（結構上與 AlteryxNodeConfig 一致，但不依賴元件檔） */
export interface NodeConfig {
	field?: string;
	op?: string;
	val?: string;
	/**
	 * SUMMARIZE 的分組鍵。
	 *   string        → 舊格式，單一鍵（也接受 "a, b" 逗號分隔）
	 *   string[]      → 多鍵；空陣列 = 不分组（純聚合）
	 *   undefined     → 沿用舊預設 ["year"]
	 */
	groupBy?: string | string[];
	/** 舊格式：單一聚合函數（aggregations 為空時的 fallback） */
	func?: string;
	/** 舊格式：單一聚合目標（aggregations 為空時的 fallback） */
	target?: string;
	/** SUMMARIZE 的聚合清單（新格式，支援多組） */
	aggregations?: SummarizeAggregation[];
	tableName?: string;
	joinType?: string;
	leftKey?: string;
	rightKey?: string;
	outputColumn?: string;
	expression?: string;
	fileName?: string;
	rowCount?: number;
	columnCount?: number;
	/** SELECT 要投影的欄位；空陣列 = 全選 */
	columns?: string[];
	/** UNION 的欄位對齊方式：BY_NAME（預設）/ POSITION */
	unionMode?: string;
	/** SAMPLE 的取樣列數 */
	sampleSize?: number;
	/** SAMPLE 的取樣方式：FIRST（預設）/ RANDOM */
	sampleMode?: string;
	/** RENAME 的改名清單 */
	renames?: RenamePair[];
	/** IMPUTE 補值方式 / RANK 排名方式 */
	method?: string;
	/** IMPUTE 的常數補值 */
	fillValue?: string;
	/** DATA_CLEANSING 的三個開關 */
	trim?: boolean;
	collapse?: boolean;
	emptyToNull?: boolean;
	/** CROSS_TAB */
	pivotColumn?: string;
	valueColumn?: string;
	aggFunc?: string;
	/** TRANSPOSE 的「名稱」欄位名 */
	nameColumn?: string;
	/** TEXT_TO_COLUMNS */
	separator?: string;
	outputColumns?: string[];
	/** REGEX：MATCH | PARSE | REPLACE */
	regexMode?: string;
	pattern?: string;
	replacement?: string;
	caseInsensitive?: boolean;
	/** MULTI_FIELD_FORMULA：OVERWRITE | NEW_FIELD */
	outputMode?: string;
	newFieldSuffix?: string;
	/** 視窗節點 */
	partitionBy?: string[];
	orderBy?: string;
	descending?: boolean;
	/** FIND_REPLACE */
	findField?: string;
	lookupField?: string;
	replaceField?: string;
	unmatched?: string;
}

/**
 * FILTER 節點的 false 分支表名後綴。
 *
 * FILTER 有 true / false 兩個輸出埠（Alteryx 語意）：
 *   - true  分支 → 節點 id 本身（向後兼容，也是 Data Drawer 檢視的那張表）
 *   - false 分支 → `${nodeId}__false`
 * 兩個分支都由 FILTER 節點自己建立（見 compileNodeStatements）。
 */
export const FALSE_BRANCH_SUFFIX = "__false";

/** FILTER 的 false 分支輸出表名 */
export function falseBranchTable(nodeId: string): string {
	return `${nodeId}${FALSE_BRANCH_SUFFIX}`;
}

/**
 * 由「上游節點 id + 來源埠（sourceHandle）」推出實際要讀取的表名。
 *
 * 這是修掉「false 埠是假的」的關鍵：舊版完全忽略 sourceHandle，
 * 所以從 F 埠拉線出去，下游讀到的其實是 true 分支的表 —— 結果相反且無任何提示。
 */
export function branchTableName(
	sourceId: string,
	sourceHandle?: string | null,
): string {
	return sourceHandle === "false" ? falseBranchTable(sourceId) : sourceId;
}

/**
 * FILTER 的篩選條件（true / false 兩個分支共用同一份運算式）。
 *
 * false 分支用 `NOT COALESCE(cond, FALSE)` 而非 `NOT (cond)`：
 * 後者在 cond 為 NULL 時結果仍是 NULL，該行會**同時不屬於**兩個分支而消失。
 * 實測（duckdb-wasm 1.32 / DuckDB v1.4.3）：
 *   input=[1,2,3]  cond=(amount>1000)
 *   true=[2]   NOT COALESCE → [1,3]（完整）   naive NOT → [1]（漏掉 NULL 的 3）
 */
function filterCondition(config: NodeConfig): string {
	const field = config.field || "amount";
	const op = safeOp(config.op, ">");
	const val = config.val ?? "1000";
	return `${qi(field)} ${op} ${lit(val)}`;
}

/**
 * 把「可能是 string / string[] / undefined」的欄位清單正規化成 string[]。
 *
 * 為什麼要同時吃兩種：舊存檔與 Hermes payload 都是單一字串，而 UI 與
 * 新存檔用陣列。這裡是唯一的轉換點，下游不必再判斷型別。
 *
 * 空字串視為「未設定」→ 用 fallback；明確的空陣列視為「刻意不要」
 * （SUMMARIZE 就是靠這個表達「純聚合、不分组」）。
 */
function toNameList(value: unknown, fallback: string[]): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v ?? "").trim()).filter(Boolean);
	}
	const single = String(value ?? "").trim();
	if (!single) return [...fallback];
	return single
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * 去重但保留順序。
 *
 * MULTI_FIELD_FORMULA 對同一個欄位套用兩次沒有任何意義，而且兩個引擎都會
 * 直接報錯（DuckDB：`Duplicate entry "x" in REPLACE list`；Polars：
 * `the name 'x' ... is duplicate`）。與其把使用者的筆誤丟成一個引擎錯誤，
 * 不如在這裡收掉 —— 這是有損但無害的收斂。
 */
function dedupe(list: string[]): string[] {
	return [...new Set(list)];
}

/**
 * SUMMARIZE 的聚合清單。
 * 新格式（aggregations 陣列）優先；空 / 缺 → 退回舊的單一 func + target。
 */
function normalizeAggregations(
	config: NodeConfig,
): { func: string; target: string }[] {
	const raw = Array.isArray(config.aggregations) ? config.aggregations : [];
	const list = raw
		.map((a) => ({
			func: safeFunc(a?.func, "SUM"),
			target: String(a?.target ?? "").trim(),
		}))
		.filter((a) => a.target);
	if (list.length > 0) return list;
	return [{ func: safeFunc(config.func, "SUM"), target: config.target || "amount" }];
}

/** 聚合輸出欄位的別名（未去重前的基底名） */
function aggAlias(agg: { func: string; target: string }): string {
	if (agg.target === "*") return "count";
	return `${agg.target}_${agg.func.toLowerCase()}`;
}

/** 聚合投影式；COUNT_DISTINCT 在此展開成 DuckDB 的 COUNT(DISTINCT x) */
function aggProjection(agg: { func: string; target: string }, alias: string): string {
	if (agg.target === "*") return `COUNT(*) AS ${qi(alias)}`;
	if (agg.func === "COUNT_DISTINCT") {
		return `COUNT(DISTINCT ${qi(agg.target)}) AS ${qi(alias)}`;
	}
	return `${agg.func}(${qi(agg.target)}) AS ${qi(alias)}`;
}

/**
 * 視窗子句 `OVER (PARTITION BY … ORDER BY … [frame])`。
 *
 * MULTI_ROW_FORMULA / RUNNING_TOTAL / RANK 三個節點共用 —— 它們的差別只在
 * 「聚合函數本身」與「要不要 frame」，分區與排序的組法完全一樣。
 *
 * @param opts.orderBy          排序鍵（未給則讀 config.orderBy）
 * @param opts.frame            視窗框，例如 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
 * @param opts.defaultDescending config.descending 未設定時的預設方向
 *        （RANK 預設由大到小才符合直覺，其餘預設遞增）
 */
function windowClause(
	config: NodeConfig,
	opts: { orderBy?: string; frame?: string; defaultDescending?: boolean } = {},
): string {
	const parts = toNameList(config.partitionBy, []);
	const orderBy = String(opts.orderBy ?? config.orderBy ?? "").trim();
	const desc =
		config.descending === undefined
			? Boolean(opts.defaultDescending)
			: Boolean(config.descending);

	const inner: string[] = [];
	if (parts.length > 0) inner.push(`PARTITION BY ${parts.map(qi).join(", ")}`);
	if (orderBy) inner.push(`ORDER BY ${qi(orderBy)}${desc ? " DESC" : ""}`);
	if (opts.frame) inner.push(opts.frame);

	return ` OVER (${inner.join(" ")})`;
}

/**
 * 別名去重：`SUM(amount)` 與 `AVG(amount)` 不會撞名，但
 * `SUM(amount)` 出現兩次就會產生兩個同名欄位（DuckDB 會照收，
 * 但下游引用會變成未定義行為）→ 第二個之後加 _2 / _3。
 */
function uniqueAlias(base: string, used: Set<string>): string {
	let name = base;
	let i = 2;
	while (used.has(name)) name = `${base}_${i++}`;
	used.add(name);
	return name;
}

/**
 * RENAME 的改名清單。
 * 新格式（renames 陣列）優先；空 / 缺 → 退回舊的 field → outputColumn 單一組。
 * from === to 的組會被丟掉（無意義，而且 EXCLUDE 後再同名會出錯）。
 */
function normalizeRenames(config: NodeConfig): { from: string; to: string }[] {
	const raw = Array.isArray(config.renames) ? config.renames : [];
	const list = raw
		.map((r) => ({
			from: String(r?.from ?? "").trim(),
			to: String(r?.to ?? "").trim(),
		}))
		.filter((r) => r.from && r.to && r.from !== r.to);
	if (list.length > 0) return list;

	const from = String(config.field ?? "").trim();
	const to = String(config.outputColumn ?? "").trim();
	return from && to && from !== to ? [{ from, to }] : [];
}

/**
 * 可視窗化的函數。只有這些呼叫後面會被插入 OVER ——
 * 不能對所有函數都插（`ROUND(x, 2) OVER (...)` 是錯的）。
 */
const WINDOW_FUNCS = new Set([
	"LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "NTH_VALUE",
	"SUM", "AVG", "COUNT", "MIN", "MAX", "STDDEV", "MEDIAN",
	"ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE",
	"CUME_DIST", "PERCENT_RANK",
]);

/**
 * 在運算式裡每個「視窗函數呼叫」後面插入 OVER 子句。
 *
 * 為什麼不能只在外層包一個 OVER：SQL 的 OVER **只綁定緊接在前的函數呼叫**。
 * 已對 DuckDB 實測：
 *   `(LAG(x,1)) OVER (…)`          → 語法錯誤
 *   `(LAG(x,1) - x) OVER (…)`      → 語法錯誤
 *   `LAG(x,1) OVER (…)`            → 正確
 *   `(LAG(x,1) OVER (…)) - x`      → 正確
 * 所以要逐個呼叫點插入，MULTI_ROW_FORMULA 才寫得出 `LAG(x,1) - x` 這種
 * 「與前一列相減」的常見運算式。
 *
 * 已經自己寫了 OVER 的呼叫會跳過（不重複插入）。
 * 字串字面值會被略過，裡面的括號不會干擾配對。
 */
function injectOver(expr: string, over: string): string {
	let out = "";
	let i = 0;
	while (i < expr.length) {
		const c = expr[i];

		// 字串字面值：整段複製，內部的 ( ) 不參與配對
		if (c === "'") {
			let j = i + 1;
			while (j < expr.length) {
				if (expr[j] === "'") {
					if (expr[j + 1] === "'") {
						j += 2;
						continue;
					}
					j += 1;
					break;
				}
				j += 1;
			}
			out += expr.slice(i, j);
			i = j;
			continue;
		}

		if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_]\w*/.exec(expr.slice(i))!;
			const name = m[0].toUpperCase();
			let k = i + m[0].length;
			while (k < expr.length && /\s/.test(expr[k])) k++;

			if (expr[k] === "(" && WINDOW_FUNCS.has(name)) {
				// 配對這個呼叫的括號
				let depth = 0;
				let p = k;
				for (; p < expr.length; p++) {
					if (expr[p] === "(") depth++;
					else if (expr[p] === ")") {
						depth--;
						if (depth === 0) break;
					}
				}
				out += expr.slice(i, p + 1);

				// 後面已經有 OVER 就不再插一次
				let q = p + 1;
				while (q < expr.length && /\s/.test(expr[q])) q++;
				if (expr.slice(q, q + 4).toUpperCase() !== "OVER") out += over;

				i = p + 1;
				continue;
			}

			out += m[0];
			i += m[0].length;
			continue;
		}

		out += c;
		i++;
	}
	return out;
}

/**
 * 依 edges 解析節點的上游資料表清單。
 * - 一般節點：首個上游即為來源表；無上游 → raw_data。
 * - JOIN：left handle 優先，其次 right handle；缺表時以 raw_data 補位。
 * - UNION：回傳「全部」上游（N 路合併），順序 = 連線進來的順序。
 * - 上游若由 FILTER 的 false 埠接入，則解析成該 FILTER 的 false 分支表。
 */
export function resolveSourceTables(
	nodeId: string,
	nodeType: string,
	edges: Edge[],
): string[] {
	const incoming = orderUpstreamEdges(nodeId, edges);
	const tables = incoming.map((e) =>
		branchTableName(e.source, e.sourceHandle),
	);

	if (nodeType === "JOIN" || nodeType === "APPEND_FIELDS" || nodeType === "FIND_REPLACE") {
		// 三個都是 left / right 雙輸入；缺表時以 raw_data 補位
		const left = tables[0] || "raw_data";
		const right = tables[1] || "raw_data";
		return [left, right];
	}
	// UNION 是 N 路合併：只取第一個上游會靜默丟掉其餘分支
	if (nodeType === "UNION") {
		return tables.length > 0 ? tables : ["raw_data"];
	}
	return tables.length > 0 ? [tables[0]] : ["raw_data"];
}

/**
 * 節點執行後，其結果會落在哪一張 DuckDB 表？
 * - VIZ_CHART 不建立輸出表，直接查上游 → 回傳上游表名。
 * - 其餘節點 → 回傳自身 nodeId（= CREATE OR REPLACE TEMP TABLE 的名稱）。
 * Data Drawer 用這個名稱做 SQL 分頁查詢。
 */
export function outputTableFor(
	nodeId: string,
	nodeType: string,
	edges: Edge[],
): string {
	if (nodeType === "VIZ_CHART") {
		return resolveSourceTables(nodeId, "FILTER", edges)[0] || "raw_data";
	}
	return nodeId;
}

/**
 * 產生「節點輸出表的 SELECT 本體」—— 不含 DDL 外殼、不含結尾分號。
 *
 * 這是整個引擎唯一的查詢生成來源：
 *   - generateSqlFromConfig() 加 `CREATE OR REPLACE TEMP TABLE` 外殼（即時執行用）
 *   - exporter.exportToSqlCte() 直接將本體放入 CTE（匯出用）
 * 兩者共用同一份邏輯 → 匯出的 SQL 與畫布實際執行的 SQL 永遠一致。
 */
export function compileNodeSelect(
	nodeId: string,
	nodeType: string,
	config: NodeConfig = {},
	upstreamNodeIds: string[] = [],
): string {
	const sourceTable =
		upstreamNodeIds.length > 0 ? upstreamNodeIds[0] : "raw_data";

	switch (nodeType) {
		case "INPUT_DUCKDB": {
			// 有上傳檔案 → 讀取 src_${nodeId}；未載入 → 預設 raw_data（提供即時回饋）
			const src = config.fileName
				? config.tableName || `src_${nodeId}`
				: "raw_data";
			return `SELECT * FROM ${qi(src)}`;
		}

		case "FILTER": {
			// true 分支。cond 為 NULL 的行不會落入這裡（SQL 三值邏輯），
			// 會由 false 分支的 NOT COALESCE(..., FALSE) 接收。
			return `SELECT * FROM ${qi(sourceTable)} WHERE ${filterCondition(config)}`;
		}

		case "FORMULA": {
			const outputCol = config.outputColumn || "amount_taxed";
			const expr = safeExpr(config.expression, "1");
			return `SELECT *, (${expr}) AS ${qi(outputCol)} FROM ${qi(sourceTable)}`;
		}

		case "SUMMARIZE": {
			// 多分組鍵 + 多聚合。groupBy 為明確空陣列 → 不分组（純聚合）。
			const groups = toNameList(config.groupBy, ["year"]);
			const aggs = normalizeAggregations(config);
			const used = new Set<string>(groups);

			const projections = [
				...groups.map(qi),
				...aggs.map((a) =>
					aggProjection(a, uniqueAlias(aggAlias(a), used)),
				),
			];

			const head = `SELECT ${projections.join(", ")} FROM ${qi(sourceTable)}`;
			return groups.length > 0
				? `${head} GROUP BY ${groups.map(qi).join(", ")}`
				: head;
		}

		case "JOIN": {
			const leftTable = upstreamNodeIds[0] || "raw_data";
			const rightTable = upstreamNodeIds[1] || "raw_data";
			const joinType = safeJoinType(config.joinType, "INNER");
			const leftKey = config.leftKey || "id";
			const rightKey = config.rightKey || "id";

			// 保留左右兩表全部欄位。舊版 `SELECT a.*` 會靜默丟掉右表所有欄位。
			// 同名欄位由 DuckDB 自動加序號後綴（id → id_1）——
			// 已對 duckdb-wasm 1.32.0（DuckDB v1.4.3）實測，不會報錯。
			return `SELECT a.*, b.* FROM ${qi(leftTable)} a ${joinType} JOIN ${qi(rightTable)} b ON a.${qi(leftKey)} = b.${qi(rightKey)}`;
		}

		case "SORT": {
			// field 優先（UI 表單綁定 field）；groupBy 保留作為 Hermes 舊 payload 的
			// fallback —— 但它現在可能是陣列（SUMMARIZE 的多分組鍵），取第一個即可。
			const legacy = Array.isArray(config.groupBy)
				? config.groupBy[0]
				: config.groupBy;
			const by = config.field || legacy || "id";
			const dir = config.descending ? " DESC" : "";
			return `SELECT * FROM ${qi(sourceTable)} ORDER BY ${qi(by)}${dir}`;
		}

		case "SELECT": {
			// 未設定欄位 → 全選（等同 passthrough）
			const cols = toNameList(config.columns, []);
			const proj = cols.length > 0 ? cols.map(qi).join(", ") : "*";
			return `SELECT ${proj} FROM ${qi(sourceTable)}`;
		}

		case "UNION": {
			// N 路合併。BY_NAME 依欄位名對齊（缺欄位補 NULL），
			// 這才是 Alteryx Union 的語意 —— 各分支經過不同 transform 後
			// 欄位順序通常不一致，按位置對齊會把資料接到錯的欄位上。
			const tables =
				upstreamNodeIds.length > 0 ? upstreamNodeIds : ["raw_data"];
			const keyword =
				safeUnionMode(config.unionMode, "BY_NAME") === "POSITION"
					? "UNION ALL"
					: "UNION ALL BY NAME";
			return tables
				.map((t) => `SELECT * FROM ${qi(t)}`)
				.join(`\n${keyword}\n`);
		}

		case "SAMPLE": {
			const n = intLit(config.sampleSize, 100);
			if (safeSampleMode(config.sampleMode, "FIRST") === "RANDOM") {
				// reservoir + 固定 seed：同一份資料重跑會拿到同一批樣本
				// （除錯 / 匯出重現時很重要）
				return `SELECT * FROM ${qi(sourceTable)} USING SAMPLE ${n} ROWS (reservoir, 42)`;
			}
			return `SELECT * FROM ${qi(sourceTable)} LIMIT ${n}`;
		}

		case "RENAME": {
			const pairs = normalizeRenames(config);
			if (pairs.length === 0) {
				// 未設定 → passthrough（不要產生語法不完整的 SQL）
				return `SELECT * FROM ${qi(sourceTable)}`;
			}
			// `* RENAME (a AS b)` 保留欄位原本位置。
			// 舊版用 `* EXCLUDE (a), a AS b`，效果一樣但會把新欄位搬到最後 ——
			// 對下游「按位置」的步驟（例如 UNION POSITION）是靜默的災難。
			// 已對 duckdb-wasm 1.32.0（DuckDB v1.4.3）實測支援 * RENAME。
			const list = pairs
				.map((p) => `${qi(p.from)} AS ${qi(p.to)}`)
				.join(", ");
			return `SELECT * RENAME (${list}) FROM ${qi(sourceTable)}`;
		}

		// ---------------------------------------------------------------
		// 資料清理組
		// ---------------------------------------------------------------
		case "UNIQUE": {
			const keys = toNameList(config.columns, []);
			// 沒有鍵 → 整列去重
			if (keys.length === 0) {
				return `SELECT DISTINCT * FROM ${qi(sourceTable)}`;
			}
			// DISTINCT ON：每個鍵只留第一列（Alteryx Unique 語意）
			return `SELECT DISTINCT ON (${keys.map(qi).join(", ")}) * FROM ${qi(sourceTable)}`;
		}

		case "IMPUTE": {
			const cols = toNameList(config.columns, []);
			if (cols.length === 0) return `SELECT * FROM ${qi(sourceTable)}`;
			const method = safeImputeMethod(config.method, "CONSTANT");
			const fill = lit(config.fillValue ?? "0");
			const proj = cols.map((c) =>
				method === "MEAN"
					? `COALESCE(${qi(c)}, AVG(${qi(c)}) OVER ()) AS ${qi(c)}`
					: `COALESCE(${qi(c)}, ${fill}) AS ${qi(c)}`,
			);
			// * REPLACE：覆蓋同名欄位且保留其原本位置
			return `SELECT * REPLACE (${proj.join(", ")}) FROM ${qi(sourceTable)}`;
		}

		case "DATA_CLEANSING": {
			const cols = toNameList(config.columns, []);
			if (cols.length === 0) return `SELECT * FROM ${qi(sourceTable)}`;
			const collapse = config.collapse === true;
			// 壓縮內部空白本身就包含去頭尾，所以 collapse 成立時 trim 必然成立
			const trim = collapse || config.trim !== false;
			const emptyToNull = config.emptyToNull !== false;

			const proj = cols.map((c) => {
				let e = qi(c);
				if (collapse) e = `regexp_replace(TRIM(${e}), '\\s+', ' ', 'g')`;
				else if (trim) e = `TRIM(${e})`;
				if (emptyToNull) e = `NULLIF(${e}, '')`;
				return `${e} AS ${qi(c)}`;
			});
			return `SELECT * REPLACE (${proj.join(", ")}) FROM ${qi(sourceTable)}`;
		}

		// ---------------------------------------------------------------
		// 樞紐 / 轉置組
		// ---------------------------------------------------------------
		case "CROSS_TAB": {
			const pivot = config.pivotColumn || "category";
			const value = config.valueColumn || "amount";
			const fn = safeFunc(config.aggFunc, "SUM");
			const groups = toNameList(config.groupBy, []);
			const groupClause =
				groups.length > 0 ? ` GROUP BY ${groups.map(qi).join(", ")}` : "";
			// DuckDB 的 PIVOT 語法：展開 pivot 欄的值，每組分組鍵一列
			return `PIVOT ${qi(sourceTable)} ON ${qi(pivot)} USING ${fn}(${qi(value)})${groupClause}`;
		}

		case "TRANSPOSE": {
			const cols = toNameList(config.columns, []);
			if (cols.length === 0) return `SELECT * FROM ${qi(sourceTable)}`;
			const nameCol = config.nameColumn || "metric";
			const valueCol = config.valueColumn || "value";
			// 未列在 ON 內的欄位會被自動保留（作為識別欄）
			return `UNPIVOT ${qi(sourceTable)} ON ${cols.map(qi).join(", ")} INTO NAME ${qi(nameCol)} VALUE ${qi(valueCol)}`;
		}

		case "TEXT_TO_COLUMNS": {
			const field = config.field || "name";
			const sep = String(config.separator ?? ",");
			const names = toNameList(config.outputColumns, []);
			if (names.length === 0) return `SELECT * FROM ${qi(sourceTable)}`;
			// string_split 回傳 list，越界的索引是 NULL（不是空字串）
			const proj = names.map(
				(n, i) =>
					`(string_split(${qi(field)}, ${strLit(sep)}))[${i + 1}] AS ${qi(n)}`,
			);
			return `SELECT *, ${proj.join(", ")} FROM ${qi(sourceTable)}`;
		}

		case "REGEX": {
			const field = config.field || "name";
			const rawPattern = String(config.pattern ?? "");
			// 沒有樣式就 passthrough —— 寧可什麼都不做，也不要產生一個永遠 false 的欄位
			if (!rawPattern) return `SELECT * FROM ${qi(sourceTable)}`;
			// 忽略大小寫摺進 pattern 的 inline (?i)，兩個引擎的 regex 都支援；
			// 不走各引擎自己的旗標參數（Polars 多數 str 方法根本沒有 case 參數）。
			const pattern = strLit(regexPattern(rawPattern, config.caseInsensitive));
			const mode = safeRegexMode(config.regexMode);

			if (mode === "PARSE") {
				const names = toNameList(config.outputColumns, []);
				if (names.length === 0) return `SELECT * FROM ${qi(sourceTable)}`;
				// group 由 1 起算。實測：未命中時 DuckDB 回**空字串**而不是 NULL，
				// 而 Polars 的 str.extract 回 NULL —— 這是已記錄的跨引擎差異。
				const proj = names.map(
					(n, i) => `regexp_extract(${qi(field)}, ${pattern}, ${i + 1}) AS ${qi(n)}`,
				);
				return `SELECT *, ${proj.join(", ")} FROM ${qi(sourceTable)}`;
			}

			if (mode === "REPLACE") {
				const out = config.outputColumn || "regex_replaced";
				// 'g' = 全域取代（Alteryx RegEx Replace 的語意）；不加旗標只換第一個命中
				return (
					`SELECT *, regexp_replace(${qi(field)}, ${pattern}, ` +
					`${strLit(config.replacement ?? "")}, 'g') AS ${qi(out)} FROM ${qi(sourceTable)}`
				);
			}

			const out = config.outputColumn || "regex_match";
			return (
				`SELECT *, regexp_matches(${qi(field)}, ${pattern}) AS ${qi(out)} ` +
				`FROM ${qi(sourceTable)}`
			);
		}

		// ---------------------------------------------------------------
		case "MULTI_FIELD_FORMULA": {
			const cols = dedupe(toNameList(config.columns, []));
			if (cols.length === 0) return `SELECT * FROM ${qi(sourceTable)}`;

			const raw = safeExpr(config.expression, "1");
			// 沒有 _CurrentField_ 就等於對每個欄位套用同一個常數運算式。
			// 在 OVERWRITE 模式下那會把每一欄都寫成同一個值 —— 是不可逆的
			// 資料破壞，而畫布上看起來完全正常。所以退回 passthrough，
			// 由設定表單的提示告訴使用者少了佔位符。
			if (!hasCurrentField(raw)) return `SELECT * FROM ${qi(sourceTable)}`;

			const mode = safeMultiFieldOutputMode(config.outputMode);
			if (mode === "NEW_FIELD") {
				const suffix = safeNewFieldSuffix(config.newFieldSuffix);
				const proj = cols.map(
					(c) => `(${applyCurrentField(raw, qi(c))}) AS ${qi(c + suffix)}`,
				);
				return `SELECT *, ${proj.join(", ")} FROM ${qi(sourceTable)}`;
			}

			// OVERWRITE：`SELECT * REPLACE` 是就地改寫，欄位順序不變。
			// 這也是 DATA_CLEANSING / IMPUTE 用的同一個慣用法。
			const proj = cols.map(
				(c) => `(${applyCurrentField(raw, qi(c))}) AS ${qi(c)}`,
			);
			return `SELECT * REPLACE (${proj.join(", ")}) FROM ${qi(sourceTable)}`;
		}

		// ---------------------------------------------------------------
		// 視窗 / 序列組
		// ---------------------------------------------------------------
		case "MULTI_ROW_FORMULA": {
			const out = config.outputColumn || "prev_amount";
			// 運算式本身可含視窗函數（LAG / LEAD / SUM…），由使用者負責寫對；
			// OVER 由節點補上，而且是**逐個呼叫點**補（見 injectOver 的說明）。
			const expr = safeExpr(config.expression, "1");
			const over = windowClause(config, { orderBy: config.orderBy || "id" });
			return `SELECT *, (${injectOver(expr, over)}) AS ${qi(out)} FROM ${qi(sourceTable)}`;
		}

		case "RUNNING_TOTAL": {
			const target = config.target || "amount";
			const out = config.outputColumn || `${target}_running`;
			// 明確的 frame：累計是「到目前這一列為止」，
			// 不寫 frame 時 ORDER BY 的預設框會因函數而異，容易出現整表總和。
			const over = windowClause(config, {
				orderBy: config.orderBy || "id",
				frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
			});
			return `SELECT *, SUM(${qi(target)})${over} AS ${qi(out)} FROM ${qi(sourceTable)}`;
		}

		case "RANK": {
			const target = config.target || "amount";
			const out = config.outputColumn || `${target}_rank`;
			const fn = safeRankMethod(config.method, "RANK");
			// 排名預設「大者在先」—— 沒特別講的話，第一名應該是最高的那個
			const over = windowClause(config, {
				orderBy: config.orderBy || target,
				defaultDescending: true,
			});
			return `SELECT *, ${fn}()${over} AS ${qi(out)} FROM ${qi(sourceTable)}`;
		}

		// ---------------------------------------------------------------
		// 進階連接組
		// ---------------------------------------------------------------
		case "APPEND_FIELDS": {
			const leftTable = upstreamNodeIds[0] || "raw_data";
			const rightTable = upstreamNodeIds[1] || "raw_data";
			// 笛卡爾積：列數 = 左 × 右，資料量大時會爆。
			// 一定要給別名 —— 兩個輸入預設都是 raw_data（或使用者把同一張表
			// 接了兩次）時，`SELECT * FROM x CROSS JOIN x` 會直接
			// "Ambiguous reference to table x"。
			return `SELECT a.*, b.* FROM ${qi(leftTable)} a CROSS JOIN ${qi(rightTable)} b`;
		}

		case "FIND_REPLACE": {
			const leftTable = upstreamNodeIds[0] || "raw_data";
			const rightTable = upstreamNodeIds[1] || "raw_data";
			const findField = config.findField || "code";
			const lookupField = config.lookupField || "code";
			const replaceField = config.replaceField || "label";
			const out = String(config.outputColumn ?? "").trim() || findField;
			const keep = safeUnmatched(config.unmatched, "KEEP") === "KEEP";
			const fallback = keep ? `a.${qi(findField)}` : "NULL";

			// ⚠ 型別限制（刻意不自動解）：KEEP 會讓取回值與來源鍵放進同一個
			// COALESCE，DuckDB 要求兩邊有共同型別，所以兩欄型別必須相容。
			// 例如「用 id(INTEGER) 去查 name(VARCHAR)」會直接 binder error：
			//   Cannot mix values of type VARCHAR and INTEGER in COALESCE operator
			// 這裡不擅自 CAST —— 一律轉 VARCHAR 會讓「數字查數字」的替換也變成
			// 文字，那是更難察覺的錯。寧可讓它大聲失敗。
			// （DuckDB 沒有 `CAST(x AS typeof(y))`，靜態也拿不到欄位型別，
			//   所以無法在不犧牲正確性的前提下自動處理。）
			const pick = `COALESCE(b.${qi(replaceField)}, ${fallback}) AS ${qi(out)}`;
			// 輸出欄位與來源鍵同名 → 就地覆蓋（* REPLACE 才不會多出重複欄位）；
			// 用了新名字 → 直接附加在最後。
			return out === findField
				? `SELECT a.* REPLACE (${pick}) FROM ${qi(leftTable)} a LEFT JOIN ${qi(rightTable)} b ON a.${qi(findField)} = b.${qi(lookupField)}`
				: `SELECT a.*, ${pick} FROM ${qi(leftTable)} a LEFT JOIN ${qi(rightTable)} b ON a.${qi(findField)} = b.${qi(lookupField)}`;
		}

		case "VIZ_CHART": {
			// BI 節點不建立輸出表 —— 直接查上游（上限 2000 列，避免繪圖佔用過多記憶體）
			return `SELECT * FROM ${qi(sourceTable)} LIMIT ${intLit(2000, 2000)}`;
		}

		default:
			return `SELECT * FROM ${qi(sourceTable)}`;
	}
}

/** 節點執行後會不會建立輸出表？（VIZ_CHART 是純檢視節點，不會） */
export function producesOutputTable(nodeType: string): boolean {
	return nodeType !== "VIZ_CHART";
}

/**
 * 節點執行時真正要跑的 SQL 語句清單。
 *
 * 大多數節點是 1 條；FILTER 是 2 條（true 表 + false 表）。
 * 之所以能用單一次 `query()` 送出多條語句：已對 duckdb-wasm 1.32.0
 * 實測 `"CREATE ...; CREATE ...;"` 兩條都會生效（DuckDB 的 query 路徑本身
 * 支援多語句），因此不需要在引擎 RPC 介面上另開一個 op。
 *
 * @param opts.falseBranch 是否一併建立 FILTER 的 false 分支表。
 *   預設 true —— 寧可多寫一次表，也不要讓下游讀到不存在的表。
 *   呼叫方（畫布）在確認 false 埠沒有任何下游時可傳 false 省成本。
 */
export function compileNodeStatements(
	nodeId: string,
	nodeType: string,
	config: NodeConfig = {},
	upstreamNodeIds: string[] = [],
	opts: { falseBranch?: boolean } = {},
): string[] {
	const body = compileNodeSelect(nodeId, nodeType, config, upstreamNodeIds);

	// VIZ_CHART 不建表，只回傳一個有界的 SELECT
	if (!producesOutputTable(nodeType)) return [`${body};`];

	const statements = [
		`CREATE OR REPLACE TEMP TABLE ${qi(nodeId)} AS ${body};`,
	];

	if (nodeType === "FILTER" && opts.falseBranch !== false) {
		const sourceTable =
			upstreamNodeIds.length > 0 ? upstreamNodeIds[0] : "raw_data";
		statements.push(
			`CREATE OR REPLACE TEMP TABLE ${qi(falseBranchTable(nodeId))} AS SELECT * FROM ${qi(sourceTable)} WHERE NOT COALESCE((${filterCondition(config)}), FALSE);`,
		);
	}

	return statements;
}

/**
 * 即時執行用 SQL 字串（多條語句以換行分隔）。
 * 表名一律 quote：nodeId 雖然是自動生成的 hex，但統一處理更安全。
 */
export function generateSqlFromConfig(
	nodeId: string,
	nodeType: string,
	config: NodeConfig = {},
	upstreamNodeIds: string[] = [],
	opts: { falseBranch?: boolean } = {},
): string {
	return compileNodeStatements(
		nodeId,
		nodeType,
		config,
		upstreamNodeIds,
		opts,
	).join("\n");
}
