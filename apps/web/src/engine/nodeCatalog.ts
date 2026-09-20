// apps/web/src/engine/nodeCatalog.ts
// 節點能力目錄 —— 整個平台的「單一真相來源」(single source of truth)。
//
// 為什麼要有這個檔案：
//   在加入它之前，「有哪些節點、每個節點吃什麼 config」被抄了三份：
//     1. types/workbench.ts 的 AlteryxNodeType union
//     2. components/workbench/Palette.tsx 的面板項目
//     3. apps/server/hermes.py 的 VALID_NODE_TYPES + MUTATE_SYSTEM_PROMPT
//   而實際會動的只有第 4 份 —— astCompiler.ts 的 switch。
//   結果是 hermes.py 那份靜靜地爛掉：少了 SELECT / UNION / SAMPLE / RENAME，
//   SUMMARIZE 還停在「單一 groupBy + 單一聚合」的舊描述，SORT 的鍵名也寫錯
//   （寫 groupBy，但編譯器讀的是 field）。AI 因此無法產生這些節點。
//
//   現在：能力描述只寫在這裡，其他三處**衍生**自它 ——
//     - Palette 直接由 NODE_CATALOG 生成
//     - hermes.py 讀 scripts/gen_node_catalog.mjs 產出的 node_catalog.json
//     - scripts/verify.mjs 斷言 NODE_CATALOG 的鍵集合 == 編譯器 switch 的
//       case 集合，漂移會直接讓驗證紅燈
//
// 本檔案不可 import React（verify.mjs 與產生器都會在 Node 直接 import 它）。
import type { AlteryxNodeType } from "../types/workbench";

/** config 欄位的資料形狀 —— 決定 UI 用哪種輸入控件、以及給 agent 的 JSON 型別寫法 */
export type ConfigFieldKind =
	| "text"
	| "number"
	| "boolean"
	| "field"
	| "fieldList"
	| "textList"
	| "enum"
	| "aggList"
	| "pairList";

export interface ConfigFieldSpec {
	name: string;
	kind: ConfigFieldKind;
	label: string;
	required?: boolean;
	/** kind = enum 時的合法值 */
	values?: readonly string[];
	default?: unknown;
	/** 給 agent 的一句話說明（會進 prompt） */
	hint?: string;
}

/** 節點分類（同時是 Palette 的分組標題與排序） */
export type NodeCategory = "In/Out" | "Preparation" | "Transform" | "Join" | "BI";

export const CATEGORY_ORDER: readonly NodeCategory[] = [
	"In/Out",
	"Preparation",
	"Transform",
	"Join",
	"BI",
];

export interface NodeSpec {
	type: AlteryxNodeType;
	label: string;
	category: NodeCategory;
	/** 一句話說明「這個節點做什麼」（給 agent 與工具提示） */
	description: string;
	/** 什麼時候該用它 —— 這句直接影響 agent 的選型正確率 */
	whenToUse: string;
	/**
	 * 上游輸入埠數量。
	 *   0  = 資料來源
	 *   1  = 單一輸入
	 *   2  = 雙輸入（left / right）
	 *   -1 = 不限（N 路合併）
	 */
	inputs: number;
	/** React Flow 的 nodeTypes key */
	nodeType: "alteryxNode" | "vizChartNode";
	/** lucide-react 的 icon 名稱（由 Palette 對照成元件） */
	icon: string;
	/** Palette 圖示的顏色 class */
	color: string;
	/** 拖進畫布時的初始 config */
	defaults: Record<string, unknown>;
	fields: ConfigFieldSpec[];
}

/**
 * 節點目錄本體。
 *
 * 型別是 `Record<AlteryxNodeType, NodeSpec>` —— 這是刻意的：Record 對 union
 * 要求「每個鍵都必須存在」，所以只要 union 加了新節點卻忘了在這裡補描述，
 * tsc 就會直接編譯失敗，不可能默默漂移。
 */
