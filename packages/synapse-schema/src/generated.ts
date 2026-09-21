// ⚠️ AUTO-GENERATED — DO NOT EDIT BY HAND.
//
// 由 scripts/gen_node_catalog.mjs 從 apps/web/src/engine/nodeCatalog.ts 產生。
// 重新產生：node scripts/gen_node_catalog.mjs
// 檢查是否最新：node scripts/gen_node_catalog.mjs --check
//
// 這個檔案以前是手寫的，內容是 DATA_SOURCE / TRANSFORM / AGGREGATE /
// SQL_CUSTOM / CHART_BI —— 那些節點早就不存在了，而真正的清單在
// engine/nodeCatalog.ts。兩份清單漂移之後，這個套件描述的是一個
// 不存在的系統。現在它由目錄產生，不可能再漂移。

export const CATALOG_VERSION = 1;
export const GENERATED_FROM = "apps/web/src/engine/nodeCatalog.ts";

/** 目錄裡的節點型別（單一真相來源：engine/nodeCatalog.ts） */
export const NODE_TYPES = [
	"INPUT_DUCKDB",
	"DATA_CLEANSING",
	"FILTER",
	"FORMULA",
	"IMPUTE",
	"MULTI_FIELD_FORMULA",
	"MULTI_ROW_FORMULA",
	"RANK",
	"REGEX",
	"RENAME",
	"RUNNING_TOTAL",
	"SAMPLE",
	"SELECT",
	"SORT",
	"TEXT_TO_COLUMNS",
	"UNIQUE",
	"CROSS_TAB",
	"SUMMARIZE",
	"TRANSPOSE",
	"APPEND_FIELDS",
	"FIND_REPLACE",
	"FUZZY_JOIN",
	"JOIN",
	"UNION",
	"VIZ_CHART",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** config 欄位的資料形狀（由目錄推導） */
export type FieldKind = "aggList" | "boolean" | "enum" | "field" | "fieldList" | "number" | "pairList" | "text" | "textList";

export interface FieldSpec {
	readonly name: string;
	readonly kind: FieldKind;
	readonly label: string;
	readonly required: boolean;
	/** kind = "enum" 時的合法值 */
	readonly values?: readonly string[];
}

export interface NodeMeta {
	readonly label: string;
	readonly category: string;
	readonly description: string;
	/** 上游輸入埠數量：0 = 資料來源，1 = 單輸入，2 = 雙輸入，-1 = 不限 */
	readonly inputs: number;
}

/**
 * 每個節點型別接受的 config 欄位。
 *
 * 型別是 mapped type `{ [K in NodeType]: ... }` —— 刻意的：任何一個型別
 * 缺少欄位宣告都會讓 tsc 編譯失敗，所以「加了節點卻忘了欄位」不可能默默通過。
 */
export const NODE_FIELDS: { readonly [K in NodeType]: readonly FieldSpec[] } = {
	INPUT_DUCKDB: [
		{ name: "tableName", kind: "text", label: "資料表", required: false },
		{ name: "fileName", kind: "text", label: "檔案", required: false },
	],
	DATA_CLEANSING: [
		{ name: "columns", kind: "fieldList", label: "要清理的欄位", required: true },
		{ name: "trim", kind: "boolean", label: "去頭尾空白", required: false },
		{ name: "collapse", kind: "boolean", label: "壓縮內部空白", required: false },
		{ name: "emptyToNull", kind: "boolean", label: "空字串轉 NULL", required: false },
	],
	FILTER: [
		{ name: "field", kind: "field", label: "欄位", required: true },
		{ name: "op", kind: "enum", label: "運算子", required: false, values: ["=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IS", "IS NOT"] },
		{ name: "val", kind: "text", label: "值", required: false },
	],
	FORMULA: [
		{ name: "outputColumn", kind: "text", label: "新欄位名", required: true },
		{ name: "expression", kind: "text", label: "運算式", required: true },
	],
	IMPUTE: [
		{ name: "columns", kind: "fieldList", label: "要補的欄位", required: true },
		{ name: "method", kind: "enum", label: "補值方式", required: false, values: ["CONSTANT", "MEAN"] },
		{ name: "fillValue", kind: "text", label: "常數值", required: false },
	],
	MULTI_FIELD_FORMULA: [
		{ name: "columns", kind: "fieldList", label: "要套用的欄位", required: true },
		{ name: "expression", kind: "text", label: "運算式", required: true },
		{ name: "outputMode", kind: "enum", label: "輸出模式", required: false, values: ["OVERWRITE", "NEW_FIELD"] },
		{ name: "newFieldSuffix", kind: "text", label: "新欄位後綴（NEW_FIELD）", required: false },
	],
	MULTI_ROW_FORMULA: [
		{ name: "outputColumn", kind: "text", label: "新欄位名", required: true },
		{ name: "expression", kind: "text", label: "運算式", required: true },
		{ name: "partitionBy", kind: "fieldList", label: "分區鍵", required: false },
		{ name: "orderBy", kind: "field", label: "排序鍵", required: false },
		{ name: "descending", kind: "boolean", label: "排序遞減", required: false },
	],
	RANK: [
		{ name: "target", kind: "field", label: "排名依據欄位", required: true },
		{ name: "outputColumn", kind: "text", label: "輸出欄位名", required: false },
		{ name: "method", kind: "enum", label: "排名方式", required: false, values: ["RANK", "DENSE_RANK", "ROW_NUMBER"] },
		{ name: "partitionBy", kind: "fieldList", label: "分區鍵", required: false },
		{ name: "descending", kind: "boolean", label: "大者在先", required: false },
	],
	REGEX: [
		{ name: "field", kind: "field", label: "來源欄位", required: true },
		{ name: "regexMode", kind: "enum", label: "模式", required: false, values: ["MATCH", "PARSE", "REPLACE"] },
		{ name: "pattern", kind: "text", label: "樣式", required: true },
		{ name: "caseInsensitive", kind: "boolean", label: "忽略大小寫", required: false },
		{ name: "outputColumn", kind: "text", label: "輸出欄位（MATCH / REPLACE）", required: false },
		{ name: "replacement", kind: "text", label: "取代字串（REPLACE）", required: false },
		{ name: "outputColumns", kind: "textList", label: "擷取欄位（PARSE）", required: false },
	],
	RENAME: [
		{ name: "renames", kind: "pairList", label: "改名清單", required: false },
	],
	RUNNING_TOTAL: [
		{ name: "target", kind: "field", label: "累計欄位", required: true },
		{ name: "outputColumn", kind: "text", label: "輸出欄位名", required: false },
		{ name: "partitionBy", kind: "fieldList", label: "分區鍵", required: false },
		{ name: "orderBy", kind: "field", label: "排序鍵", required: false },
	],
	SAMPLE: [
		{ name: "sampleSize", kind: "number", label: "列數", required: false },
		{ name: "sampleMode", kind: "enum", label: "取樣方式", required: false, values: ["FIRST", "RANDOM"] },
	],
	SELECT: [
		{ name: "columns", kind: "fieldList", label: "保留欄位", required: false },
	],
	SORT: [
		{ name: "field", kind: "field", label: "排序欄位", required: true },
		{ name: "descending", kind: "boolean", label: "遞減", required: false },
	],
	TEXT_TO_COLUMNS: [
		{ name: "field", kind: "field", label: "來源欄位", required: true },
		{ name: "splitMode", kind: "enum", label: "切分方式", required: false, values: ["SEPARATOR", "REGEX"] },
		{ name: "separator", kind: "text", label: "分隔符 / 樣式", required: false },
		{ name: "caseInsensitive", kind: "boolean", label: "忽略大小寫（REGEX）", required: false },
		{ name: "outputColumns", kind: "textList", label: "輸出欄位名", required: true },
	],
	UNIQUE: [
		{ name: "columns", kind: "fieldList", label: "去重鍵", required: false },
	],
	CROSS_TAB: [
		{ name: "pivotColumn", kind: "field", label: "展開欄位", required: true },
		{ name: "valueColumn", kind: "field", label: "取值欄位", required: true },
		{ name: "aggFunc", kind: "enum", label: "聚合函數", required: false, values: ["SUM", "AVG", "COUNT", "MIN", "MAX", "FIRST"] },
		{ name: "groupBy", kind: "fieldList", label: "保留為列的分組鍵", required: false },
	],
	SUMMARIZE: [
		{ name: "groupBy", kind: "fieldList", label: "分組鍵", required: false },
		{ name: "aggregations", kind: "aggList", label: "聚合", required: false },
	],
	TRANSPOSE: [
		{ name: "columns", kind: "fieldList", label: "要轉的欄位", required: true },
		{ name: "nameColumn", kind: "text", label: "名稱欄位名", required: false },
		{ name: "valueColumn", kind: "text", label: "值欄位名", required: false },
	],
	APPEND_FIELDS: [
	],
	FIND_REPLACE: [
		{ name: "findField", kind: "field", label: "來源鍵欄位", required: true },
		{ name: "lookupField", kind: "field", label: "查找表鍵欄位", required: true },
		{ name: "replaceField", kind: "field", label: "取回的值欄位", required: true },
		{ name: "outputColumn", kind: "text", label: "輸出欄位名", required: false },
		{ name: "unmatched", kind: "enum", label: "未命中時", required: false, values: ["KEEP", "NULL"] },
	],
	FUZZY_JOIN: [
		{ name: "leftKey", kind: "field", label: "左鍵", required: true },
		{ name: "rightKey", kind: "field", label: "右鍵", required: true },
		{ name: "matchFunc", kind: "enum", label: "比對方式", required: false, values: ["JARO_WINKLER", "LEVENSHTEIN", "DAMERAU_LEVENSHTEIN", "EXACT"] },
		{ name: "threshold", kind: "number", label: "門檻", required: false },
		{ name: "joinType", kind: "enum", label: "未命中時", required: false, values: ["INNER", "LEFT"] },
		{ name: "prefilter", kind: "enum", label: "候選縮減", required: false, values: ["NONE", "FIRST_CHAR"] },
		{ name: "scoreColumn", kind: "text", label: "分數欄位", required: false },
		{ name: "caseInsensitive", kind: "boolean", label: "忽略大小寫", required: false },
	],
	JOIN: [
		{ name: "joinType", kind: "enum", label: "連接類型", required: false, values: ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"] },
		{ name: "leftKey", kind: "field", label: "左鍵", required: false },
		{ name: "rightKey", kind: "field", label: "右鍵", required: false },
	],
	UNION: [
		{ name: "unionMode", kind: "enum", label: "對齊方式", required: false, values: ["BY_NAME", "POSITION"] },
	],
	VIZ_CHART: [
		{ name: "chartType", kind: "enum", label: "圖表類型", required: false, values: ["BAR", "LINE", "PIE", "KPI"] },
		{ name: "xAxis", kind: "field", label: "X 軸", required: false },
		{ name: "yAxis", kind: "field", label: "Y 軸", required: false },
	],
};

/** 每個節點型別的顯示資訊（同樣由 mapped type 強制完整） */
export const NODE_META: { readonly [K in NodeType]: NodeMeta } = {
	INPUT_DUCKDB: { label: "Input Data", category: "In/Out", description: "從 DuckDB 資料表或上傳的 CSV / Parquet 檔載入資料。", inputs: 0 },
	DATA_CLEANSING: { label: "Data Cleansing", category: "Preparation", description: "清理文字欄位：去頭尾空白、壓縮內部連續空白、空字串轉 NULL。", inputs: 1 },
	FILTER: { label: "Filter", category: "Preparation", description: "依條件保留列，並產生 true / false 兩個輸出分支。", inputs: 1 },
	FORMULA: { label: "Formula", category: "Preparation", description: "用運算式新增一個欄位（DuckDB scalar expression）。", inputs: 1 },
	IMPUTE: { label: "Impute", category: "Preparation", description: "補上欄位中的空值（常數或該欄平均）。", inputs: 1 },
	MULTI_FIELD_FORMULA: { label: "Multi-Field Formula", category: "Preparation", description: "同一個運算式一次套用到多個欄位（用 _CurrentField_ 代表當前欄位）。", inputs: 1 },
	MULTI_ROW_FORMULA: { label: "Multi-Row Formula", category: "Preparation", description: "可跨列的運算式（視窗函數），例如取上一列的值。", inputs: 1 },
	RANK: { label: "Rank", category: "Preparation", description: "排名（RANK / DENSE_RANK / ROW_NUMBER）。", inputs: 1 },
	REGEX: { label: "RegEx", category: "Preparation", description: "用正規表示式比對、擷取或取代字串（MATCH / PARSE / REPLACE 三種模式）。", inputs: 1 },
	RENAME: { label: "Rename", category: "Preparation", description: "把欄位改名，保留原本位置。", inputs: 1 },
	RUNNING_TOTAL: { label: "Running Total", category: "Preparation", description: "累計加總（可依分區與排序）。", inputs: 1 },
	SAMPLE: { label: "Sample", category: "Preparation", description: "取前 N 列，或隨機取樣 N 列（固定 seed，可重現）。", inputs: 1 },
	SELECT: { label: "Select", category: "Preparation", description: "挑選要保留的欄位（空的 columns = 全選）。", inputs: 1 },
	SORT: { label: "Sort", category: "Preparation", description: "依指定欄位排序。", inputs: 1 },
	TEXT_TO_COLUMNS: { label: "Text to Columns", category: "Preparation", description: "用分隔符或正規表示式把一個字串欄位拆成多個欄位。", inputs: 1 },
	UNIQUE: { label: "Unique", category: "Preparation", description: "依指定欄位去重，每個鍵只保留第一列。", inputs: 1 },
	CROSS_TAB: { label: "Cross Tab", category: "Transform", description: "列轉欄（pivot）：把某欄的值展開成新欄位。", inputs: 1 },
	SUMMARIZE: { label: "Summarize", category: "Transform", description: "依分組鍵聚合，支援多個分組鍵與多個聚合。", inputs: 1 },
	TRANSPOSE: { label: "Transpose", category: "Transform", description: "欄轉列（unpivot）：把多個欄位收斂成「名稱 + 值」兩欄。", inputs: 1 },
	APPEND_FIELDS: { label: "Append Fields", category: "Join", description: "把第二個輸入的欄位接到每一列後面（笛卡爾積，不需鍵）。", inputs: 2 },
	FIND_REPLACE: { label: "Find Replace", category: "Join", description: "用查找表把某欄的值替換掉，只帶回一個值欄位（不像 Join 帶回全部欄位）。", inputs: 2 },
	FUZZY_JOIN: { label: "Fuzzy Join", category: "Join", description: "用字串相似度（而非完全相等）合併兩個輸入，可選擇輸出相似度分數。", inputs: 2 },
	JOIN: { label: "Join", category: "Join", description: "依鍵合併兩個輸入，保留兩邊全部欄位。", inputs: 2 },
	UNION: { label: "Union", category: "Join", description: "把 N 個輸入上下疊起來（預設依欄位名對齊）。", inputs: -1 },
	VIZ_CHART: { label: "Chart", category: "BI", description: "把上游結果畫成圖表（不產生輸出表）。", inputs: 1 },
};
