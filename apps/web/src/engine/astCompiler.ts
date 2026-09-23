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
	safeFuzzyJoinType,
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
	safeSplitMode,
	safeMatchFunc,
	matchIsSimilarity,
	matchThreshold,
	duckdbMatchFn,
	safePrefilter,
	safeScoreColumn,
	safeSpatialPredicate,
	SPATIAL_DWITHIN,
	duckdbSpatialFn,
	safeDistanceUnit,
	safeSpatialJoinType,
	safeDistanceColumn,
	safeAssertCheck,
	safeAssertBound,
	safeAssertLabel,
	intLit,
} from "./sql";
import type { Edge } from "@xyflow/react";
// 節點的輸入埠數量（arity）只有目錄一份真相，這裡不再自己抄一份名單。
import { NODE_CATALOG } from "./nodeCatalog";
import type { AlteryxNodeType } from "../types/workbench";
// 節點 config 的形狀宣告在 types/nodeConfig.ts —— 那是唯一一份。
// 本檔以前手抄了一份 NodeConfig（與另外兩份互不檢查），現已收斂成別名。
// 用 import type 是刻意的：本檔會被 Web Worker import，型別 import 會被完全抹除。
import type {
	NodeConfig,
	SummarizeAggregation,
	RenamePair,
} from "../types/nodeConfig";