export const NODE_CATALOG: Record<AlteryxNodeType, NodeSpec> = {
	// ---------------------------------------------------------------- In/Out
	INPUT_DUCKDB: {
		type: "INPUT_DUCKDB",
		label: "Input Data",
		category: "In/Out",
		description: "從 DuckDB 資料表或上傳的 CSV / Parquet 檔載入資料。",
		whenToUse: "每個 pipeline 的起點。使用者在畫布上已有資料時，改連現有節點即可，不要另開一個 Input。",
		inputs: 0,
		nodeType: "alteryxNode",
		icon: "Database",
		color: "text-emerald-500",
		defaults: { tableName: "" },
		fields: [
			{ name: "tableName", kind: "text", label: "資料表", hint: "留空則由平台依節點 id 指定" },
			{ name: "fileName", kind: "text", label: "檔案", hint: "已上傳的檔名（CSV / Parquet）" },
		],
	},

	// ----------------------------------------------------------- Preparation
	FILTER: {
		type: "FILTER",
		label: "Filter",
		category: "Preparation",
		description: "依條件保留列，並產生 true / false 兩個輸出分支。",
		whenToUse: "使用者說「只要 / 過濾 / 大於 / 小於 / only / where」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Filter",
		color: "text-blue-500",
		defaults: { field: "amount", op: ">", val: "1000" },
		fields: [
			{ name: "field", kind: "field", label: "欄位", required: true },
			{
				name: "op",
				kind: "enum",
				label: "運算子",
				values: ["=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IS", "IS NOT"],
				default: ">",
			},
			{ name: "val", kind: "text", label: "值", hint: "字面值；數字與布林不加引號" },
		],
	},

	FORMULA: {
		type: "FORMULA",
		label: "Formula",
		category: "Preparation",
		description: "用運算式新增一個欄位（DuckDB scalar expression）。",
		whenToUse: "需要計算新欄位（金額加成、字串拼接、條件旗標）時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Calculator",
		color: "text-teal-500",
		defaults: { outputColumn: "amount_taxed", expression: "amount * 1.1" },
		fields: [
			{ name: "outputColumn", kind: "text", label: "新欄位名", required: true },
			{
				name: "expression",
				kind: "text",
				label: "運算式",
				required: true,
				hint: "DuckDB 純量運算式，例如 amount * 1.1 或 UPPER(name)",
			},
		],
	},

	SELECT: {
		type: "SELECT",
		label: "Select",
		category: "Preparation",
		description: "挑選要保留的欄位（空的 columns = 全選）。",
		whenToUse: "使用者說「只要某幾欄 / 去掉某欄 / 選欄位」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Table",
		color: "text-sky-500",
		defaults: { columns: [] },
		fields: [
			{ name: "columns", kind: "fieldList", label: "保留欄位", hint: "空陣列 = 全選（passthrough）" },
		],
	},

	SORT: {
		type: "SORT",
		label: "Sort",
		category: "Preparation",
		description: "依指定欄位排序。",
		whenToUse: "使用者說「排序 / 由大到小 / 由小到大 / sort by」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "ArrowDownUp",
		color: "text-indigo-500",
		defaults: { field: "id", descending: false },
		fields: [
			{ name: "field", kind: "field", label: "排序欄位", required: true },
			{ name: "descending", kind: "boolean", label: "遞減", default: false },
		],
	},

	RENAME: {
		type: "RENAME",
		label: "Rename",
		category: "Preparation",
		description: "把欄位改名，保留原本位置。",
		whenToUse: "使用者說「改名 / 重新命名 / rename」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "CaseSensitive",
		color: "text-lime-600",
		defaults: { renames: [] },
		fields: [
			{
				name: "renames",
				kind: "pairList",
				label: "改名清單",
				hint: "每組 {from, to}",
			},
		],
	},

	SAMPLE: {
		type: "SAMPLE",
		label: "Sample",
		category: "Preparation",
		description: "取前 N 列，或隨機取樣 N 列（固定 seed，可重現）。",
		whenToUse: "使用者說「取前幾筆 / 抽樣 / 樣本 / top N 筆」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Rows3",
		color: "text-orange-500",
		defaults: { sampleMode: "FIRST", sampleSize: 100 },
		fields: [
			{ name: "sampleSize", kind: "number", label: "列數", default: 100 },
			{
				name: "sampleMode",
				kind: "enum",
				label: "取樣方式",
				values: ["FIRST", "RANDOM"],
				default: "FIRST",
				hint: "FIRST = 取前 N 列；RANDOM = 隨機取樣（seed 固定為 42）",
			},
		],
	},

	UNIQUE: {
		type: "UNIQUE",
		label: "Unique",
		category: "Preparation",
		description: "依指定欄位去重，每個鍵只保留第一列。",
		whenToUse: "使用者說「去重 / 去除重複 / unique / distinct / 只留一筆」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "CopyCheck",
		color: "text-cyan-600",
		defaults: { columns: [] },
		fields: [
			{
				name: "columns",
				kind: "fieldList",
				label: "去重鍵",
				hint: "空陣列 = 整列完全相同才算重複",
			},
		],
	},

	IMPUTE: {
		type: "IMPUTE",
		label: "Impute",
		category: "Preparation",
		description: "補上欄位中的空值（常數或該欄平均）。",
		whenToUse: "使用者說「補空值 / 填補缺漏 / fill null / 缺失值」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Droplets",
		color: "text-rose-500",
		defaults: { columns: [], method: "CONSTANT", fillValue: "0" },
		fields: [
			{ name: "columns", kind: "fieldList", label: "要補的欄位", required: true },
			{
				name: "method",
				kind: "enum",
				label: "補值方式",
				values: ["CONSTANT", "MEAN"],
				default: "CONSTANT",
				hint: "CONSTANT = 用 fillValue 填；MEAN = 用該欄平均填",
			},
			{ name: "fillValue", kind: "text", label: "常數值", hint: "method = CONSTANT 時使用" },
		],
	},

	DATA_CLEANSING: {
		type: "DATA_CLEANSING",
		label: "Data Cleansing",
		category: "Preparation",
		description: "清理文字欄位：去頭尾空白、壓縮內部連續空白、空字串轉 NULL。",
		whenToUse: "使用者說「清理 / 去空白 / 格式不統一 / trim / 空字串」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Sparkles",
		color: "text-amber-600",
		defaults: { columns: [], trim: true, collapse: false, emptyToNull: true },
		fields: [
			{ name: "columns", kind: "fieldList", label: "要清理的欄位", required: true },
			{ name: "trim", kind: "boolean", label: "去頭尾空白", default: true },
			{
				name: "collapse",
				kind: "boolean",
				label: "壓縮內部空白",
				default: false,
				hint: "把連續空白壓成一個（含 trim）",
			},
			{ name: "emptyToNull", kind: "boolean", label: "空字串轉 NULL", default: true },
		],
	},

	TEXT_TO_COLUMNS: {
		type: "TEXT_TO_COLUMNS",
		label: "Text to Columns",
		category: "Preparation",
		description: "用分隔符把一個字串欄位拆成多個欄位。",
		whenToUse: "使用者說「拆欄 / 分隔 / 分割字串 / split」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Scissors",
		color: "text-purple-600",
		defaults: { field: "", separator: ",", outputColumns: [] },
		fields: [
			{ name: "field", kind: "field", label: "來源欄位", required: true },
			{ name: "separator", kind: "text", label: "分隔符", default: "," },
			{
				name: "outputColumns",
				kind: "textList",
				label: "輸出欄位名",
				required: true,
				hint: "依序對應第 1、2、3… 段；不足的段會是 NULL",
			},
		],
	},

	REGEX: {
		type: "REGEX",
		label: "RegEx",
		category: "Preparation",
		description: "用正規表示式比對、擷取或取代字串（MATCH / PARSE / REPLACE 三種模式）。",
		whenToUse:
			"使用者說「正規表示式 / regex / pattern / 樣式比對 / 擷取 / 抽出 / 取代」時。單純按分隔符拆欄請用 Text to Columns。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Regex",
		color: "text-violet-600",
		defaults: {
			field: "",
			regexMode: "MATCH",
			pattern: "",
			caseInsensitive: false,
			outputColumn: "regex_match",
			replacement: "",
			outputColumns: [],
		},
		fields: [
			{ name: "field", kind: "field", label: "來源欄位", required: true },
			{
				name: "regexMode",
				kind: "enum",
				label: "模式",
				values: ["MATCH", "PARSE", "REPLACE"],
				default: "MATCH",
				hint: "MATCH → 布林欄位；PARSE → 每個 capture group 一欄；REPLACE → 取代所有命中",
			},
			{
				name: "pattern",
				kind: "text",
				label: "樣式",
				required: true,
				hint: "RE2 / Rust regex 的共同語法（不支援 lookaround）；擷取用 (...) 分組",
			},
			{
				name: "caseInsensitive",
				kind: "boolean",
				label: "忽略大小寫",
				default: false,
				hint: "以 inline (?i) 摺進樣式 —— 兩個引擎的 regex 都支援",
			},
			{
				name: "outputColumn",
				kind: "text",
				label: "輸出欄位（MATCH / REPLACE）",
				default: "regex_match",
			},
			{
				name: "replacement",
				kind: "text",
				label: "取代字串（REPLACE）",
				hint: "支援 \\1 \\2 反向參照",
			},
			{
				name: "outputColumns",
				kind: "textList",
				label: "擷取欄位（PARSE）",
				hint: "依序對應第 1、2、3… 個 capture group；未命中時 DuckDB 回空字串、Polars 回 NULL",
			},
		],
	},

	MULTI_ROW_FORMULA: {
		type: "MULTI_ROW_FORMULA",
		label: "Multi-Row Formula",
		category: "Preparation",
		description: "可跨列的運算式（視窗函數），例如取上一列的值。",
		whenToUse: "使用者說「上一列 / 前一筆 / 與前值比較 / LAG」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "MoveVertical",
		color: "text-fuchsia-600",
		defaults: {
			outputColumn: "prev_amount",
			expression: "LAG(amount, 1)",
			partitionBy: [],
			orderBy: "id",
			descending: false,
		},
		fields: [
			{ name: "outputColumn", kind: "text", label: "新欄位名", required: true },
			{
				name: "expression",
				kind: "text",
				label: "運算式",
				required: true,
				hint: "可用視窗函數，例如 LAG(amount, 1) 或 LAG(amount, 1) - amount",
			},
			{ name: "partitionBy", kind: "fieldList", label: "分區鍵", hint: "各分區獨立計算" },
			{ name: "orderBy", kind: "field", label: "排序鍵" },
			{ name: "descending", kind: "boolean", label: "排序遞減", default: false },
		],
	},

	RUNNING_TOTAL: {
		type: "RUNNING_TOTAL",
		label: "Running Total",
		category: "Preparation",
		description: "累計加總（可依分區與排序）。",
		whenToUse: "使用者說「累計 / 累加 / running total / 到目前為止總和」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "TrendingUp",
		color: "text-emerald-600",
		defaults: { target: "amount", outputColumn: "amount_running", partitionBy: [], orderBy: "id" },
		fields: [
			{ name: "target", kind: "field", label: "累計欄位", required: true },
			{ name: "outputColumn", kind: "text", label: "輸出欄位名" },
			{ name: "partitionBy", kind: "fieldList", label: "分區鍵" },
			{ name: "orderBy", kind: "field", label: "排序鍵" },
		],
	},

	RANK: {
		type: "RANK",
		label: "Rank",
		category: "Preparation",
		description: "排名（RANK / DENSE_RANK / ROW_NUMBER）。",
		whenToUse: "使用者說「排名 / 第幾名 / rank / top 排行」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "ListOrdered",
		color: "text-yellow-600",
		defaults: {
			target: "amount",
			outputColumn: "amount_rank",
			method: "RANK",
			partitionBy: [],
			descending: true,
		},
		fields: [
			{ name: "target", kind: "field", label: "排名依據欄位", required: true },
			{ name: "outputColumn", kind: "text", label: "輸出欄位名" },
			{
				name: "method",
				kind: "enum",
				label: "排名方式",
				values: ["RANK", "DENSE_RANK", "ROW_NUMBER"],
				default: "RANK",
				hint: "RANK 有跳號、DENSE_RANK 不跳號、ROW_NUMBER 不並列",
			},
			{ name: "partitionBy", kind: "fieldList", label: "分區鍵" },
			{ name: "descending", kind: "boolean", label: "大者在先", default: true },
		],
	},

	// ------------------------------------------------------------- Transform
	SUMMARIZE: {
		type: "SUMMARIZE",
		label: "Summarize",
		category: "Transform",
		description: "依分組鍵聚合，支援多個分組鍵與多個聚合。",
		whenToUse: "使用者說「by X / group by X / per X / 加總 / 平均 / 合計 / 各…的總和」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "Sigma",
		color: "text-amber-500",
		defaults: { groupBy: ["year"], aggregations: [{ func: "SUM", target: "amount" }] },
		fields: [
			{
				name: "groupBy",
				kind: "fieldList",
				label: "分組鍵",
				hint: "多個鍵會形成複合分組；空陣列 = 不分组（整表聚合成一列）",
			},
			{
				name: "aggregations",
				kind: "aggList",
				label: "聚合",
				hint: "每組 {func, target}；target 用 * 代表 COUNT(*)",
			},
		],
	},

	CROSS_TAB: {
		type: "CROSS_TAB",
		label: "Cross Tab",
		category: "Transform",
		description: "列轉欄（pivot）：把某欄的值展開成新欄位。",
		whenToUse: "使用者說「樞紐 / 列轉欄 / 展開 / pivot / 每個 X 一欄」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "TableProperties",
		color: "text-blue-700",
		defaults: { pivotColumn: "category", valueColumn: "amount", aggFunc: "SUM", groupBy: ["country"] },
		fields: [
			{ name: "pivotColumn", kind: "field", label: "展開欄位", required: true },
			{ name: "valueColumn", kind: "field", label: "取值欄位", required: true },
			{
				name: "aggFunc",
				kind: "enum",
				label: "聚合函數",
				values: ["SUM", "AVG", "COUNT", "MIN", "MAX", "FIRST"],
				default: "SUM",
			},
			{ name: "groupBy", kind: "fieldList", label: "保留為列的分組鍵" },
		],
	},

	TRANSPOSE: {
		type: "TRANSPOSE",
		label: "Transpose",
		category: "Transform",
		description: "欄轉列（unpivot）：把多個欄位收斂成「名稱 + 值」兩欄。",
		whenToUse: "使用者說「轉置 / 欄轉列 / 寬轉長 / unpivot / 多欄合併成一欄」時。",
		inputs: 1,
		nodeType: "alteryxNode",
		icon: "FlipVertical2",
		color: "text-indigo-700",
		defaults: { columns: [], nameColumn: "metric", valueColumn: "value" },
		fields: [
			{ name: "columns", kind: "fieldList", label: "要轉的欄位", required: true },
			{ name: "nameColumn", kind: "text", label: "名稱欄位名", default: "metric" },
			{ name: "valueColumn", kind: "text", label: "值欄位名", default: "value" },
		],
	},

	// ------------------------------------------------------------------ Join
	JOIN: {
		type: "JOIN",
		label: "Join",
		category: "Join",
		description: "依鍵合併兩個輸入，保留兩邊全部欄位。",
		whenToUse: "使用者說「合併 / 連接 / 對照 / join / 關聯兩張表」時。",
		inputs: 2,
		nodeType: "alteryxNode",
		icon: "GitMerge",
		color: "text-purple-500",
		defaults: { joinType: "INNER", leftKey: "id", rightKey: "id" },
		fields: [
			{
				name: "joinType",
				kind: "enum",
				label: "連接類型",
				values: ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"],
				default: "INNER",
			},
			{ name: "leftKey", kind: "field", label: "左鍵" },
			{ name: "rightKey", kind: "field", label: "右鍵" },
		],
	},

	UNION: {
		type: "UNION",
		label: "Union",
		category: "Join",
		description: "把 N 個輸入上下疊起來（預設依欄位名對齊）。",
		whenToUse: "使用者說「合併多張表 / 疊起來 / union / 串接 / 同一種資料合在一起」時。",
		inputs: -1,
		nodeType: "alteryxNode",
		icon: "Combine",
		color: "text-fuchsia-500",
		defaults: { unionMode: "BY_NAME" },
		fields: [
			{
				name: "unionMode",
				kind: "enum",
				label: "對齊方式",
				values: ["BY_NAME", "POSITION"],
				default: "BY_NAME",
				hint: "BY_NAME 依欄位名對齊（缺欄補 NULL，Alteryx 語意）；POSITION 依欄位順序",
			},
		],
	},

	APPEND_FIELDS: {
		type: "APPEND_FIELDS",
		label: "Append Fields",
		category: "Join",
		description: "把第二個輸入的欄位接到每一列後面（笛卡爾積，不需鍵）。",
		whenToUse: "使用者說「附加欄位 / 每列都加上 / 交叉連接 / append / cross join」時。",
		inputs: 2,
		nodeType: "alteryxNode",
		icon: "Columns3",
		color: "text-violet-600",
		defaults: {},
		fields: [],
	},

	FIND_REPLACE: {
		type: "FIND_REPLACE",
		label: "Find Replace",
		category: "Join",
		description: "用查找表把某欄的值替換掉，只帶回一個值欄位（不像 Join 帶回全部欄位）。",
		whenToUse: "使用者說「查找替換 / 對照表換值 / 代碼換名稱 / lookup / mapping」時。",
		inputs: 2,
		nodeType: "alteryxNode",
		icon: "Replace",
		color: "text-pink-600",
		defaults: {
			findField: "code",
			lookupField: "code",
			replaceField: "label",
			outputColumn: "",
			unmatched: "KEEP",
		},
		fields: [
			{ name: "findField", kind: "field", label: "來源鍵欄位", required: true },
			{ name: "lookupField", kind: "field", label: "查找表鍵欄位", required: true },
			{
				name: "replaceField",
				kind: "field",
				label: "取回的值欄位",
				required: true,
				hint: "型別必須與 findField 相容（見下方說明）",
			},
			{
				name: "outputColumn",
				kind: "text",
				label: "輸出欄位名",
				hint: "留空 = 就地覆蓋 findField",
			},
			{
				name: "unmatched",
				kind: "enum",
				label: "未命中時",
				values: ["KEEP", "NULL"],
				default: "KEEP",
				hint: "KEEP = 保留原值（COALESCE）；NULL = 設為空值",
			},
		],
	},

	// -------------------------------------------------------------------- BI
	VIZ_CHART: {
		type: "VIZ_CHART",
		label: "Chart",
		category: "BI",
		description: "把上游結果畫成圖表（不產生輸出表）。",
		whenToUse: "使用者說「畫圖 / 圖表 / 視覺化 / chart / 趨勢圖」時，放在 pipeline 末端。",
		inputs: 1,
		nodeType: "vizChartNode",
		icon: "PieChart",
		color: "text-violet-500",
		defaults: { chartType: "BAR", xAxis: "", yAxis: "" },
		fields: [
			{
				name: "chartType",
				kind: "enum",
				label: "圖表類型",
				values: ["BAR", "LINE", "PIE", "KPI"],
				default: "BAR",
			},
			{ name: "xAxis", kind: "field", label: "X 軸" },
			{ name: "yAxis", kind: "field", label: "Y 軸" },
		],
	},
};

