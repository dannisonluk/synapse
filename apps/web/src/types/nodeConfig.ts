// apps/web/src/types/nodeConfig.ts
// 節點 config 物件的**唯一**型別宣告。
//
// 為什麼要有這個檔案：
//   在加入它之前，同一個 config 形狀被手抄了三份，而且**彼此沒有任何引用**：
//     1. types/workbench.ts                      的 ASTNodeConfig        （存檔 / workflow JSON）
//     2. engine/astCompiler.ts                   的 NodeConfig           （SQL 編譯器）
//     3. components/nymph/nodes/AlteryxNode.tsx  的 AlteryxNodeConfig    （設定表單）
//   三份互不檢查，所以新增一個欄位要改三個地方，少改任何一個都只會在「那一側」
//   炸開。加 TEXT_TO_COLUMNS 的 splitMode 那一輪，光 `TS2339` 就出現 10 次。
//   （VizChartNode.tsx 還藏了第四份 VizChartConfig，見檔尾說明。）
//
// 現在：唯一宣告在這裡，其餘兩處只是別名：
//     engine/astCompiler.ts   → import type { NodeConfig } from "../types/nodeConfig"
//     components/.../AlteryxNode.tsx → export type AlteryxNodeConfig = NodeConfig
//   加欄位只要改本檔一行，其餘兩側自動跟上。
//
// 本檔案**刻意零 import**（尤其不可 import React）：
//   engine/astCompiler.ts 會被 Web Worker import，而元件檔會 import 本檔；
//   保持零依賴才不會把 React 拖進 worker bundle。
//
// 設計取捨：為什麼不直接從 nodeCatalog.ts 推導？
//   目錄的 ConfigFieldSpec 描述「表單會產生什麼形狀」，本型別必須描述
//   「編譯器容忍什麼形狀」——兩者刻意不同：
//     - groupBy：目錄宣告 fieldList（string[]），但編譯器還要吃舊格式 "a, b"（string）
//     - func：舊版單一聚合的 fallback，目錄已不宣告，編譯器仍必須支援舊 workflow
//     - rowCount / columnCount：UI 註冊本機檔案後**寫進去**的，不是使用者可編輯欄位
//   直接推導會得到一個比執行期現實更窄的型別，正好是本專案一路在修的
//   「型別說沒問題、跑起來壞掉」。所以分工是：
//     目錄  → 有哪些欄位、給 agent 與 Palette 看
//     本檔  → config 物件的形狀
//   兩者以 scripts/verify.mjs 第 11 節的斷言對齊（雙向：目錄欄位 ⊆ 本檔鍵、
//   本檔多出來的鍵必須在明示白名單內）。

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

/**
 * 形狀代號 → TypeScript 值型別。
 *
 * 代號只是「值的種類」，與 nodeCatalog 的 ConfigFieldKind 不是同一套東西：
 * 後者決定 UI 用哪個控件，前者只描述形狀。刻意不共用，避免兩者被誤認為要同步。
 */
interface ConfigValueType {
	string: string;
	number: number;
	boolean: boolean;
	"string[]": string[];
	/** groupBy 同時接受新格式 string[] 與舊格式 string（含 "a, b" 逗號分隔） */
	"string|string[]": string | string[];
	aggList: SummarizeAggregation[];
	pairList: RenamePair[];
	/**
	 * 唯一的封閉選項集。
	 *
	 * 規則：enum 欄位一律用 "string"。目錄宣告了值的集合（joinType、op、regexMode…），
	 * 但那些值都是**外部輸入**（存檔、AI patch），編譯器必須容忍任意字串再走 safe*
	 * 白名單 —— 型別收緊只會製造假的安心，並且讓表單的 e.target.value 到處要 cast。
	 * 只有 chartType 例外：VizChartNode 真的對它做 switch（renderChart 分 BAR / PIE / …），
	 * 需要窄型別才有編譯期保障，所以為它開一個具名 kind。
	 */
	chart: "BAR" | "LINE" | "PIE" | "KPI";
}