// 對外重新匯出，維持既有 API（這三個名字原本都是從本檔 export 的）。
export type { NodeConfig, SummarizeAggregation, RenamePair };

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

	// 雙輸入（left / right）節點由目錄的 arity 決定，不在這裡另抄一份名單。
	// 抄一份的下場就是新增節點時忘了改 —— 而症狀是「第二個輸入被靜默丟掉」，
	// 畫布上看起來完全正常。FUZZY_JOIN 就是這樣漏掉過一次。
	const spec = NODE_CATALOG[nodeType as AlteryxNodeType];
	if (spec?.inputs === 2) {
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

		case "FUZZY_JOIN": {
			const leftTable = upstreamNodeIds[0] || "raw_data";
			const rightTable = upstreamNodeIds[1] || "raw_data";
			const leftKey = String(config.leftKey ?? "").trim();
			const rightKey = String(config.rightKey ?? "").trim();

			// 沒有鍵就無從比對。退回左表的 passthrough 而不是猜一個鍵 ——
			// 猜錯會產生一個「跑得動但完全錯」的笛卡兒積。
			if (!leftKey || !rightKey) {
				return `SELECT * FROM ${qi(leftTable)}`;
			}

			// 忽略大小寫：兩個引擎的相似度函數都區分大小寫（實測
			// jaro_winkler_similarity('hello','HELLO') = 0.0），所以只能先 LOWER 兩邊。
			//
			// 一定要加表別名 a. / b.：左右鍵同名（最常見的情況，兩邊都叫 name）
			// 時裸欄位名會讓 DuckDB 直接報 "Ambiguous reference to column name"，
			// 而 `SELECT a.*, b.*` 這個寫法本身是合法的 —— 錯只錯在 ON 子句。
			const ci = config.caseInsensitive === true;
			const lExpr = ci ? `lower(a.${qi(leftKey)})` : `a.${qi(leftKey)}`;
			const rExpr = ci ? `lower(b.${qi(rightKey)})` : `b.${qi(rightKey)}`;

			const fn = safeMatchFunc(config.matchFunc);
			let condition: string;
			if (fn === "EXACT") {
				condition = `${lExpr} = ${rExpr}`;
			} else {
				// 方向：相似度是下限（>=），編輯距離是上限（<=）。
				// 這個方向不能憑感覺寫 —— 寫反的話「越像越不被選中」，而且 SQL 合法。
				const op = matchIsSimilarity(fn) ? ">=" : "<=";
				const threshold = matchThreshold(config.threshold, fn);
				condition = `${duckdbMatchFn(fn)}(${lExpr}, ${rExpr}) ${op} ${threshold}`;
			}

			// 候選縮減：把條件接在原本的相似度條件前面。放在 ON 裡（而不是 WHERE）
			// 是刻意的 —— LEFT JOIN 下 WHERE 會把未命中的列也濾掉，語意就變成 INNER。
			if (safePrefilter(config.prefilter) === "FIRST_CHAR") {
				condition = `substr(${lExpr}, 1, 1) = substr(${rExpr}, 1, 1) AND ${condition}`;
			}

			const joinType = safeFuzzyJoinType(config.joinType, "INNER");
			const score = safeScoreColumn(config.scoreColumn);
			const scoreCol =
				score && fn !== "EXACT"
					? `, ${duckdbMatchFn(fn)}(${lExpr}, ${rExpr}) AS ${qi(score)}`
					: "";

			// 保留左右兩表全部欄位（與 JOIN 一致）；同名欄位由 DuckDB 自動加序號後綴。
			return `SELECT a.*, b.*${scoreCol} FROM ${qi(leftTable)} a ${joinType} JOIN ${qi(rightTable)} b ON ${condition}`;
		}

		case "SPATIAL_MATCH": {
			const leftTable = upstreamNodeIds[0] || "raw_data";
			const rightTable = upstreamNodeIds[1] || "raw_data";

			// 每側的幾何有兩條路：WKT 欄位，或 lon/lat 兩欄。WKT 優先 ——
			// 它能表達非點幾何（多邊形、線），表達力嚴格更強。
			//
			// WKT 一律包 TRY()：實測壞掉的 WKT 會讓 ST_GeomFromText **拋錯**
			// （Invalid Input Error: Expected geometry type...），而不是回 NULL。
			// 不包的話，一千萬列裡有一列 WKT 壞掉就整個 join 掛掉；包了之後那一列
			// 變成 NULL 幾何 → 謂詞回 NULL → 不命中，也就是 GIS 界的慣例行為。
			const geomExpr = (
				wktField: unknown,
				lonField: unknown,
				latField: unknown,
				alias: string,
			): string | null => {
				const wkt = String(wktField ?? "").trim();
				if (wkt) return `TRY(ST_GeomFromText(${alias}.${qi(wkt)}))`;
				const lon = String(lonField ?? "").trim();
				const lat = String(latField ?? "").trim();
				if (lon && lat) {
					// 實測 ST_Point(x, y) → ST_X = 第一個參數，所以是 (經度, 緯度)。
					// TRY_CAST：欄位可能是 VARCHAR（CSV 進來的大多數經緯度都是），
					// ST_Point 收到字串會直接報錯。
					return `ST_Point(TRY_CAST(${alias}.${qi(lon)} AS DOUBLE), TRY_CAST(${alias}.${qi(lat)} AS DOUBLE))`;
				}
				return null;
			};

			const lGeom = geomExpr(
				config.leftGeometryField, config.leftLonField, config.leftLatField, "a");
			const rGeom = geomExpr(
				config.rightGeometryField, config.rightLonField, config.rightLatField, "b");

			// 幾何無從取得就退回左表 passthrough，不猜欄位名 ——
			// 猜錯會產生一個「跑得動但完全錯」的笛卡兒積（與 FUZZY_JOIN 同理）。
			if (!lGeom || !rGeom) return `SELECT * FROM ${qi(leftTable)}`;

			const predicate = safeSpatialPredicate(config.spatialPredicate);
			const unit = safeDistanceUnit(config.distanceUnit);

			// 距離表達式是這一節唯一的真相：篩選用它、輸出欄位也用它。
			// 分開寫的話就會出現「門檻換了單位、輸出欄位沒換」這種半套 ——
			// 而且不會報錯，只是數字悄悄地差了 111194.93 倍。
			const distanceExpr =
				unit === "METERS"
					? `ST_Distance_Sphere(${lGeom}, ${rGeom})`
					: `ST_Distance(${lGeom}, ${rGeom})`;

			let condition: string;
			if (predicate === SPATIAL_DWITHIN) {
				// 刻意不呼叫 ST_DWithin：這樣距離的單位轉換只發生在一個地方，
				// 而且「篩選」與「輸出」用的一定是同一個表達式。
				// 門檻走 lit()：非數字會被它擋掉，沒有引號可以逃逸。
				condition = `${distanceExpr} <= ${lit(config.distance ?? 0)}`;
			} else {
				condition = `${duckdbSpatialFn(predicate)}(${lGeom}, ${rGeom})`;
			}

			const joinType = safeSpatialJoinType(config.joinType, "INNER");
			const distCol = safeDistanceColumn(config.distanceColumn);
			const distSelect = distCol ? `, ${distanceExpr} AS ${qi(distCol)}` : "";

			// 與 JOIN / FUZZY_JOIN 一致：保留左右兩表全部欄位。
			return `SELECT a.*, b.*${distSelect} FROM ${qi(leftTable)} a ${joinType} JOIN ${qi(rightTable)} b ON ${condition}`;
		}

		case "OUTPUT": {
			// 輸出節點不改資料，只是把上游結果「命名」成一個明確的終點。
			// 它照樣建一張以自己 id 為名的表，於是：
			//   - UI 的下載鈕可以讀這張表（outputTableFor 回傳 nodeId）
			//   - 匯出的 CTE 腳本會把它當成最終 SELECT 的來源
			// 這樣「下載到的」與「畫布上看到的」保證是同一份資料。
			return `SELECT * FROM ${qi(sourceTable)}`;
		}

		case "ASSERT": {
			// 本體是 passthrough —— 檢查不改變資料，只決定「要不要讓流程繼續」。
			// 守門陳述是**額外的一條語句**，由 compileNodeStatements 補上。
			//
			// 為什麼不把檢查塞進本體（例如 WHERE 掉違反的列）：那會讓 ASSERT
			// 變成一個「悄悄刪資料」的節點，而它的職責剛好相反 —— 資料不對時
			// 要大聲失敗，不是安靜地少幾列。
			return `SELECT * FROM ${qi(sourceTable)}`;
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

			// 兩種切法回傳的都是 list，越界的索引都回 NULL（已實測），
			// 所以下面的取值方式不用分模式。
			let split: string;
			if (safeSplitMode(config.splitMode) === "REGEX") {
				// 空樣式會讓 regexp_split_to_array 對每個字元切一刀（不是報錯），
				// 產出一堆沒有意義的欄位。與 REGEX 節點一致：沒有樣式就 passthrough。
				if (!sep) return `SELECT * FROM ${qi(sourceTable)}`;
				split = `regexp_split_to_array(${qi(field)}, ${strLit(regexPattern(sep, config.caseInsensitive))})`;
			} else {
				split = `string_split(${qi(field)}, ${strLit(sep)})`;
			}

			const proj = names.map((n, i) => `(${split})[${i + 1}] AS ${qi(n)}`);
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
 * PREDICATE 的否定條件（已含 COALESCE）。
 *
 * 抽出來是因為**兩個地方要用同一份**：
 *   - DuckDB 的守門（`error()`）問「有幾列讓述句為假」
 *   - dbt 的 singular test 問「哪些列讓述句為假」
 * 條件若各寫一份，遲早會有一邊忘記 COALESCE，於是 NULL 述句在一邊算違反、
 * 在另一邊不算 —— 而那種不一致只會在真的踩到 NULL 時才出現。
 */
export function assertPredicateNegation(config: NodeConfig): string {
	// NOT COALESCE(pred, FALSE) 而非 NOT (pred)：pred 為 NULL 時 DuckDB 的
	// NOT 仍是 NULL，那一列會「不算違反」而溜過去 —— 但述句無法判斷本身
	// 就是資料有問題。實測 bad 資料上 `amount > 0` 抓到 2 列（負數 + NULL），
	// naive 版只抓到 1 列。
	return `NOT COALESCE((${safeExpr(config.assertPredicate, "TRUE")}), FALSE)`;
}

/**
 * ROW_COUNT 的越界條件（給 WHERE / HAVING 用，欄位名固定為 `n`）。
 *
 * 兩個邊界都沒填 → null（= 不檢查），而不是一個永遠成立的條件。
 */
export function assertRowCountBreach(config: NodeConfig): string | null {
	const min = safeAssertBound(config.assertMin);
	const max = safeAssertBound(config.assertMax);
	if (min === null && max === null) return null;
	const conds: string[] = [];
	// 邊界用裸數字，**不經 intLit** —— intLit 會 Math.floor 並把負數夾成 0
	// （它原本是給 LIMIT/OFFSET 用的）。safeAssertBound 已保證是有限數字。
	if (min !== null) conds.push(`n < ${min}`);
	if (max !== null) conds.push(`n > ${max}`);
	return conds.join(" OR ");
}

/**
 * ASSERT 的守門陳述。
 *
 * 機制是**實測**出來的，不是假設。DuckDB 有 scalar 函式 `error(msg)`，會讓整個
 * query 失敗；關鍵是它**不會被常數折疊**，所以放在外層的 WHERE 之後就只有真的
 * 違反時才觸發：
 *   SELECT error('boom') FROM (VALUES (1)) t(a) WHERE a = 2;  → OK（0 列命中）
 *   SELECT error('boom') FROM (VALUES (1)) t(a) WHERE a = 1;  → Invalid Input Error: boom
 *
 * 兩個被實測淘汰的替代方案（不要走回去）：
 *   - `1 / 0` → 回 Infinity，**不會**拋錯。
 *   - `ALTER TABLE ... ADD CONSTRAINT CHECK` → 這個 build 未實作
 *     （Not implemented Error: No support for that ALTER TABLE option yet!）。
 *
 * 四個檢查共用同一個形狀：先在子查詢裡把「違反的數量」算成 n，外層再據此決定
 * 要不要呼叫 error()。這樣做有兩個好處：
 *   1. 訊息可以帶上**真實數字**（「有 1 列 NULL」而不是「有 NULL」）。
 *   2. error() 的參數相依於資料，因此不可能被最佳化器提前求值。
 *
 * 訊息一律由這裡組，不讓使用者自由填寫 —— 它會變成 error() 的參數，那就是一條
 * 字串注入路徑。使用者可控的只有 assertLabel，而它已被 safeAssertLabel 收斂。
 */
function assertGuardStatement(nodeId: string, config: NodeConfig): string | null {
	const check = safeAssertCheck(config.assertCheck);
	const table = qi(nodeId);
	const label = safeAssertLabel(config.assertLabel, check);
	// 訊息拆成「前綴 + 數字 + 後綴」三段，**每一段各自過 strLit**。
	//
	// 為什麼不能像第一版那樣直接把字串插進 '...'：訊息裡含欄位名，而欄位名是
	// 使用者可控的。一個叫 `a'b` 的欄位就會提早關掉字面值，變成注入路徑。
	// strLit 會把 ' 加倍，所以三段都走它。數字則單獨用 CAST(n AS VARCHAR) 串接。
	//
	// 反面教材（第一版的寫法，已修）：
	//   error('ASSERT x: ' || CAST(n AS VARCHAR) || ' 列 "a'b" 為 NULL')
	const fail = (suffix: string, prefix = `ASSERT ${label}: `) =>
		`error(${strLit(prefix)} || CAST(n AS VARCHAR) || ${strLit(suffix)})`;

	switch (check) {
		case "NOT_NULL": {
			const col = toNameList(config.assertColumn, ["id"])[0] || "id";
			return (
				`SELECT ${fail(` 列「${col}」為 NULL`)} ` +
				`FROM (SELECT COUNT(*) AS n FROM ${table} WHERE ${qi(col)} IS NULL) WHERE n > 0;`
			);
		}

		case "UNIQUE": {
			// 逐欄 quote。把 "a, b" 當成單一識別字會得到
			// Binder Error: Referenced column "a, b" not found —— 探針踩過。
			const cols = toNameList(config.assertColumn, ["id"]);
			const key = cols.map(qi).join(", ");
			const shown = cols.join(" + ");
			return (
				`SELECT ${fail(` 組組合鍵「${shown}」重複`)} ` +
				`FROM (SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} GROUP BY ${key} HAVING COUNT(*) > 1)) ` +
				`WHERE n > 0;`
			);
		}

		case "ROW_COUNT": {
			const min = safeAssertBound(config.assertMin);
			const max = safeAssertBound(config.assertMax);
			// 越界條件由 assertRowCountBreach 提供 —— dbt 的 singular test
			// 用的是同一份，所以兩邊不可能對「怎樣算越界」有不同看法。
			// 邊界用裸數字，**不經 intLit**（它會把負數夾成 0）。
			const breach = assertRowCountBreach(config);
			// 兩個都沒填 = 不檢查。回 null 讓整條守門都不產生，而不是產生一條
			// 永遠成立的語句 —— 那只是每次執行都白跑一次 COUNT(*)。
			if (breach === null) return null;
			const range =
				min !== null && max !== null
					? `${min}..${max}`
					: min !== null
						? `>= ${min}`
						: `<= ${max}`;
			return (
				`SELECT ${fail(` 不在 ${range} 之內`, `ASSERT ${label}: 列數 `)} ` +
				`FROM (SELECT COUNT(*) AS n FROM ${table}) WHERE ${breach};`
			);
		}

		case "PREDICATE": {
			// 否定條件由 assertPredicateNegation 提供 —— dbt 的 singular test
			// 用同一份。safeExpr 在裡面做結構性拒絕（擋多語句與註解）。
			return (
				`SELECT ${fail(" 列讓述句為假")} ` +
				`FROM (SELECT COUNT(*) AS n FROM ${table} WHERE ${assertPredicateNegation(config)}) ` +
				`WHERE n > 0;`
			);
		}

		default:
			return null;
	}
}

/**
 * 節點執行時真正要跑的 SQL 語句清單。
 *
 * 大多數節點是 1 條；FILTER 是 2 條（true 表 + false 表）；
 * ASSERT 是 2 條（passthrough 表 + 守門）。
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

	// 需要 DuckDB 擴充的節點，前面補一句 LOAD。
	//
	// 為什麼非補不可（實測，不是保險起見）：出貨的 duckdb-wasm 把 spatial
	// **靜態連結**進去了，所以 `LOAD spatial` 會成功、而 `INSTALL spatial` 是
	// no-op（installed 永遠是 false，因為 wasm 版沒有網路）。但一條**全新連線**
	// 預設是沒載入的 —— 直接呼叫會得到
	//   Catalog Error: Scalar Function with name "st_intersects" is not in the
	//   catalog, but it exists in the spatial extension
	// 所以這句是必要的，而且重複執行無害（同一批語句裡 LOAD 兩次也沒問題）。
	const statements: string[] = requiredExtensions(nodeType).map((ext) => `LOAD ${ext};`);

	// VIZ_CHART 不建表，只回傳一個有界的 SELECT
	if (!producesOutputTable(nodeType)) {
		statements.push(`${body};`);
		return statements;
	}

	statements.push(`CREATE OR REPLACE TEMP TABLE ${qi(nodeId)} AS ${body};`);

	if (nodeType === "FILTER" && opts.falseBranch !== false) {
		const sourceTable =
			upstreamNodeIds.length > 0 ? upstreamNodeIds[0] : "raw_data";
		statements.push(
			`CREATE OR REPLACE TEMP TABLE ${qi(falseBranchTable(nodeId))} AS SELECT * FROM ${qi(sourceTable)} WHERE NOT COALESCE((${filterCondition(config)}), FALSE);`,
		);
	}

	// ASSERT 的守門排在建表**之後**，這是刻意的：守門拋錯時表已經存在，
	// 所以使用者可以去 Data Drawer 直接看是哪幾列違反（實測確認表會留下）。
	// 若反過來先驗再建表，失敗時就只剩一句訊息、看不到證據。
	if (nodeType === "ASSERT") {
		const guard = assertGuardStatement(nodeId, config);
		if (guard) statements.push(guard);
	}

	return statements;
}

/**
 * 這個節點型別需要哪些 DuckDB 擴充（會在語句前面補 LOAD）。
 *
 * 用函式而不是散落的 if，是為了讓「需要擴充的節點」只有一處真相 ——
 * 匯出的 SQL 腳本（exporter.ts）也要問同一個問題。
 */
export function requiredExtensions(nodeType: string): string[] {
	return nodeType === "SPATIAL_MATCH" ? ["spatial"] : [];
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