/** 所有節點類型（順序與 CATEGORY_ORDER 一致，方便穩定輸出） */
export const NODE_TYPES: readonly AlteryxNodeType[] = (
	Object.keys(NODE_CATALOG) as AlteryxNodeType[]
).sort((a, b) => {
	const ca = CATEGORY_ORDER.indexOf(NODE_CATALOG[a].category);
	const cb = CATEGORY_ORDER.indexOf(NODE_CATALOG[b].category);
	return ca === cb ? a.localeCompare(b) : ca - cb;
});

/** 依分類分組（Palette 直接吃這個） */
export function catalogByCategory(): { category: NodeCategory; specs: NodeSpec[] }[] {
	return CATEGORY_ORDER.map((category) => ({
		category,
		specs: NODE_TYPES.filter((t) => NODE_CATALOG[t].category === category).map(
			(t) => NODE_CATALOG[t],
		),
	})).filter((g) => g.specs.length > 0);
}

/**
 * 給 agent 看的 config schema 文字。
 *
 * 刻意由 fields 推導而不是手寫：手寫的那份就是漂移的來源。
 * 必填欄位以 `[必填: ...]` 標在後面，避免在 key 上動手腳（`"field*"` 會讓
 * LLM 真的產生一個叫 `field*` 的鍵）。
 */