/**
 * config 形狀表 —— 本檔的單一真相來源。
 *
 * 鍵名即 config 的鍵名；值是 ConfigValueType 的鍵。
 * `as const` 是必要的：NodeConfig 這個型別是**由它推導**出來的，
 * 所以「型別」與「執行期鍵清單」（NODE_CONFIG_KEYS）不可能漂移。
 *
 * 分組只是為了方便人工比對，與節點分類無關。
 */
export const NODE_CONFIG_SHAPE = {
	// --- 來源 -------------------------------------------------------------
	tableName: "string",
	fileName: "string",
	/** UI 寫入：註冊本機檔案後的列數（非使用者可編輯欄位） */
	rowCount: "number",
	/** UI 寫入：註冊本機檔案後的欄數（非使用者可編輯欄位） */
	columnCount: "number",

	// --- FILTER -----------------------------------------------------------
	field: "string",
	op: "string",
	val: "string",

	// --- SUMMARIZE --------------------------------------------------------
	groupBy: "string|string[]",
	/** 舊格式：單一聚合函數（aggregations 為空時的 fallback） */
	func: "string",
	/** 舊格式：單一聚合目標（aggregations 為空時的 fallback） */
	target: "string",
	aggregations: "aggList",

	// --- FORMULA ----------------------------------------------------------
	expression: "string",
	outputColumn: "string",

	// --- JOIN -------------------------------------------------------------
	joinType: "string",
	leftKey: "string",
	rightKey: "string",

	// --- FUZZY_JOIN -------------------------------------------------------
	/**
	 * 相似度/距離函數：JARO_WINKLER | LEVENSHTEIN | DAMERAU_LEVENSHTEIN | EXACT。
	 * 注意方向：前三個「越像值越大或越小」不一致，見 sql.ts 的 matchIsSimilarity()。
	 */
	matchFunc: "string",
	/** 門檻。相似度函數是下限（>=），距離函數是上限（<=）——方向由 matchFunc 決定 */
	threshold: "number",
	/** 把相似度/距離寫進這個欄位名；空字串 = 不輸出 */
	scoreColumn: "string",
	/** 候選對縮減：NONE | FIRST_CHAR（只比首字元相同的配對，省掉大部分 O(n*m)） */
	prefilter: "string",

	// --- SPATIAL_MATCH ----------------------------------------------------
	// 幾何來源有兩條路，每側二選一：WKT 欄位，或 lon/lat 兩欄。
	// 兩條都給時以 WKT 為準（WKT 可以是非點幾何，表達力更強）。
	/** 左表的 WKT 幾何欄位；留空則改用 leftLonField / leftLatField */
	leftGeometryField: "string",
	/** 左表經度欄位（X）—— 與 leftGeometryField 二選一 */
	leftLonField: "string",
	/** 左表緯度欄位（Y）—— 與 leftGeometryField 二選一 */
	leftLatField: "string",
	rightGeometryField: "string",
	rightLonField: "string",
	rightLatField: "string",
	/**
	 * 空間謂詞：INTERSECTS | CONTAINS | WITHIN | TOUCHES | OVERLAPS | CROSSES |
	 * EQUALS | DWITHIN。只有 DWITHIN 會用到 distance。
	 */
	spatialPredicate: "string",
	/** DWITHIN 的距離門檻，單位由 distanceUnit 決定 */
	distance: "number",
	/**
	 * 距離單位：DEGREES（平面度數，精確）| METERS。
	 * ⚠ METERS 走 DuckDB 的 ST_Distance_Sphere，而這個 build 的它是
	 * 「平面度數 × 111194.93」——**不補經度收斂**，所以離開赤道會高估東西向距離。
	 */
	distanceUnit: "string",
	/** 把算出來的距離寫進這個欄位名；空字串 = 不輸出 */
	distanceColumn: "string",

	// --- SELECT / UNION / SAMPLE -----------------------------------------
	/** SELECT 要投影的欄位；空陣列 = 全選 */
	columns: "string[]",
	/** UNION 的欄位對齊方式：BY_NAME（預設）/ POSITION */
	unionMode: "string",
	/** SAMPLE 的取樣列數 */
	sampleSize: "number",
	/** SAMPLE 的取樣方式：FIRST（預設）/ RANDOM */
	sampleMode: "string",

	// --- RENAME -----------------------------------------------------------
	renames: "pairList",

	// --- BI ---------------------------------------------------------------
	/** 唯一的封閉選項集，見 ConfigValueType.chart（VizChartNode 對它做 switch） */
	chartType: "chart",
	xAxis: "string",
	yAxis: "string",

	// --- UNIQUE / IMPUTE / RANK / DATA_CLEANSING --------------------------
	/** IMPUTE 補值方式（CONSTANT | MEAN）／ RANK 排名方式（RANK | DENSE_RANK | ROW_NUMBER） */
	method: "string",
	/** IMPUTE 的常數補值 */
	fillValue: "string",
	/** DATA_CLEANSING：去頭尾空白 */
	trim: "boolean",
	/** DATA_CLEANSING：壓縮內部連續空白 */
	collapse: "boolean",
	/** DATA_CLEANSING：空字串轉 NULL */
	emptyToNull: "boolean",

	// --- CROSS_TAB / TRANSPOSE -------------------------------------------
	/** CROSS_TAB 列轉欄的來源欄位；TRANSPOSE 的取值欄位 */
	pivotColumn: "string",
	/** CROSS_TAB 的取值欄位 */
	valueColumn: "string",
	/** CROSS_TAB 的聚合函數（SUM / AVG / COUNT / MIN / MAX / FIRST） */
	aggFunc: "string",
	/** TRANSPOSE：unpivot 後存放原欄位名的欄位 */
	nameColumn: "string",

	// --- TEXT_TO_COLUMNS --------------------------------------------------
	/** 分隔符（splitMode = SEPARATOR 時為字面值，REGEX 時為樣式） */
	separator: "string",
	/** 切出來的欄位名 */
	outputColumns: "string[]",
	/** SEPARATOR（字面分隔符）| REGEX（樣式切分） */
	splitMode: "string",

	// --- REGEX ------------------------------------------------------------
	/** MATCH | PARSE | REPLACE */
	regexMode: "string",
	/** 樣式（RE2 / Rust regex 共同語法；忽略大小寫以 inline (?i) 表示） */
	pattern: "string",
	/** REPLACE 的取代字串（支援 \1 反向參照） */
	replacement: "string",
	/** 是否忽略大小寫（摺進 pattern 的 (?i)，因為 Polars 的 str.* 沒有 case 參數） */
	caseInsensitive: "boolean",

	// --- MULTI_FIELD_FORMULA ---------------------------------------------
	// expression 欄位沿用 FORMULA 那一份（用 _CurrentField_ 代表當前欄位；
	// 它在目錄裡的 default 是載入性的，見 nodeCatalog.ts 的說明）。
	/** OVERWRITE（就地改寫）| NEW_FIELD（每個欄位多一個新欄位） */
	outputMode: "string",
	/** NEW_FIELD 模式的新欄位後綴（空字串會被退回 "_new"，因為兩引擎對空後綴不一致） */
	newFieldSuffix: "string",

	// --- 視窗節點（MULTI_ROW_FORMULA / RUNNING_TOTAL / RANK）--------------
	partitionBy: "string[]",
	orderBy: "string",
	descending: "boolean",

	// --- FIND_REPLACE -----------------------------------------------------
	findField: "string",
	lookupField: "string",
	replaceField: "string",
	unmatched: "string",
} as const;

/**
 * 節點 config。
 *
 * 由 NODE_CONFIG_SHAPE 推導，因此**不可能**出現「型別有這個鍵、鍵清單沒有」的漂移。
 * 全部欄位都是 optional：config 是外部輸入（存檔、AI 產生的 patch），
 * 每個節點只會用到自己那幾個欄位，其餘一律當作不存在。
 * 每個欄位都必須在讀取端經過 engine/sql.ts 的 safe* 白名單，
 * 型別只是第一道防線，不是唯一一道。
 */
export type NodeConfig = {
	-readonly [K in keyof typeof NODE_CONFIG_SHAPE]?: ConfigValueType[
		(typeof NODE_CONFIG_SHAPE)[K]
	];
};

/**
 * config 的執行期鍵清單（由形狀表產生，不會漏）。
 * 供 scripts/verify.mjs 斷言「目錄宣告的每個欄位都在這裡」使用。
 */
export const NODE_CONFIG_KEYS: readonly string[] = Object.keys(NODE_CONFIG_SHAPE);
