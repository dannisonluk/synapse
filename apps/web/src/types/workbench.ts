export type ExecutionViewMode = "SILENT" | "CANVAS_FOCUS";

export type AlteryxNodeType =
	| "INPUT_FILE"
	| "INPUT_DUCKDB"
	| "FILTER"
	| "SELECT"
	| "TRANSFORM_FORMULA"
	| "AGGREGATE"
	| "JOIN"
	| "VIZ_CHART"
	| "AI_CUSTOM";

export interface ASTNodeConfig {
	tableName?: string;
	condition?: string;
	columns?: string[];
	groupByKeys?: string[];
	aggregations?: Array<{
		field: string;
		func: "SUM" | "AVG" | "COUNT" | "MIN" | "MAX";
	}>;
	joinType?: "INNER" | "LEFT" | "RIGHT" | "FULL";
	chartType?: "BAR" | "LINE" | "PIE" | "SCATTER";
	sqlCustom?: string;
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