export function configSchemaText(spec: NodeSpec): string {
	if (spec.fields.length === 0) return "{}";
	const parts = spec.fields.map((f) => `"${f.name}": ${jsonShape(f)}`);
	const required = spec.fields.filter((f) => f.required).map((f) => f.name);
	const tail = required.length > 0 ? `   [必填: ${required.join(", ")}]` : "";
	return `{${parts.join(", ")}}${tail}`;
}

function jsonShape(f: ConfigFieldSpec): string {
	switch (f.kind) {
		case "number":
			return typeof f.default === "number" ? String(f.default) : "<number>";
		case "boolean":
			return "true | false";
		case "field":
			return '"<欄位名>"';
		case "fieldList":
			return '["<欄位名>", ...]';
		case "textList":
			return '["<名稱>", ...]';
		case "enum":
			return (f.values || []).map((v) => `"${v}"`).join(" | ");
		case "aggList":
			return '[{"func": "SUM" | "AVG" | "COUNT" | "COUNT_DISTINCT" | "MIN" | "MAX" | "STDDEV" | "MEDIAN", "target": "<欄位名 或 *>"}]';
		case "pairList":
			return '[{"from": "<舊欄位名>", "to": "<新欄位名>"}]';
		default:
			return '"<字串>"';
	}
}

