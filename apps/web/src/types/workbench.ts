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
	| "FUZZY_JOIN"
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

// 節點 config 的形狀宣告在 types/nodeConfig.ts —— 那是唯一一份。
// 這裡只保留別名，因為歷史上這個名字（ASTNodeConfig）被 workflow JSON 那一側用過。
//
// 為什麼不直接把名字統一成 NodeConfig：
//   三個名字（ASTNodeConfig / NodeConfig / AlteryxNodeConfig）過去各有一份手抄的
//   介面，對外都 export 過。留別名可以讓「改名」與「去重複」兩件事分開做 ——
//   這一輪只做去重複，不動任何呼叫端。
export type { NodeConfig } from "./nodeConfig";
export type ASTNodeConfig = import("./nodeConfig").NodeConfig;


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
