export type ExecutionViewMode = "SILENT" | "CANVAS_FOCUS";

/**
 * 畫布節點類型 —— 必須與 engine/astCompiler.ts 的 switch 分支保持一致。
 * （舊版這個 union 還寫著 TRANSFORM_FORMULA / AGGREGATE / AI_CUSTOM 等
 *  已經不存在的類型，與實際編譯器對不上。）
 *
 * ⚠ 這裡只是「型別」層。節點的能力描述（標籤、分類、config 欄位、輸入埠數、
 *   給 agent 看的說明）全部集中在 engine/nodeCatalog.ts —— 那份才是單一真相
 *   來源，並且有斷言強制它與本 union、與編譯器、與 Palette 三者一致。
 *   新增節點時：本 union 加一行 → nodeCatalog 加一筆 → 編譯器加一個 case。
 */
export type AlteryxNodeType =
	| "INPUT_DUCKDB"
	| "FILTER"
	| "FORMULA"
	| "SUMMARIZE"
	| "JOIN"
	| "SORT"
	| "SELECT"
	| "UNION"
	| "SAMPLE"
	| "RENAME"
	| "UNIQUE"
	| "IMPUTE"
	| "DATA_CLEANSING"
	| "CROSS_TAB"
	| "TRANSPOSE"
	| "TEXT_TO_COLUMNS"
	| "REGEX"
	| "MULTI_FIELD_FORMULA"
	| "MULTI_ROW_FORMULA"
	| "RUNNING_TOTAL"
	| "RANK"
	| "APPEND_FIELDS"
	| "FIND_REPLACE"
	| "VIZ_CHART";

export interface ASTNodeConfig {
	tableName?: string;
	fileName?: string;
	field?: string;
	op?: string;
	val?: string;
	/** SUMMARIZE 分組鍵：舊格式 string，新格式 string[]（空陣列 = 不分组） */
	groupBy?: string | string[];
	/** 舊格式：單一聚合（aggregations 為空時的 fallback） */
	func?: string;
	target?: string;
	/** SUMMARIZE 聚合清單（多組） */
	aggregations?: { func?: string; target?: string }[];
	outputColumn?: string;
	expression?: string;
	joinType?: string;
	leftKey?: string;
	rightKey?: string;
	columns?: string[];
	/** UNION 欄位對齊方式：BY_NAME（預設）/ POSITION */
	unionMode?: "BY_NAME" | "POSITION";
	/** SAMPLE 取樣列數 */
	sampleSize?: number;
	/** SAMPLE 取樣方式：FIRST（預設）/ RANDOM */
	sampleMode?: "FIRST" | "RANDOM";
	/** RENAME 改名清單 */
	renames?: { from?: string; to?: string }[];
	chartType?: "BAR" | "LINE" | "PIE" | "KPI";
	xAxis?: string;
	yAxis?: string;

	// --- 以下為擴充節點（UNIQUE / IMPUTE / CROSS_TAB / 視窗函數 …）---
	/** IMPUTE 補值方式（CONSTANT | MEAN）／ RANK 排名方式（RANK | DENSE_RANK | ROW_NUMBER） */
	method?: string;
	/** IMPUTE 的常數補值 */
	fillValue?: string;
	/** DATA_CLEANSING：去頭尾空白 / 壓縮內部連續空白 / 空字串轉 NULL */
	trim?: boolean;
	collapse?: boolean;
	emptyToNull?: boolean;
	/** CROSS_TAB：列轉欄的來源欄位、取值欄位 */
	pivotColumn?: string;
	valueColumn?: string;
	/** CROSS_TAB 的聚合函數（SUM / AVG / COUNT / MIN / MAX / FIRST） */
	aggFunc?: string;
	/** TRANSPOSE：unpivot 後存放原欄位名的欄位 */
	nameColumn?: string;
	/** TEXT_TO_COLUMNS：分隔符與切出來的欄位名 */
	separator?: string;
	outputColumns?: string[];
	/** REGEX：MATCH | PARSE | REPLACE */
	regexMode?: string;
	/** REGEX 樣式（RE2 / Rust regex 共同語法；忽略大小寫以 inline (?i) 表示） */
	pattern?: string;
	/** REGEX：REPLACE 的取代字串（支援 \1 反向參照） */
	replacement?: string;
	/** REGEX：是否忽略大小寫（摺進 pattern 的 (?i)） */
	caseInsensitive?: boolean;
	/** MULTI_FIELD_FORMULA：OVERWRITE（就地改寫）| NEW_FIELD（每個欄位多一個新欄位） */
	outputMode?: string;
	/** MULTI_FIELD_FORMULA：NEW_FIELD 模式的新欄位後綴（空字串會被退回 "_new"） */
	newFieldSuffix?: string;
	/** 視窗節點：分區鍵、排序鍵、是否遞減 */
	partitionBy?: string[];
	orderBy?: string;
	descending?: boolean;
	/** FIND_REPLACE：來源鍵、查找表鍵、取回的值欄位、未命中時的處理 */
	findField?: string;
	lookupField?: string;
	replaceField?: string;
	unmatched?: string;
}


export interface SynapseASTNode {
	id: string;
	type: AlteryxNodeType;
	label: string;
	config: ASTNodeConfig;
	position: { x: number; y: number };
	upstreamNodeIds: string[];
}

export interface SynapseASTGraph {
	workflowId: string;
	title: string;
	version: number;
	nodes: SynapseASTNode[];
	executionMode: ExecutionViewMode;
}