/** MUTATE prompt 裡的「Allowed node types」整段（由目錄生成） */
export function promptNodeSection(): string {
	return catalogByCategory()
		.flatMap((g) => g.specs)
		.map((s) => {
			const use = s.whenToUse ? ` 用途：${s.whenToUse}` : "";
			return `- ${s.type}: ${configSchemaText(s)}  — ${s.description}${use}`;
		})
		.join("\n");
}

/**
 * _describe_canvas 應該把哪些 config 鍵攤給 agent 看。
 * 排除 tableName（平台自己指定）與純布林 / 數字（對「這是什麼資料」沒幫助）。
 */
export function canvasHintKeys(): string[] {
	const keys = new Set<string>();
	for (const t of NODE_TYPES) {
		for (const f of NODE_CATALOG[t].fields) {
			if (f.name === "tableName") continue;
			if (f.kind === "boolean" || f.kind === "number") continue;
			keys.add(f.name);
		}
	}
	return [...keys];
}

/**
 * 給後端 hermes.py 的序列化快照。
 * promptSection 由 TS 這邊先render 好 —— 後端只負責 splice 字串，
 * 不要在那邊重新實作一次渲染邏輯（那又是第二份真相）。
 */
export function catalogSnapshot() {
	return {
		version: 1,
		generatedFrom: "apps/web/src/engine/nodeCatalog.ts",
		types: [...NODE_TYPES],
		hintKeys: canvasHintKeys(),
		promptSection: promptNodeSection(),
		nodes: NODE_TYPES.map((t) => {
			const s = NODE_CATALOG[t];
			return {
				type: s.type,
				label: s.label,
				category: s.category,
				description: s.description,
				whenToUse: s.whenToUse,
				inputs: s.inputs,
				fields: s.fields.map((f) => ({
					name: f.name,
					kind: f.kind,
					label: f.label,
					required: Boolean(f.required),
					values: f.values ? [...f.values] : undefined,
					default: f.default,
					hint: f.hint,
				})),
			};
		}),
	};
}

/** 依類型取初始 config（Palette 拖放用），回傳深拷貝避免共用參照 */
export function defaultConfigFor(type: AlteryxNodeType): Record<string, unknown> {
	return JSON.parse(JSON.stringify(NODE_CATALOG[type]?.defaults ?? {}));
}

/** 深拷貝；純量原樣回傳（`JSON.parse` 不接受 undefined） */
function cloneDefault<T>(value: T): T {
	return value !== null && typeof value === "object"
		? (JSON.parse(JSON.stringify(value)) as T)
		: value;
}

/**
 * 依目錄校正一份 config：丟掉未知鍵、補上缺漏的預設值。
 *
 * 為什麼需要：Hermes 產生的 config 是 LLM 自由發揮的結果，可能夾帶幻覺欄位
 * （例如把 SUMMARIZE 的 groupBy 寫成 groupby）。舊版直接把 config 原封不動
 * 傳給前端，於是錯的鍵一路活到編譯器，只在編譯時靜默退回預設值。
 * 這裡在進入畫布前就先清乾淨，並補上該節點的預設值。
 *
 * 目錄有兩層預設，這裡**兩層都要吃**：
 *   1. `spec.defaults` —— 整份節點預設（也是 Palette 拖放用的那一份）
 *   2. 每個欄位自己的 `default`
 * 只吃第 2 層曾經造成一個真實的不一致：`spec.defaults` 裡有 `val: "1000"`，
 * 但 FILTER 的 `val` 欄位沒有宣告 `default`，於是 Hermes 產生的 FILTER 節點
 * config 裡沒有 `val` —— 編譯器自己有 `?? "1000"` 兜底所以 SQL 正確，
 * 但設定表單直接讀 `config.val`，畫面上顯示**空白的「值」欄位**，
 * 而 SQL 預覽卻寫著 `amount > 1000`。兩者矛盾，使用者無從判斷哪個才對。
 */
export function normalizeConfig(
	type: AlteryxNodeType,
	config: unknown,
): Record<string, unknown> {
	const spec = NODE_CATALOG[type];
	if (!spec) return {};
	const raw = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
	const known = new Map(spec.fields.map((f) => [f.name, f]));

	const out: Record<string, unknown> = {};
	// 第 1 層：整份節點預設（只取有宣告的欄位，目錄不該有孤兒鍵）
	for (const [k, v] of Object.entries(spec.defaults ?? {})) {
		if (known.has(k)) out[k] = cloneDefault(v);
	}
	// 第 2 層：逐欄位預設（較精確，覆蓋第 1 層）
	for (const f of spec.fields) {
		if (f.default !== undefined) out[f.name] = cloneDefault(f.default);
	}
	// 第 3 層：LLM 實際給的值（最高優先）
	for (const [k, v] of Object.entries(raw)) {
		if (!known.has(k)) continue;
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}

/** 目錄自查：`spec.defaults` 不可以有未宣告的孤兒鍵（否則第 1 層會靜默漏掉） */
export function orphanDefaultKeys(): Array<{ type: string; keys: string[] }> {
	const out: Array<{ type: string; keys: string[] }> = [];
	for (const [type, spec] of Object.entries(NODE_CATALOG)) {
		const declared = new Set(spec.fields.map((f) => f.name));
		const orphans = Object.keys(spec.defaults ?? {}).filter((k) => !declared.has(k));
		if (orphans.length) out.push({ type, keys: orphans });
	}
	return out;
}
